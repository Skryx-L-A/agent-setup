#!/usr/bin/env python3
"""stop_aufgabe.py — die Logik hinter dem Stop-Hook stop-aufgabe-zugende.sh.

Der Hook läuft, wenn ein Hauptagent der Werkbank-Aufgaben seinen Zug beendet
(docs/AGENTS-PLAN.md, Abschnitt 3 „Die Sicherung", Abschnitt 8 „Hooks sind
Wecker, nie Wahrheit"). Er tut ALLES nur, wenn die Sitzung mit
WB_AUFGABE_ID, WB_AUFGABE_PROJEKT und WB_AUFGABE_BASE gestartet wurde; jede
andere Sitzung — auch jede interaktive — verlässt ihn sofort und lautlos.

Was er tut, in dieser Reihenfolge:

  1. Aus den letzten Einträgen des Transkripts erkennen, ob der Zug an einem
     Rate-Limit geendet hat (Kennzeichen: HTTP 429, „rate limit", „usage
     limit", „resets at"). Die Reset-Zeit liest er bewusst NICHT aus dem
     Text — die holt der Träger selbst aus wb-budget --json (Plan: nie aus
     dem Meldungstext).
  2. Die Wecker-Datei <base>/.claude/workbench/vorrat/.wecker/<id> anlegen
     (eine Zeile: ISO-Zeit und Grund `limit` oder `zugende`). Der Träger
     sieht sie je Takt, löscht sie und entscheidet, ob eine Sicherung fällig
     ist — der Hook entscheidet nichts. Der Wecker zuerst, weil er an nichts
     hängt, was hängen könnte.
  3. Stand und Pfade der Aufgabe über `wb-aufgabe zeigen <id> --json
     --base <base>` lesen. `pfade` sind die Pfade, die der Hauptagent als
     seine führt; das Feld wird vom Träger-Worker ergänzt, bis dahin darf es
     fehlen und gilt als leer.
  4. In den Verlauf schreiben (nur über wb-aufgabe verlauf … --von
     hauptagent): `zugende` mit der session_id, bei Limit zusätzlich `limit`
     mit dem wörtlichen Fehlertext (gekürzt auf 300 Zeichen), und wenn
     nichts committet werden konnte, `offen-nicht-committet` mit der Zahl
     der geänderten Dateien (git status --porcelain).
  5. Commit beim Stop, aber nur, wenn der Stand der Aufgabe `pausiert*`,
      `wartet auf …` (der Stand, der den Menschen braucht) oder `aufgegeben*` ist (auch „aufgegeben
      (Modell)") ODER die Umgebungsvariable
     WB_AUFGABE_SITZUNGSENDE=1 gesetzt ist, und nur die Pfade aus `pfade`,
     nie `git add -A`. Im Repo unter WB_AUFGABE_PROJEKT — oder im Worktree,
     wenn cwd ein Worktree dieses Repos ist. Kein Push, nie.

Grenzen: Er blockiert den Stop nie (immer Exit 0, nie eine decision-Ausgabe)
und läuft nie länger als die Frist — eine eigene Frist per signal.alarm,
dazu eine alarm-Frist im aufrufenden Shell-Skript (`timeout` fehlt auf
macOS, `perl -e alarm` nicht). Jeder Fehler — fehlendes wb-aufgabe, kaputtes
JSON, gescheitertes git — wird verschluckt und höchstens in den Verlauf
geschrieben, nie zum Abbruch.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile

FRIST_SEKUNDEN = 8          # eigene Frist; die Shell legt mit 9 Sekunden nach
UNTERFRIST_SEKUNDEN = 7     # Frist je Unterprozess (wb-aufgabe, git)
TEXTKUERZUNG = 300          # wörtlicher Fehlertext, gekürzt
SCHWANZ_BYTES = 262144      # so viel vom Transkript-Ende wird gelesen

# Kennzeichen eines Rate-Limits in einem API-Fehlertext. „resets at" wie im
# Auftrag, daneben tolerant für die reale Meldung „resets 6:50pm" — geprüft
# wird innerhalb eines API-Fehlereintrags, das 429 allein dort kein Risiko.
LIMIT_MUSTER = re.compile(
    r"(?i)(?<!\d)429(?!\d)|rate[\s_-]?limit|usage[\s_-]?limit|resets?\s+(?:at\s+)?\d")

KENNUNG_MUSTER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


# ------------------------------------------------------------- Fristen --
def alarm_setzen():
    """Eigene Frist: nach FRIST_SEKUNDEN sofort beenden, exit 0, still.

    Der Shell-Wrapper legt mit perl -e alarm 9 nach — der Alarm überlebt das
    exec, weil perl sich durch diesen Prozess ersetzt und setitimer
    prozessweit gilt. `timeout` fehlt auf macOS, darum dieser Weg."""
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))
        signal.alarm(FRIST_SEKUNDEN)
    except (ValueError, OSError, AttributeError):
        pass  # kein Alarm möglich — die Unterprozess-Fristen bleiben


# ------------------------------------------------------------- stdin ----
def eingabe_lesen():
    try:
        roh = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    if not roh.strip():
        return {}
    try:
        daten = json.loads(roh)
    except ValueError:
        return {}
    return daten if isinstance(daten, dict) else {}


def kennung_ok(id_):
    """Die Kennung wird in Dateipfade eingesetzt (Wecker-Datei). Nur ein
    schlichter Slug taugt dafür — ein Pfadtrenner oder „.." darin wäre ein
    Weg aus dem Wecker-Verzeichnis heraus und macht den Aufruf wertlos."""
    return bool(id_) and bool(KENNUNG_MUSTER.fullmatch(id_)) and ".." not in id_


# ------------------------------------------------------- wb-aufgabe -----
def wb_aufgabe_rufen(args):
    wb = shutil.which("wb-aufgabe")
    if not wb:
        return None
    return subprozess_frist(wb, args)


def aufgabe_laden(id_, base):
    """(stand, pfade) aus `wb-aufgabe zeigen <id> --json --base <base>`;
    pfade fehlen darf (Träger ergänzt sie später) und gilt dann als leer.
    Bei jedem Fehlschlag (kein wb-aufgabe, keine Vorratsdatei, kaputtes
    JSON) kommt None — der Hook arbeitet dann nur als Wecker weiter."""
    r = wb_aufgabe_rufen(["zeigen", id_, "--json", "--base", base])
    if r is None or r.returncode != 0:
        return None
    try:
        daten = json.loads(r.stdout)
    except ValueError:
        return None
    verlauf = daten.get("verlauf") if isinstance(daten, dict) else None
    if not isinstance(verlauf, dict):
        return None
    pfade_roh = verlauf.get("pfade")
    pfade = [p for p in pfade_roh if isinstance(p, str) and p.strip()] \
        if isinstance(pfade_roh, list) else []
    return verlauf.get("stand") or "", pfade


def verlauf_schreiben(id_, art, text, base):
    r = wb_aufgabe_rufen(["verlauf", id_, art, text,
                          "--von", "hauptagent", "--base", base])
    return r is not None and r.returncode == 0


# -------------------------------------------------------- Transkript ----
def schwanz_zeilen(pfad):
    try:
        groesse = os.path.getsize(pfad)
        with open(pfad, "rb") as f:
            start = max(0, groesse - SCHWANZ_BYTES)
            f.seek(start)
            daten = f.read()
    except OSError:
        return []
    zeilen = daten.splitlines()
    if start > 0 and len(zeilen) > 1:
        zeilen = zeilen[1:]  # erste Zeile kann angeschnitten sein
    return [z for z in zeilen if z.strip()]


def text_aus_eintrag(eintrag):
    teile = []
    inhalt = None
    if isinstance(eintrag.get("message"), dict):
        inhalt = eintrag["message"].get("content")
    if inhalt is None:
        inhalt = eintrag.get("content")
    if isinstance(inhalt, str):
        teile.append(inhalt)
    elif isinstance(inhalt, list):
        for teil in inhalt:
            if isinstance(teil, dict) and isinstance(teil.get("text"), str):
                teile.append(teil["text"])
    if not teile:
        fehler = eintrag.get("error")
        if isinstance(fehler, dict) and isinstance(fehler.get("message"), str):
            teile.append(fehler["message"])
    return "\n".join(teile)


def transkript_limit(pfad):
    """(ist_limit, fehlertext) — TRUE nur, wenn der LETZTE Assistenten-
    Eintrag des Transkripts ein API-Fehler mit Rate-Limit-Kennzeichen ist.
    Ein Limit, das der Agent später überstanden hat (danach folgt ein
    normaler Zug), ist am Zugende kein Limit. Die Reset-Zeit wird nie aus
    dem Text gelesen — die holt der Träger aus wb-budget --json."""
    for zeile in reversed(schwanz_zeilen(pfad)):
        try:
            eintrag = json.loads(zeile)
        except ValueError:
            continue
        if not isinstance(eintrag, dict) or eintrag.get("type") != "assistant":
            continue
        text = text_aus_eintrag(eintrag)
        ist_fehler = bool(eintrag.get("isApiErrorMessage")) \
            or text.strip().startswith("API Error")
        if ist_fehler and LIMIT_MUSTER.search(text or ""):
            return True, (text or "").strip()[:TEXTKUERZUNG]
        return False, ""  # letzter Assistenten-Eintrag entscheidet
    return False, ""


# -------------------------------------------------------------- Wecker --
def jetzt_iso():
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def wecker_schreiben(base, id_, grund):
    verzeichnis = os.path.join(base, ".claude", "workbench", "vorrat", ".wecker")
    # Vor dem try gesetzt: scheitert schon os.makedirs, greift der except-
    # Zweig unten trotzdem auf einen definierten Namen zu.
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    try:
        os.makedirs(verzeichnis, exist_ok=True)
        # O_NOFOLLOW (Reviewer-Befund R2): Ist .wecker/<id> ein Symlink, wird
        # er NICHT verfolgt — nichts geschrieben, Meldung nach stderr statt
        # die Wecker-Zeile in eine fremde Datei außerhalb des Vorrats zu
        # verfrachten. O_TRUNC überschreibt eine echte Wecker-Datei (der
        # Träger löscht sie je Takt; ein Rest von gestern zählt nicht).
        schalter = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if nofollow:
            schalter |= nofollow
        fd = os.open(os.path.join(verzeichnis, id_), schalter, 0o644)
        try:
            os.write(fd, ("%s %s\n" % (jetzt_iso(), grund)).encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except OSError as fehler:
        if nofollow and fehler.errno == os.ELOOP:
            sys.stderr.write("stop-aufgabe: .wecker/%s ist ein Symlink — "
                             "nichts geschrieben.\n" % id_)
        return False


# ------------------------------------------------------- Unterprozesse --
def subprozess_frist(ziel, args):
    """subprocess.run-Ersatz mit Prozessgruppen-Frist (Reviewer-Befund H1).

    Das Kind laeuft in eigener Session (Gruppenfuehrer), damit der
    Frist-Abruch mit os.killpg die ganze Gruppe beendet — subprocess.run
    wuerde beim Timeout nur das direkte Kind killen, dessen Kinder (etwa
    ein hängender Helfer) blieben als Waisen uebrig. Manuell gestartet mit
    Popen, weil communicate() beim Timeout das Kind weiterlaufen laesst und
    damit fuer unterprozess_abbrechen erreichbar bleibt; subprocess.run
    killt es vorher und gibt nur die Exception zurueck."""
    try:
        prozess = subprocess.Popen([ziel, *args],
                                   stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,
                                   start_new_session=True)
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        ausgabe, fehler = prozess.communicate(timeout=UNTERFRIST_SEKUNDEN)
    except subprocess.TimeoutExpired:
        unterprozess_abbrechen(prozess)
        return None
    return subprocess.CompletedProcess(
        [ziel, *args], prozess.returncode,
        ausgabe.decode("utf-8", "replace"),
        fehler.decode("utf-8", "replace"))


def prozesengruppe(prozess):
    """PGID des Unterprozesses oder 0, wenn sie nicht ermittelbar ist —
    0 läge in der eigenen Gruppe und wird deshalb nie geschickt."""
    try:
        pgid = os.getpgid(prozess.pid)
        return pgid if pgid > 1 else 0
    except (OSError, subprocess.SubprocessError, AttributeError):
        return 0


def unterprozess_abbrechen(prozess):
    """Beendet den Unterprozess SAMT seiner Prozessgruppe (Reviewer-Befund
    H1): ein subprocess-Timeout killt nur das direkte Kind, dessen Kinder
    — etwa ein hängender git-Helfer oder ein von einem Test-Shim
    nachgezogener Schlafprozess — würden sonst als Waisen weiterleben.
    Jeder Start läuft mit start_new_session=True, das Kind ist also
    Gruppenführer; killpg trifft die ganze Gruppe. Erst SIGTERM, nach einer
    Sekunde SIGKILL, falls jemand den TERM ignoriert."""
    pgid = prozesengruppe(prozess)
    if pgid > 1:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except OSError:
            pass
    try:
        prozess.wait(timeout=1)
        return
    except (subprocess.TimeoutExpired, OSError):
        pass
    if pgid > 1:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            try:
                prozess.kill()
            except (OSError, subprocess.SubprocessError):
                pass
    else:
        try:
            prozess.kill()
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        prozess.wait(timeout=2)
    except (subprocess.TimeoutExpired, OSError):
        pass


# ----------------------------------------------------------------- git --
def git_ausfuehren(verzeichnis, args):
    return subprozess_frist("git", ["-C", verzeichnis, *args])


def repo_bestimmen(cwd, projekt):
    """WB_AUFGABE_PROJEKT — außer cwd liegt in einem Worktree desselben
    Repos (erkennbar am gemeinsamen .git-Verzeichnis); dann der Worktree."""
    if cwd and os.path.isdir(cwd) and projekt:
        r = git_ausfuehren(cwd, ["rev-parse", "--show-toplevel"])
        if r is not None and r.returncode == 0 and r.stdout.strip():
            toplevel = r.stdout.strip()
            c = git_ausfuehren(cwd, ["rev-parse", "--path-format=absolute",
                                     "--git-common-dir"])
            if c is not None and c.returncode == 0 and c.stdout.strip():
                gemeinsames_git = os.path.realpath(c.stdout.strip())
                projekt_git = os.path.realpath(os.path.join(projekt, ".git"))
                if gemeinsames_git == projekt_git:
                    return toplevel
    return projekt


def geaenderte_dateien(repo):
    """Liste der geänderten Dateien (git status --porcelain -z) oder None,
    wenn git nicht geht. Rename-Einträge tragen beide Pfade bei."""
    r = git_ausfuehren(repo, ["status", "--porcelain", "-z"])
    if r is None or r.returncode != 0:
        return None
    felder = r.stdout.split("\0")
    dateien = []
    i = 0
    while i < len(felder):
        feld = felder[i]
        i += 1
        if len(feld) < 4:
            continue
        status, pfad = feld[:2], feld[3:]
        dateien.append(pfad)
        if status[0] in ("R", "C") and i < len(felder):
            dateien.append(felder[i])
            i += 1
    return dateien


def pfade_normalisieren(pfade, repo):
    """Prüft die Pfadeinträge der Aufgabe und verwirft, was nicht taugt.

    Tauglich ist ein RELATIVER Pfad innerhalb des Repos (Datei oder
    Verzeichnis); Verzeichnisse sind erlaubt, die Wurzel nicht. Ein Eintrag
    `.`, `..`, `''` oder mit einem `..`-Segment im Pfad wird komplett
    verworfen, ebenso ein absoluter Pfad oder einer, der außerhalb des
    Repos läge. Hintergrund (Reviewer-Befund R1): Stand und Pfade stammen
    beide aus derselben, vom Träger geschriebenen Verlaufsdatei; wer sie
    manipuliert, darf damit den Checkpoint-Commit nicht auf fremde Dateien
    erweitern können — `.` als „alles" wäre genau das. Absolute Pfade vom
    Hauptagenten sind sowieso Repo-root-relativ zu führen; ein absoluter
    Pfad innerhalb des Repos wird akzeptiert, einer außerhalb verworfen.
    """
    aus = []
    for p in pfade:
        if not isinstance(p, str):
            continue
        p = p.strip()
        if not p or p == "." or p == "..":
            continue
        if os.path.isabs(p):
            # Nur Pfade innerhalb des Repos taugen; relpath entscheidet.
            if not repo:
                continue
            p = os.path.relpath(p, repo)
        teile = [t for t in p.replace(os.sep, "/").split("/") if t not in ("", ".")]
        if not teile or any(teil == ".." for teil in teile):
            continue
        aus.append("/".join(teile))
    return sorted(set(aus))


def pfad_trifft(pfad, muster_liste):
    pfad = pfad.replace(os.sep, "/")
    for m in muster_liste:
        if pfad == m or pfad.startswith(m + "/"):
            return True
    return False


def commit_versuchen(id_, stand, pfade_roh, repo):
    """Committet nur die Pfade aus pfade (nie git add -A). Rückgabe:
    (gecommittet, kurzer_hash_oder_None, grund_fuer_offen_eintrag)"""
    if not repo or not os.path.isdir(repo):
        return False, None, "Projektverzeichnis fehlt: %s" % repo

    dateien = geaenderte_dateien(repo)
    if dateien is None:
        return False, None, "git status fehlgeschlagen in %s" % repo

    pfade = pfade_normalisieren(pfade_roh, repo)
    if not pfade:
        return False, None, ("%d geaenderte Dateien, pfade leer"
                             % len(dateien))
    kandidaten = sorted({d for d in dateien if pfad_trifft(d, pfade)})
    if not kandidaten:
        return False, None, ("%d geaenderte Dateien, keine aus pfade dabei"
                             % len(dateien))

    add = git_ausfuehren(repo, ["add", "--ignore-errors", "--", *kandidaten])
    if add is None:
        # Von git fehlt jede Spur (fehlendes git, hängender Aufruf abgebrochen):
        # der Prüfungsschritt unten kann dann nicht mehr unterscheiden, ob
        # nichts gestellt wurde oder alles schon so war — ohne add-Ergebnis
        # wird nicht behauptet, es gäbe nichts zu committen.
        return False, None, "git add fehlgeschlagen: (keine Ausgabe)"
    if add.returncode != 0:
        erste_zeile = (add.stderr.strip().splitlines() or ["unbekannt"])[0]
        return False, None, "git add fehlgeschlagen: %s" % erste_zeile[:200]
    pruef = git_ausfuehren(repo, ["diff", "--cached", "--quiet"])
    if pruef is not None and pruef.returncode == 0:
        return False, None, ("%d geaenderte Dateien, nichts zu committen"
                             % len(dateien))

    nachricht = "Task %s: checkpoint at turn end (%s)" % (id_, stand or "unbekannt")
    fd, nachricht_pfad = tempfile.mkstemp(prefix="wb-stop-aufgabe-msg-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(nachricht + "\n")
        # --only mit Pfaden: NUR diese Pfade landen im Commit, schon vorher
        # gestellte fremde Änderungen bleiben gestellt und uncommittet.
        c = git_ausfuehren(repo, ["commit", "--only", "-F", nachricht_pfad,
                                  "--", *kandidaten])
    finally:
        try:
            os.unlink(nachricht_pfad)
        except OSError:
            pass
    if c is None or c.returncode != 0:
        grund = (c.stderr.strip()[:200] if c is not None
                 else "git commit fehlgeschlagen")
        return False, None, "git commit fehlgeschlagen: %s" % grund
    h = git_ausfuehren(repo, ["rev-parse", "--short", "HEAD"])
    hash_ = h.stdout.strip() if h is not None and h.returncode == 0 else ""
    return True, hash_, ""


# ------------------------------------------------------------- Logik ----
def main():
    alarm_setzen()
    eingabe = eingabe_lesen()

    id_ = (os.environ.get("WB_AUFGABE_ID") or "").strip()
    if not id_ or not kennung_ok(id_):
        return 0  # interaktive Sitzungen und fremde Kennungen: nichts tun
    base = os.environ.get("WB_AUFGABE_BASE") or os.path.expanduser("~")
    projekt = os.environ.get("WB_AUFGABE_PROJEKT") or ""
    session_id = str(eingabe.get("session_id") or "")
    transcript = str(eingabe.get("transcript_path") or "")
    cwd = str(eingabe.get("cwd") or "")
    # stop_hook_active bleibt unbeachtet: dieser Hook blockiert nie.

    wb_da = shutil.which("wb-aufgabe") is not None
    if not wb_da:
        sys.stderr.write("stop-aufgabe: wb-aufgabe nicht im PATH — "
                         "nur die Wecker-Datei wird geschrieben.\n")

    ist_limit, fehlertext = (False, "")
    if transcript:
        ist_limit, fehlertext = transkript_limit(transcript)

    # 1. Der Wecker zuerst: das ist das eigentliche Signal an den Träger,
    #    und es hängt an nichts, was hängen könnte — weder an wb-aufgabe
    #    (Best-Effort-Buchhaltung) noch an git (Wecker, nie Wahrheit).
    wecker_schreiben(base, id_, "limit" if ist_limit else "zugende")

    # 2. Verlauf: zugende (die Zeit stempelt wb-aufgabe selbst), bei Limit
    #    zusätzlich `limit` mit dem wörtlichen Fehlertext.
    stand, pfade = "", []
    geladen = aufgabe_laden(id_, base) if wb_da else None
    if geladen is not None:
        stand, pfade = geladen
    verlauf_schreiben(id_, "zugende",
                      "Zug beendet (session_id %s)." % (session_id or "unbekannt"),
                      base)
    if ist_limit:
        verlauf_schreiben(id_, "limit", fehlertext[:TEXTKUERZUNG], base)

    # 3. Commit beim Stop: nur bei den genannten Ständen oder Sitzungsende.
    #    aufgegeben* umfasst auch 'aufgegeben (Modell)' (Reviewer-Befund H5;
    #    docs/AGENTS-PLAN.md führt es als eigenen Stand).
    sitzungsende = os.environ.get("WB_AUFGABE_SITZUNGSENDE") == "1"
    commit_erlaubt = (
        stand.startswith("pausiert")
        # Der Stand, der den Menschen braucht, heisst in wb-aufgabe "wartet auf
        # <Name>"; hier nur der Praefix, damit hooks/ frei von Personennamen
        # bleibt (Namensscan in tests/test-hooks.sh, Weitergabefaehigkeit).
        or stand.startswith("wartet auf ")
        or stand.startswith("aufgegeben")
        or sitzungsende)
    if projekt and geladen is not None:
        repo = repo_bestimmen(cwd, projekt)
        if repo and commit_erlaubt:
            ok, hash_, grund = commit_versuchen(id_, stand, pfade, repo)
            if not ok:
                verlauf_schreiben(id_, "offen-nicht-committet", grund, base)
        elif not commit_erlaubt:
            # Stand erlaubt keinen Commit, aber es liegen Änderungen vor:
            # „alles andere meldet er als offen, nicht committet"
            # (docs/AGENTS-PLAN.md, Abschnitt 3).
            geaenderte = geaenderte_dateien(repo)
            if geaenderte:
                verlauf_schreiben(id_, "offen-nicht-committet",
                                  "%d geaenderte Dateien, kein Commit "
                                  "(Stand '%s', kein Sitzungsende)"
                                  % (len(geaenderte), stand or "unbekannt"),
                                  base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
