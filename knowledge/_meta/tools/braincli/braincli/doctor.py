"""Compact, deterministic vault ageing signals for humans and SessionStart."""
from __future__ import annotations
import sys
import os

import datetime as dt
import json
import re
import subprocess
from pathlib import Path

from gardener import config, realitaet
from gardener.contradict import ContradictionStore
from gardener.frontmatter import parse as parse_frontmatter
from gardener.vault import load_notes

from . import gardener_wrap, kanon, stats

EXAMPLES = 5
DATE_RE = re.compile(r"(?:stand\s*:\s*|Stand:\s*)(\d{4})-(\d{2})")
ISO_DATE_RE = re.compile(r"(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)")


def _examples(items: list[str]) -> list[str]:
    return sorted(dict.fromkeys(items))[:EXAMPLES]


def _age_days(when: str | None, now: dt.datetime) -> float | None:
    if not when:
        return None
    try:
        stamp = dt.datetime.fromisoformat(str(when).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=dt.timezone.utc)
        current = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
        return round(max(0.0, (current - stamp).total_seconds() / 86400), 2)
    except (TypeError, ValueError):
        return None


# Suchwache (eval/retrieval_eval/wache.py, taeglich 07:00 auf peer): ihr letzter Stand liegt
# maschinenlokal in state/messwache.json. Fehlt die Datei, laeuft hier keine Wache (Mac):
# kein Befund. Aelter als 36 h heisst: der Timer ist still - genau so stand die Wache vom
# 22.08. bis 28.09., ohne dass es jemand sah.
MESSWACHE_ALT_STUNDEN = 36


def _messwache(vault: Path, now: dt.datetime) -> dict | None:
    pfad = Path(vault) / "_meta" / "tools" / "state" / "messwache.json"
    try:
        st = json.loads(pfad.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    alter = _age_days(st.get("stand"), now)
    still = alter is not None and alter * 24 > MESSWACHE_ALT_STUNDEN
    gruende = [str(g) for g in (st.get("gruende") or [])]
    if still:
        gruende.append(f"letzter Lauf vor {alter:.1f} Tagen")
    blind = st.get("blind_dev") if isinstance(st.get("blind_dev"), dict) else {}
    return {"ergebnis": st.get("ergebnis"), "stand": st.get("stand"), "age_days": alter,
            "ndcg10": blind.get("ndcg@10"), "hit5": blind.get("hit@5"),
            "important": bool(st.get("alarm")) or still, "examples": gruende[:EXAMPLES]}


# Standby-Kopie (b6-standby, 28.09.): der my-server-Standby ist im Normalbetrieb kalt; gesund
# heisst, dass `brain-standby-sync.timer` die Kopie alle 5 min erneuert. Das Alter steht in
# `/var/lib/brain-standby/status.json` (`kopie_stand_unix`) und wird hoechstens 1x je Stunde
# lesend per ssh geholt (Handelsrechner: keine Last). Fehlt ssh oder ist peer weg: still.
STANDBY_SSH = "my-server"
STANDBY_STATUS = "/var/lib/brain-standby/status.json"
STANDBY_INTERVALL_S = 3600
STANDBY_WICHTIG_MIN = 15
STANDBY_ZEITLIMIT_S = 10


def _standby_lesen() -> float | None:
    """`kopie_stand_unix` vom Standby oder None (ssh fehlt, Host weg, Datei unlesbar)."""
    host = os.environ.get("BRAIN_STANDBY_SSH", STANDBY_SSH)
    try:
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "cat", STANDBY_STATUS],
            capture_output=True, text=True, timeout=STANDBY_ZEITLIMIT_S)
        wert = json.loads(r.stdout).get("kopie_stand_unix") if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None
    return float(wert) if isinstance(wert, (int, float)) and not isinstance(wert, bool) else None


def _standby(vault: Path, now: dt.datetime, lesen=None) -> dict | None:
    """Kopiealter des Standbys als Info; wichtig erst ab > 15 min. Zwischenspeicher
    `state/standby-kopie.json` haelt Versuch und Messung (auch Fehlschlaege zaehlen als
    Versuch); das gemeldete Alter ist das zum Messzeitpunkt, nie hochgerechnet."""
    if os.environ.get("BRAIN_STANDBY_PRUEFUNG", "1") == "0":
        return None
    try:
        from .server import konfig_laden
        server = konfig_laden(vault)
    except (ValueError, KeyError, OSError):
        return None
    if len(server) < 2:
        return None
    pfad = Path(vault) / "_meta" / "tools" / "state" / "standby-kopie.json"
    try:
        alt = json.loads(pfad.read_text(encoding="utf-8"))
        alt = alt if isinstance(alt, dict) else {}
    except (OSError, ValueError):
        alt = {}
    jetzt = now.timestamp()
    versuch = alt.get("versuch")
    if not isinstance(versuch, (int, float)) or not 0 <= jetzt - versuch < STANDBY_INTERVALL_S:
        stand = (lesen or _standby_lesen)()
        alt = {"versuch": jetzt,
               "messung": jetzt if stand is not None else alt.get("messung"),
               "alter_min": round(max(0.0, jetzt - stand) / 60, 1) if stand is not None
               else alt.get("alter_min")}
        try:
            pfad.parent.mkdir(parents=True, exist_ok=True)
            tmp = pfad.with_suffix(".neu")
            tmp.write_text(json.dumps(alt) + "\n", encoding="utf-8")
            tmp.replace(pfad)
        except OSError:
            pass
    alter = alt.get("alter_min")
    if not isinstance(alter, (int, float)):
        return None
    name = server[1].name
    wichtig = alter > STANDBY_WICHTIG_MIN
    text = (f"Standby-Kopie {alter:.0f} min alt ({name}, brain-standby-sync.timer pruefen)" if wichtig
            else f"Standby {name} kalt (erwartet), Kopie {alter:.0f} min alt")
    return {"name": name, "alter_min": alter, "gemessen": dt.datetime.fromtimestamp(
        alt.get("messung") or jetzt, dt.timezone.utc).isoformat(timespec="seconds"),
        "important": wichtig, "examples": [text]}


# Forgejo-Sicherung (SSH-backup-extern, 14.10.): peer schreibt nach jedem Dump eine age-verschluesselte Kopie auf
# den my-server (`forgejo-backup-extern`) und testet monatlich die Wiederherstellung daraus
# (`forgejo-restore-test`). Beide schreiben eine Statusdatei; doctor meldet Rot oder ein zu altes letztes Gruen.
# Auf peer lokal gelesen, anderswo hoechstens 1x je Stunde per ssh peer. Keine Statusdatei erreichbar: still.
SICHERUNG_STATUS = {"extern": "/var/lib/forgejo-backup-extern/status.json",
                    "wiederherstellung": "/var/lib/forgejo-restore-test/status.json"}
SICHERUNG_FELD = {"extern": "letzter_erfolg", "wiederherstellung": "letzter_gruen"}
SICHERUNG_GRENZE_H = {"extern": 50, "wiederherstellung": 35 * 24}
SICHERUNG_UNIT = {"extern": "forgejo-backup-extern", "wiederherstellung": "forgejo-restore-test"}
SICHERUNG_NAME = {"extern": "Forgejo-Sicherung extern", "wiederherstellung": "Forgejo-Wiederherstellungstest"}
SICHERUNG_SSH = "peer"
SICHERUNG_INTERVALL_S = 3600


def _sicherung_lesen() -> dict | None:
    """Beide Statusdateien als {art: dict|None}; None, wenn keine erreichbar ist."""
    if any(Path(p).exists() for p in SICHERUNG_STATUS.values()):
        out = {}
        for art, p in SICHERUNG_STATUS.items():
            try:
                d = json.loads(Path(p).read_text(encoding="utf-8"))
                out[art] = d if isinstance(d, dict) else None
            except (OSError, ValueError):
                out[art] = None
        return out
    host = os.environ.get("BRAIN_SICHERUNG_SSH", SICHERUNG_SSH)
    skript = "; ".join(f"jq -c . {p} 2>/dev/null || echo null" for p in SICHERUNG_STATUS.values())
    try:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, skript],
                           capture_output=True, text=True, timeout=STANDBY_ZEITLIMIT_S)
        zeilen = r.stdout.splitlines() if r.returncode == 0 else []
        werte = [json.loads(z) for z in zeilen]
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if len(werte) != len(SICHERUNG_STATUS) or all(w is None for w in werte):
        return None
    return {art: (w if isinstance(w, dict) else None) for art, w in zip(SICHERUNG_STATUS, werte)}


def _sicherung(vault: Path, now: dt.datetime, lesen=None) -> dict | None:
    """Externe Kopie und monatlicher Wiederherstellungstest: wichtig bei ROT, fehlender Statusdatei oder
    letztem Erfolg aelter als 50 h (extern) bzw. 35 Tage (Test). Zwischenspeicher `state/sicherung.json`."""
    if os.environ.get("BRAIN_SICHERUNG_PRUEFUNG", "1") == "0":
        return None
    pfad = Path(vault) / "_meta" / "tools" / "state" / "sicherung.json"
    lokal = any(Path(p).exists() for p in SICHERUNG_STATUS.values()) and lesen is None
    try:
        alt = json.loads(pfad.read_text(encoding="utf-8"))
        alt = alt if isinstance(alt, dict) else {}
    except (OSError, ValueError):
        alt = {}
    jetzt = now.timestamp()
    versuch = alt.get("versuch")
    if lokal or not isinstance(versuch, (int, float)) or not 0 <= jetzt - versuch < SICHERUNG_INTERVALL_S:
        stand = (lesen or _sicherung_lesen)()
        alt = {"versuch": jetzt, "stand": stand if stand is not None else alt.get("stand")}
        if not lokal:
            try:
                pfad.parent.mkdir(parents=True, exist_ok=True)
                tmp = pfad.with_suffix(".neu")
                tmp.write_text(json.dumps(alt) + "\n", encoding="utf-8")
                tmp.replace(pfad)
            except OSError:
                pass
    stand = alt.get("stand")
    if not isinstance(stand, dict):
        return None
    result, texte = {}, []
    for art in SICHERUNG_STATUS:
        d = stand.get(art)
        name, unit = SICHERUNG_NAME[art], SICHERUNG_UNIT[art]
        if not isinstance(d, dict):
            result[art] = {"ergebnis": None, "important": True}
            texte.append(f"{name}: keine Statusdatei ({SICHERUNG_STATUS[art]})")
            continue
        erg, letzt = d.get("ergebnis"), d.get(SICHERUNG_FELD[art]) or None
        try:
            alter_h = (now - dt.datetime.fromisoformat(letzt)).total_seconds() / 3600 if letzt else None
        except (TypeError, ValueError):
            alter_h = None
        wichtig = erg == "ROT" or alter_h is None or alter_h > SICHERUNG_GRENZE_H[art]
        result[art] = {"ergebnis": erg, "zeit": d.get("zeit"), SICHERUNG_FELD[art]: letzt,
                       "alter_h": round(alter_h, 1) if alter_h is not None else None, "important": wichtig}
        if erg == "ROT":
            grund = d.get("grund") or "; ".join(d.get("rot_gruende") or [])
            texte.append(f"{name} ROT ({d.get('zeit')}): {grund} (journalctl -u {unit})")
        elif wichtig:
            seit = f"seit {alter_h / 24:.0f} Tagen" if alter_h is not None else "noch nie"
            texte.append(f"{name} {seit} nicht erfolgreich (systemctl status {unit})")
    wichtig = any(v["important"] for v in result.values())
    if not texte:
        texte.append(" / ".join(f"{SICHERUNG_NAME[a]} {v['ergebnis']} ({v['alter_h']:.0f} h)" for a, v in result.items()))
    return {**result, "important": wichtig, "examples": texte}


def _last_success(vault: Path) -> dict:
    data = gardener_wrap.status(vault).get("last_run") or {}
    if data.get("status") != "ok" or not data.get("finished"):
        return {"finished": None, "age_days": None, "examples": []}
    return {"finished": data.get("finished"), "age_days": _age_days(data.get("finished"), dt.datetime.now(dt.timezone.utc)),
            "examples": _examples([str(data.get("phase", "all"))])}


def _review_after(notes: list, now: dt.datetime) -> tuple[list[str], list[str]]:
    month = now.year * 12 + now.month
    due, examples = [], []
    for note in notes:
        value = str(note.fm.get("review-after", "")).strip()
        m = re.fullmatch(r"(\d{4})-(\d{1,2})", value)
        if m and int(m.group(1)) * 12 + int(m.group(2)) <= month:
            due.append(note.rel)
            examples.append(note.rel)
    return due, _examples(examples)


# Pruefstatus kanonischer Seiten (b6-verifikation): Anteil verifizierter, faellige, nie geprueft.
# Wichtig erst ab mehr als PRUEF_WICHTIG faelligen Seiten; "nie geprueft" allein ist im Aufbau
# der Normalzustand und loest keinen Alarm aus.
PRUEF_WICHTIG = 20


def _pruefstatus(notes: list, now: dt.datetime) -> dict:
    from gardener.lint import pruef_status
    st = pruef_status(notes, now.date())
    n = st["kanonisch"]
    return {"kanonisch": n, "verifiziert": st["verifiziert"],
            "anteil": round(st["verifiziert"] / n, 3) if n else None,
            "faellig": len(st["faellig"]), "nie": len(st["nie"]),
            "count": len(st["faellig"]),
            "examples": _examples(st["faellig"] or st["nie"]),
            "important": len(st["faellig"]) > PRUEF_WICHTIG}


# Veraltete kanonische Seiten (b18-doctor-kanon, Restanalyse eval/rest/BEFUNDE.md Abschnitt 2,
# M2): eigene, textbasierte Erkennung in braincli/kanon.py, hier nur die Doctor-Verpackung
# (Beispiele mit auslösendem Dokument, gedeckelt auf KANON_EXAMPLES).
KANON_EXAMPLES = 3


def _kanon(notes: list) -> dict:
    result = kanon.scan(notes)
    examples = [f"{v['pfad']} (Stand {v['stand']}, durch {v['dokument']} vom {v['datum']})"
                for v in result["veraltet"][:KANON_EXAMPLES]]
    return {**result, "count": len(result["veraltet"]), "examples": examples,
            "important": bool(result["veraltet"])}


def _old_stands(vault: Path, notes: list, now: dt.datetime) -> tuple[list[str], list[str]]:
    """Wissensnotizen mit einem Stand-Datum aelter als ihre Schwelle. Die Schwelle kommt je Notiz
    aus `gardener.audit.stale_months_for` (2026-09-28, b6-struktur OPEN 1b): KERN/STATUS und
    `type: system` 2 Monate (STALE_MARKER_MONTHS_FAST), der Rest STALE_MARKER_MONTHS (6).
    Bis dahin galten hier feste 3 Monate fuer alles."""
    from gardener.audit import stale_months_for
    month = now.year * 12 + now.month
    found = []
    for note in notes:
        if str(note.fm.get("class", "knowledge")).strip().lower() != "knowledge":
            continue
        if "sessions" in Path(note.rel).parts:
            continue
        cutoff = month - stale_months_for(note)
        matches = DATE_RE.findall(note.text)
        if any(int(y) * 12 + int(m) < cutoff for y, m in matches):
            found.append(note.rel)
    return found, _examples(found)


def _active_projects(vault: Path) -> set[str]:
    command = ["git", "-C", str(vault), "log", "--since=30 days ago", "--format=", "--name-only", "--", "20-projects/"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return set()
    # Aktiv heisst: echte Projektarbeit (Session-Notiz, STATUS, KERN, Fallen), nicht jede Datei.
    # Pflege-Commits an Ueberblicksnotizen (Realitaetspruefung, Linkreparatur) machten sonst ruhende
    # Projekte wie odysseus zu "aktiv ohne KERN" (gemessen 2026-09-23). Projekte mit KERN bleiben
    # immer in der Pruefung (Laenge, Alter).
    signal = {"STATUS.md", "KERN.md", "ENTSCHEIDUNGEN-UND-FALLEN.md", "FALLEN.yaml"}
    projects = set()
    for line in result.stdout.splitlines():
        parts = Path(line.strip()).parts
        if len(parts) >= 3 and parts[0] == "20-projects" and (parts[2] == "sessions" or parts[2] in signal):
            projects.add(parts[1])
    base = vault / "20-projects"
    if base.is_dir():
        projects |= {d.name for d in base.iterdir() if (d / "KERN.md").exists()}
    return projects


def _latest_decision_date(path: Path) -> dt.date | None:
    if not path.exists():
        return None
    dates = [dt.date(int(y), int(m), int(d)) for y, m, d in ISO_DATE_RE.findall(path.read_text(encoding="utf-8", errors="replace"))]
    return max(dates) if dates else dt.date.fromtimestamp(path.stat().st_mtime)


def _kern_datum(kern: Path) -> dt.date:
    """Date of the last commit of KERN.md in its own repo (git searches the next
    `.git` upward, so a mounted space answers for itself). A freshly cloned space
    has the clone time as mtime, which hid outdated KERN files (k1, 2026-09-24).
    The mtime counts only without history or with uncommitted changes."""
    mtime = dt.date.fromtimestamp(kern.stat().st_mtime)
    cwd = str(kern.parent)
    try:
        dirty = subprocess.run(["git", "-C", cwd, "status", "--porcelain", "--", kern.name],
                               capture_output=True, text=True, timeout=10, check=False)
        log = subprocess.run(["git", "-C", cwd, "log", "-1", "--format=%cs", "--", kern.name],
                             capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return mtime
    if dirty.returncode != 0 or dirty.stdout.strip() or log.returncode != 0:
        return mtime
    try:
        return dt.date.fromisoformat(log.stdout.strip())
    except ValueError:
        return mtime


def _kern(vault: Path) -> tuple[list[str], list[str]]:
    findings = []
    for project in sorted(_active_projects(vault)):
        base = vault / "20-projects" / project
        kern = base / "KERN.md"
        decisions = base / "ENTSCHEIDUNGEN-UND-FALLEN.md"
        if not kern.exists():
            findings.append(f"20-projects/{project}/KERN.md (fehlt)")
            continue
        # Gezaehlt wird der eingespielte Text ohne Frontmatter (so spielt session-context.sh ihn ein).
        text = kern.read_text(encoding="utf-8", errors="replace")
        if text.startswith("---\n") and "\n---\n" in text[4:]:
            text = text[4:].split("\n---\n", 1)[1]
        if len(text) > 3200:
            findings.append(f"20-projects/{project}/KERN.md (>{3200} Zeichen)")
        newest = _latest_decision_date(decisions)
        if newest is not None and _kern_datum(kern) < newest:
            findings.append(f"20-projects/{project}/KERN.md (älter als Entscheidungen)")
    return findings, _examples(findings)


def _queue(vault: Path) -> tuple[int, list[str]]:
    path = vault / "review-queue.md"
    entries = []
    if path.exists():
        in_marker = False
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("<!--") and (":start -->" in line or ":end -->" in line):
                in_marker = ":start -->" in line
                continue
            if not in_marker and line.strip().startswith(("- ", "* ")):
                entries.append(line.strip()[2:].strip())
    store = ContradictionStore(vault / config.CONTRADICTIONS_FILE)
    contradictions = store.open_findings()
    examples = _examples(entries + [str(f.get("id", "")) for f in contradictions])
    return len(entries) + len(contradictions), examples


def _stale_examples(vault: Path) -> list[str]:
    """Return the same stale-note set as stats.index_health (index of the
    active embedding model), capped later."""
    corpus, rows, _newest, keyfn, _modell, _missing = stats._index_rows(vault, None)
    return [n.rel for n in corpus if rows.get(n.rel) != keyfn(n)]


def _server_umweg(vault: Path) -> list[str]:
    try:
        from .server import umweg
        return umweg(vault)
    except Exception:  # der Befund darf doctor nie zu Fall bringen
        return []


# --- Notiz-Lint (v2-ki-nutzung #4, 2026-09-24) -------------------------------------------
# Dieselbe Pruefung wie der pre-commit-Hook (git-hooks/notiz_lint.py), hier ueber die
# Wissensnotizen, die in den letzten LINT_TAGE Tagen in Kern oder einem Space angelegt oder
# geaendert wurden. Nur Befund, nie "important": Altbestand soll nicht alarmieren.
LINT_TAGE = 14


def _lint_modul():
    import importlib.util
    pfad = Path(__file__).resolve().parents[2] / "git-hooks" / "notiz_lint.py"
    spec = importlib.util.spec_from_file_location("notiz_lint", pfad)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _schema(vault: Path) -> dict | None:
    """Schema-4-Verstoesse im ganzen Vault ueber `notiz_lint.schema_zaehlung` (b6-struktur):
    neue (created ab Stichtag) und Bestand getrennt, Beispiele nur aus den neuen. None, wenn
    das Lint-Modul oder gardener.schema fehlt."""
    try:
        z = _lint_modul().schema_zaehlung(str(vault))
    except Exception:
        return None
    if not z:
        return None
    return {"count": z["neu"], "bestand": z["bestand"], "geprueft": z["geprueft"],
            "stichtag": z["stichtag"], "neu_je_art": z["neu_je_art"],
            "bestand_je_art": z["bestand_je_art"], "examples": z["beispiele_neu"][:EXAMPLES]}


def _notiz_lint(vault: Path) -> tuple[int, int, list[str]]:
    """(gepruefte Notizen, Notizen mit Befund, Beispiele)."""
    try:
        lint = _lint_modul()
    except Exception:
        return 0, 0, []
    repos = [(vault, "")]
    for d in sorted((vault / "20-projects").glob("*/.git")) + sorted((vault / "30-topics").glob("*/.git")):
        repos.append((d.parent, d.parent.relative_to(vault).as_posix() + "/"))
    geprueft, befunde = 0, []
    for repo, praefix in repos:
        try:
            out = subprocess.run(["git", "-C", str(repo), "log", f"--since={LINT_TAGE}.days",
                                  "--diff-filter=AM", "--name-only", "--format="],
                                 capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for name in sorted(set(out.split("\n"))):
            rel = praefix + name.strip()
            if not name.strip() or not lint.ist_wissensnotiz(rel):
                continue
            try:
                text = (vault / rel).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue  # inzwischen geloescht oder verschoben
            geprueft += 1
            fehlt = lint.pruefe(text)
            if fehlt:
                befunde.append(f"{rel}: {', '.join(fehlt)}")
    return geprueft, len(befunde), _examples(befunde)


# --- Nutzungsmonitor (v2-ki-nutzung #6, 2026-09-24) ---------------------------------------
# Drei Kennzahlen aus den Claude-Transkripten dieser Maschine (~/.claude/projects, nur lesend)
# der letzten NUTZUNG_TAGE Tage: (1) Anteil maschineller Ausloeser des Auto-Recalls - vom
# 17.08. bis 23.09. liefen 57 % der Einspielungen auf Nachrichten statt Fragen, ohne dass es
# jemand sah; Alarm ab NUTZUNG_ALARM; (2) Anteil nichttrivialer Sitzungen (>= 1 Edit, >= 5
# Werkzeugaufrufe) mit `brain search` vor dem ersten Edit, getrennt nach Haupt und Worker;
# (3) Tripwire-Ausloesungen. Inkrementell: je Transkript Byte-Offset und Zaehler im Cache
# `_meta/tools/state/nutzung-cache.json` (JSONL waechst nur an). BRAIN_NUTZUNG=0 schaltet ab.
NUTZUNG_TAGE = 7
NUTZUNG_ALARM = 0.10
# 2 seit 29.09. (b7-recall): queued_command und neue Arten; alte Zaehler werden einmal neu gelesen.
NUTZUNG_CACHE_VERSION = 2
_EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
_BRAIN_SEARCH = re.compile(r"(^|[\s;&|(/])brain\s+search\b")
_MASCHINELL = ("sitzungsnachricht", "task-notification", "werkbank-marker", "slash-befehl", "worker-auftrag",
               "kontextwache", "fortsetzung")


def _ausloeser(text: str) -> str:
    t = text.lstrip()
    if t.startswith("Another Claude session sent a message") or "<cross-session-message" in t[:300]:
        return "sitzungsnachricht"
    if "<task-notification>" in t[:300] or t.startswith("[SYSTEM NOTIFICATION"):
        return "task-notification"
    if t.startswith("[wb-") or t.startswith("[Cross-session"):
        return "werkbank-marker"
    if t.startswith("<command-") or t.startswith("<local-command"):
        return "slash-befehl"
    if t.startswith("Auftrag deines Orchestrators") or "[Protokoll" in t[:2000]:
        return "worker-auftrag"
    # Texte der Kontextwache (~/.local/bin/context-guard), oft in <pasted_content> gehuellt, und
    # ihre Fortsetzungs-Texte nach der Kompaktierung (b7-recall, 29.09.: bisher als "mensch" gezaehlt).
    if "KONTEXT-WARNUNG (automatisch)" in t[:600]:
        return "kontextwache"
    if t.startswith("WEITERARBEITEN (automatisch nach der Kompaktierung") \
            or t.startswith("Weiter nach der Kompaktierung: lies "):
        return "fortsetzung"
    return "mensch"


def _user_text(msg: dict) -> str:
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return ""
        return " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


def _hook_text(att: dict) -> str:
    c = att.get("content")
    if isinstance(c, list):
        c = "\n".join(x for x in c if isinstance(x, str))
    if isinstance(c, str) and c:
        return c
    so = att.get("stdout") or ""
    if so.startswith("{"):
        try:
            hso = json.loads(so).get("hookSpecificOutput", {})
            return hso.get("additionalContext") or hso.get("permissionDecisionReason") or ""
        except ValueError:
            return so
    return so


def _transkript_fortsetzen(pfad: Path, st: dict) -> dict:
    """Liest `pfad` ab st["offset"] und fuehrt die Zaehler fort. Nur vollstaendige Zeilen."""
    st.setdefault("offset", 0)
    for k, v in (("cwd", ""), ("erster", None), ("edits", 0), ("tools", 0), ("suche_vor_edit", False),
                 ("letzte_eingabe", "mensch"), ("recall", []), ("tripwire", []), ("ende", "")):
        st.setdefault(k, v)
    with open(pfad, "rb") as fh:
        fh.seek(st["offset"])
        for roh in fh:
            if not roh.endswith(b"\n"):
                break  # halbe Zeile: beim naechsten Mal
            st["offset"] += len(roh)
            if not (b'"attachment"' in roh or b'"user"' in roh or b'"tool_use"' in roh):
                continue
            try:
                d = json.loads(roh)
            except ValueError:
                continue
            ts = d.get("timestamp") or ""
            if ts:
                st["ende"] = ts
            if not st["cwd"] and d.get("cwd"):
                st["cwd"] = d["cwd"]
            t = d.get("type")
            msg = d.get("message") if isinstance(d.get("message"), dict) else None
            # Nachrichten anderer Sitzungen tragen isMeta=true und zaehlen trotzdem als Eingabe.
            if t == "user" and msg:
                text = _user_text(msg)
                if text:
                    st["letzte_eingabe"] = _ausloeser(text)
                    if st["erster"] is None and not text.startswith("<"):
                        st["erster"] = text[:3000]
            elif t == "attachment" and isinstance(d.get("attachment"), dict):
                att = d["attachment"]
                # Waehrend eines Zuges eingereihte Eingaben (Nachricht einer anderen Sitzung,
                # Hintergrundmeldung) stehen nicht als user-Zeile, sondern als queued_command im
                # Transkript, direkt vor den Hook-Zeilen ihres UserPromptSubmit. Ohne diesen Zweig
                # erbte ihr Recall die Art der vorigen user-Zeile (b7-recall, 29.09.: sechs
                # "task-notification"-Einspielungen waren Orchestrator-Nachrichten).
                if att.get("type") == "queued_command":
                    q = att.get("prompt")
                    if isinstance(q, list):
                        q = " ".join(x.get("text", "") for x in q
                                     if isinstance(x, dict) and x.get("type") == "text")
                    if isinstance(q, str) and q:
                        st["letzte_eingabe"] = _ausloeser(q)
                    continue
                if att.get("type") not in ("hook_success", "hook_additional_context"):
                    continue
                inhalt = _hook_text(att)
                ev = att.get("hookEvent")
                if ev == "UserPromptSubmit" and inhalt.startswith("Brain-Recall"):
                    art = "auftrag" if inhalt.startswith("Brain-Recall zum Auftrag") else st["letzte_eingabe"]
                    st["recall"].append([ts[:19], art])
                elif ev == "PreToolUse" and "Fallenbuch-Tripwire" in inhalt:
                    st["tripwire"].append(ts[:19])
            elif t == "assistant" and msg:
                for blk in msg.get("content") or []:
                    if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                        continue
                    st["tools"] += 1
                    name = blk.get("name", "")
                    if name in _EDIT_TOOLS:
                        st["edits"] += 1
                    elif name == "Bash" and st["edits"] == 0:
                        if _BRAIN_SEARCH.search((blk.get("input") or {}).get("command", "") or ""):
                            st["suche_vor_edit"] = True
    return st


def _rolle(st: dict) -> str:
    erster = st.get("erster") or ""
    if "/.pi-workers/worktrees/" in st.get("cwd", "") or "[Protokoll" in erster \
            or "Rolle: Worker" in erster or "Auftrag deines Orchestrators" in erster:
        return "worker"
    return "haupt"


def nutzung(vault: Path, home: Path | None = None, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    grenze = (now - dt.timedelta(days=NUTZUNG_TAGE)).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    # Ohne `home` die Wurzel aus gardener.config: die Tests lenken sie ins Leere (conftest).
    wurzel = Path(home) / ".claude" / "projects" if home else Path(config.TRANSCRIPT_DIR)
    cache_pfad = Path(vault) / "_meta" / "tools" / "state" / "nutzung-cache.json"
    try:
        cache = json.loads(cache_pfad.read_text(encoding="utf-8"))
        if cache.get("version") != NUTZUNG_CACHE_VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    dateien = cache.get("dateien", {})
    neu: dict = {}
    frist = now.timestamp() - NUTZUNG_TAGE * 86400
    for p in wurzel.glob("*/*.jsonl"):   # Hauptsitzungen; Subagenten liegen tiefer
        try:
            stat = p.stat()
        except OSError:
            continue
        if stat.st_mtime < frist:
            continue
        key = str(p)
        st = dateien.get(key) or {}
        if st.get("offset", 0) > stat.st_size:
            st = {}   # Datei ersetzt/gekuerzt: neu lesen
        try:
            neu[key] = _transkript_fortsetzen(p, st) if st.get("offset", 0) < stat.st_size else st
        except OSError:
            continue
    try:
        cache_pfad.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_pfad.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": NUTZUNG_CACHE_VERSION, "dateien": neu}, separators=(",", ":")), encoding="utf-8")
        tmp.replace(cache_pfad)
    except OSError:
        pass
    ausloeser: dict[str, int] = {}
    tripwire = 0
    sitzungen = {"haupt": [0, 0], "worker": [0, 0]}   # [nichttrivial, mit Suche vor Edit]
    for st in neu.values():
        for ts, art in st.get("recall", []):
            if ts >= grenze:
                ausloeser[art] = ausloeser.get(art, 0) + 1
        tripwire += sum(1 for ts in st.get("tripwire", []) if ts >= grenze)
        if st.get("ende", "") >= grenze and st.get("edits", 0) >= 1 and st.get("tools", 0) >= 5:
            z = sitzungen[_rolle(st)]
            z[0] += 1
            z[1] += bool(st.get("suche_vor_edit"))
    maschinell = sum(v for k, v in ausloeser.items() if k in _MASCHINELL)
    fragen = sum(v for k, v in ausloeser.items() if k != "auftrag")
    anteil = round(maschinell / fragen, 3) if fragen else 0.0
    return {
        "tage": NUTZUNG_TAGE, "transkripte": len(neu),
        "recall_einspielungen": sum(ausloeser.values()), "recall_ausloeser": ausloeser,
        "recall_maschinell_anteil": anteil,
        "suche_vor_edit": {r: {"sitzungen": z[0], "mit_suche": z[1],
                               "anteil": round(z[1] / z[0], 3) if z[0] else None}
                           for r, z in sitzungen.items()},
        "tripwire_ausloesungen": tripwire,
        "important": anteil > NUTZUNG_ALARM,
        "examples": [f"{k}: {v}" for k, v in sorted(ausloeser.items(), key=lambda x: -x[1])][:EXAMPLES],
    }


# --- Nutzungsprotokoll: Recall-SLO, Null-Treffer, Nachlese, Abdeckung (2026-09-28, b6-zugang) --
# Quelle: braincli.nutzungslog (lokal, gitignoriert). Der Recall war vom 17.08. bis 23.09. stumm,
# ohne dass es auffiel; mit diesen Zahlen faellt eine Frist-Leerquote am ersten Tag auf.
PROTOKOLL_TAGE = 7
RECALL_P95_ALARM_MS = 1600
FRIST_ALARM = 0.05
P95_MIN_N = 10            # erst ab so vielen Recall-Suchen ist ein p95 aussagekraeftig
FRIST_MIN_N = 2           # einzelne Frist-Ausreisser alarmieren nicht
NACHLESE_MINUTEN = 30
_OHNE_SUCHE = ("maschinell", "auftrag-genannt")   # Recall-Zeilen, bei denen nie gesucht wurde


def _quantil(werte: list, q: float) -> float | None:
    if not werte:
        return None
    w = sorted(werte)
    return w[min(len(w) - 1, max(0, int(round(q * (len(w) - 1)))))]


def _read_heat(vault: Path, seit: dt.datetime) -> dict:
    """rel -> sortierte Lesezeitpunkte aus read-heat.log (PostToolUse Read)."""
    out: dict = {}
    pfad = Path(vault) / "_meta" / "tools" / "state" / "read-heat.log"
    try:
        zeilen = pfad.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for z in zeilen:
        ts, _, rel = z.partition("\t")
        try:
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if t >= seit:
            out.setdefault(rel.strip(), []).append(t)
    return out


def protokoll(vault: Path, now: dt.datetime | None = None, notizen: int | None = None) -> dict | None:
    """Kennzahlen aus dem Nutzungsprotokoll; None, wenn es (noch) keine Zeile gibt."""
    from . import nutzungslog
    now = now or dt.datetime.now(dt.timezone.utc)
    alle = nutzungslog.lesen(vault, tage=nutzungslog.AUFBEWAHRUNG_TAGE, now=now)
    if not alle:
        return None
    grenze = now - dt.timedelta(days=PROTOKOLL_TAGE)
    woche = [d for d in alle if d["_ts"] >= grenze]
    # startswith: der Hook schreibt seit 29.09. "maschinell:<regel>" (recall_eingabe.py).
    recall = [d for d in woche if d.get("kanal") == "recall"
              and not str(d.get("detail") or "").startswith(_OHNE_SUCHE)]
    dauer = [d["dauer_ms"] for d in recall if isinstance(d.get("dauer_ms"), (int, float))]
    gruende: dict = {}
    for d in recall:
        g = d.get("leer") or "eingespielt"
        gruende[g] = gruende.get(g, 0) + 1
    n = len(recall)
    # `kalt` (seit 09.10.): der Hook fand keinen warmen Recall-Prozess, startete ihn und liess die Eingabe
    # sofort leer; fuer die Leerquote zaehlt das wie die Frist, nur ohne Wartezeit.
    frist = gruende.get("frist", 0) + gruende.get("kalt", 0)
    frist_quote = round(frist / n, 3) if n else 0.0
    p50, p95 = _quantil(dauer, 0.5), _quantil(dauer, 0.95)
    suche = [d for d in woche if d.get("kanal") == "search"]
    null = sum(1 for d in suche if d.get("leer") == "keine_treffer")
    # Nachlese: eine Auslieferung, von deren Pfaden binnen NACHLESE_MINUTEN einer per Read
    # gelesen wurde. Recall zaehlt die eingespielten Pfade, search die Trefferliste.
    heat = _read_heat(vault, grenze)
    fenster = dt.timedelta(minutes=NACHLESE_MINUTEN)
    nachlese = {}
    for kanal in ("recall", "search"):
        mit, gelesen = 0, 0
        for d in woche:
            if d.get("kanal") != kanal:
                continue
            rels = d.get("gezeigt") if kanal == "recall" else [t.get("rel") for t in d.get("treffer") or []]
            rels = [r for r in rels or [] if r]
            if not rels:
                continue
            mit += 1
            if any(d["_ts"] <= t <= d["_ts"] + fenster for r in rels for t in heat.get(r, [])):
                gelesen += 1
        nachlese[kanal] = {"auslieferungen": mit, "nachgelesen": gelesen,
                           "quote": round(gelesen / mit, 3) if mit else None}
    # Abdeckung ueber die ganze Aufbewahrung: Notizen, die mindestens einmal ausgeliefert wurden.
    ausgeliefert = set()
    for d in alle:
        if d.get("kanal") == "recall":
            ausgeliefert.update(r for r in d.get("gezeigt") or [] if r)
        elif d.get("kanal") == "search":
            ausgeliefert.update(t.get("rel") for t in d.get("treffer") or [] if t.get("rel"))
    alarm = []
    if n >= P95_MIN_N and p95 is not None and p95 > RECALL_P95_ALARM_MS:
        alarm.append(f"Recall p95 {p95 / 1000:.2f} s > {RECALL_P95_ALARM_MS / 1000:.1f} s")
    if frist >= FRIST_MIN_N and frist_quote > FRIST_ALARM:
        alarm.append(f"Recall zu {frist_quote:.0%} an Frist/Kaltstart leer ({frist} von {n})")
    return {
        "tage": PROTOKOLL_TAGE,
        "recall": {"suchen": n, "p50_ms": p50, "p95_ms": p95, "leer_nach_grund": gruende,
                   "frist_quote": frist_quote},
        "suche": {"anfragen": len(suche), "null_treffer": null,
                  "null_quote": round(null / len(suche), 3) if suche else None},
        "nachlese": nachlese,
        "abdeckung": {"tage": nutzungslog.AUFBEWAHRUNG_TAGE, "notizen_ausgeliefert": len(ausgeliefert),
                      "notizen": notizen,
                      "anteil": round(len(ausgeliefert) / notizen, 3) if notizen else None},
        "alarm": alarm,
        "important": bool(alarm),
    }


def inspect(vault: Path, home: Path | None = None, now: dt.datetime | None = None) -> dict:
    vault, now = Path(vault), now or dt.datetime.now(dt.timezone.utc)
    config.bind_vault(vault)
    notes = load_notes(vault)
    gardener = _last_success(vault)
    index = stats.index_health(vault)
    stale = _stale_examples(vault)
    due, due_examples = _review_after(notes, now)
    old, old_examples = _old_stands(vault, notes, now)
    kern, kern_examples = _kern(vault)
    try:
        pruef = _pruefstatus(notes, now)
    except Exception:  # der Pruefstatus darf doctor nie zu Fall bringen
        pruef = None
    # Die andere Maschine mitpruefen (2026-09-23): 48 von 93 lokal fehlenden Pfaden lagen auf
    # peer. BRAIN_REALITAET_REMOTE="" schaltet das ab; nicht erreichbar = unveraendert.
    remote = os.environ.get("BRAIN_REALITAET_REMOTE",
                            "peer" if sys.platform == "darwin" else "mac")
    missing = realitaet.scan(vault, Path(home or Path.home()), remote=remote or None,
                             remote_timeout=3.0)
    missing_paths = [f"{b.pfad_notiz}:{b.zeile}" for b in missing if b.status == realitaet.STATUS_FEHLT]
    queue_count, queue_examples = _queue(vault)
    umweg = _server_umweg(vault)
    lint_geprueft, lint_befunde, lint_examples = _notiz_lint(vault)
    schema = _schema(vault)
    try:
        nutz = nutzung(vault, home, now) if os.environ.get("BRAIN_NUTZUNG", "1") != "0" else None
    except Exception:  # der Monitor darf doctor nie zu Fall bringen
        nutz = None
    moc_stale = _moc_layer(vault)
    wache = _messwache(vault, now)
    try:
        standby = _standby(vault, now)
    except Exception:  # die Standby-Pruefung darf doctor nie zu Fall bringen
        standby = None
    try:
        sicherung = _sicherung(vault, now)
    except Exception:  # die Sicherungspruefung darf doctor nie zu Fall bringen
        sicherung = None
    try:
        prot = protokoll(vault, now, len(notes))
    except Exception:  # das Protokoll darf doctor nie zu Fall bringen
        prot = None
    try:
        kanon_result = _kanon(notes)
    except Exception:  # der Kanon-Befund darf doctor nie zu Fall bringen
        kanon_result = None
    result = {
        "generated_at": now.isoformat(timespec="seconds"),
        "gardener": {**gardener, "important": (gardener["age_days"] or 0) > 14},
        "index": {**index, "important": index["stale_ratio"] > 0.10, "examples": _examples(stale)},
        "review_after": {"count": len(due), "examples": due_examples, "important": len(due) > 10},
        "old_stand": {"count": len(old), "examples": old_examples},
        "kern": {"count": len(kern), "examples": kern_examples},
        "reality": {"count": len(missing_paths), "examples": _examples(missing_paths), "important": len(missing_paths) > 20},
        "review_queue": {"count": queue_count, "examples": queue_examples},
        # F6: Git zeigt per repo-lokalem insteadOf auf den Standby (brain server waehlen)
        "server_umweg": {"count": len(umweg), "examples": _examples(umweg), "important": bool(umweg)},
        "notiz_lint": {"count": lint_befunde, "geprueft": lint_geprueft, "tage": LINT_TAGE,
                       "examples": lint_examples},
        # g5: MOC-Suchschicht (extra-embeddings.db) haengt dem Text nach
        "moc_schicht": {"count": len(moc_stale), "examples": _examples(moc_stale),
                        "important": len(moc_stale) > 5},
    }
    if pruef is not None:
        result["pruefstatus"] = pruef
    if schema is not None:
        result["schema"] = schema
    if nutz is not None:
        result["nutzung"] = nutz
    if prot is not None:
        result["protokoll"] = prot
    if wache is not None:
        result["messwache"] = wache
    if standby is not None:
        result["standby"] = standby
    if sicherung is not None:
        result["sicherung"] = sicherung
    if kanon_result is not None:
        result["kanon"] = kanon_result
    result["important"] = any(item.get("important", False) for item in result.values() if isinstance(item, dict))
    important = []
    if result["gardener"]["important"]: important.append(f"Gardener {gardener['age_days']:.0f} Tage")
    if result["index"]["important"]: important.append(f"Index {index['stale_ratio']:.0%} veraltet (brain index nachbetten)")
    if result["reality"]["important"]: important.append(f"Realität {len(missing_paths)} fehlende Pfade/Befehle")
    if result["review_after"]["important"]: important.append(f"{len(due)} review-after fällig")
    if pruef and pruef["important"]:
        important.append(f"{pruef['faellig']} kanonische Seiten mit fälliger Prüfung (brain pruefen)")
    if umweg: important.append(f"Git zeigt in {len(umweg)} Repo(s) auf den Standby (brain server status)")
    if nutz and nutz["important"]:
        important.append(f"Auto-Recall zu {nutz['recall_maschinell_anteil']:.0%} von Maschinen-Eingaben "
                         f"ausgeloest (Filter in hooks/auto-recall.sh pruefen)")
    if prot and prot["important"]:
        important.extend(prot["alarm"])
    if result["moc_schicht"]["important"]:
        important.append(f"MOC-Suchschicht: {len(moc_stale)} MOCs ohne aktuellen Vektor (gardener --phase embed)")
    if wache and wache["important"]:
        important.append(f"Suchwache {wache['ergebnis']}: " + "; ".join(wache["examples"][:2]))
    if standby and standby["important"]:
        important.append(standby["examples"][0])
    if sicherung and sicherung["important"]:
        important.extend(sicherung["examples"])
    if kanon_result and kanon_result["important"]:
        important.append(f"{kanon_result['count']} kanonische Seite(n) veraltet (brain doctor --json, Feld kanon)")
    result["summary"] = ", ".join(important)
    return result


def _moc_layer(vault: Path) -> list[str]:
    """MOCs whose search vector is missing or older than their text (g5)."""
    try:
        from .extra_embed import stale
        return stale(vault)
    except Exception as e:  # a broken side store must not take the doctor down
        return [f"(nicht pruefbar: {e})"]


def _cache_path(vault: Path) -> Path:
    return Path(vault) / "_meta" / "tools" / "state" / "doctor-cache.json"


def run(vault: Path, as_json: bool = False) -> int:
    result = inspect(vault)
    cache = _cache_path(vault)
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    except OSError:
        pass
    _verlauf_anhaengen(vault, result)
    if as_json:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    else:
        labels = (("Gardener", "gardener"), ("Such-Index", "index"), ("review-after", "review_after"),
                  ("Alte Stände", "old_stand"), ("KERN", "kern"), ("Realität", "reality"), ("Review-Queue", "review_queue"),
                  ("Server-Umweg", "server_umweg"), ("Notiz-Lint", "notiz_lint"),
                  ("MOC-Suchschicht veraltet", "moc_schicht"), ("Schema-4 neu", "schema"),
                  ("Kanonische Seiten veraltet", "kanon"))
        for label, key in labels:
            item = result.get(key)
            if item is None:
                continue
            if key == "schema":
                label = f"{label} (seit {item['stichtag']}; Bestand {item['bestand']})"
            if key == "kanon":
                label = f"{label} (kanonisch {item['kanonisch']}, Datum unbekannt {item['unbekannt']})"
            count = item.get("count", item.get("stale_notes_total", item.get("age_days")))
            if key == "index" and item.get("embed_model"):
                label = f"{label} ({item['embed_model']})"
            print(f"{label}: {count}")
            for example in item.get("examples", []): print(f"  {example}")
        pr0 = result.get("pruefstatus")
        if pr0:
            anteil = f"{pr0['anteil']:.0%}" if pr0["anteil"] is not None else "-"
            print(f"Prüfstatus kanonisch: {pr0['verifiziert']}/{pr0['kanonisch']} verifiziert ({anteil}), "
                  f"fällig {pr0['faellig']}, nie geprüft {pr0['nie']}"
                  f"{' ALARM' if pr0['important'] else ''}")
            for example in pr0.get("examples", []): print(f"  {example}")
        w = result.get("messwache")
        if w:
            print(f"Suchwache: {w['ergebnis']} ({w['stand']}), blind200-Dev nDCG@10 {w['ndcg10']}"
                  f"{' ALARM' if w['important'] else ''}")
            for example in w.get("examples", []): print(f"  {example}")
        sb = result.get("standby")
        if sb:
            print(f"Standby: {sb['examples'][0]}{' ALARM' if sb['important'] else ''} (gemessen {sb['gemessen']})")
        si = result.get("sicherung")
        if si:
            print(f"Sicherung: {'ALARM' if si['important'] else 'ok'}")
            for example in si.get("examples", []): print(f"  {example}")
        n = result.get("nutzung")
        if n:
            sv = n["suche_vor_edit"]
            fmt = lambda z: f"{z['mit_suche']}/{z['sitzungen']}" if z["sitzungen"] else "0/0"
            print(f"Nutzung ({n['tage']} Tage, {n['transkripte']} Transkripte): Recall maschinell "
                  f"{n['recall_maschinell_anteil']:.0%} von {n['recall_einspielungen']}"
                  f"{' ALARM' if n['important'] else ''}; brain search vor Edit Haupt {fmt(sv['haupt'])}, "
                  f"Worker {fmt(sv['worker'])}; Tripwire {n['tripwire_ausloesungen']}")
            for example in n.get("examples", []): print(f"  {example}")
        pr = result.get("protokoll")
        if pr:
            r, su, na, ab = pr["recall"], pr["suche"], pr["nachlese"], pr["abdeckung"]
            ms = lambda v: f"{v / 1000:.2f} s" if v is not None else "-"
            q = lambda v: f"{v:.0%}" if v is not None else "-"
            gruende = ", ".join(f"{k} {v}" for k, v in sorted(r["leer_nach_grund"].items(), key=lambda x: -x[1]))
            print(f"Protokoll ({pr['tage']} Tage): Recall {r['suchen']} Suchen, p50 {ms(r['p50_ms'])}, "
                  f"p95 {ms(r['p95_ms'])}, Frist-leer {q(r['frist_quote'])}"
                  f"{' ALARM' if pr['important'] else ''}; Suche {su['anfragen']}, null {q(su['null_quote'])}; "
                  # Nur Read-Aufrufe zaehlen, Bash-Lesebefehle nicht (Pruefbericht 14.10.2026: rund 7 % der
                  # Lesezugriffe); deshalb als untere Schranke ausgewiesen.
                  f"Nachlese (nur Read, untere Schranke) Recall {q(na['recall']['quote'])}, "
                  f"Suche {q(na['search']['quote'])}; "
                  f"ausgeliefert {ab['notizen_ausgeliefert']} Notizen ({q(ab['anteil'])}, {ab['tage']} Tage)")
            if gruende:
                print(f"  Recall-Ausgang: {gruende}")
            for a in pr["alarm"]:
                print(f"  {a}")
    return 0


def _verlauf_anhaengen(vault: Path, result: dict) -> None:
    """Zeitreihe (Firmenniveau-Plan M2): jede Ausfuehrung haengt eine kompakte Zeile an
    `_meta/tools/state/doctor-verlauf.jsonl` (gitignoriert, maschinenlokal)."""
    pr = result.get("protokoll") or {}
    r = pr.get("recall") or {}
    zeile = {
        "ts": result.get("generated_at"),
        "important": result.get("important"),
        "summary": result.get("summary"),
        "index_stale_ratio": (result.get("index") or {}).get("stale_ratio"),
        "kern": (result.get("kern") or {}).get("count"),
        "reality": (result.get("reality") or {}).get("count"),
        "review_after": (result.get("review_after") or {}).get("count"),
        "notiz_lint": (result.get("notiz_lint") or {}).get("count"),
        "schema_neu": (result.get("schema") or {}).get("count"),
        "schema_bestand": (result.get("schema") or {}).get("bestand"),
        "gardener_age_days": (result.get("gardener") or {}).get("age_days"),
        "recall_n": r.get("suchen"), "recall_p50_ms": r.get("p50_ms"), "recall_p95_ms": r.get("p95_ms"),
        "recall_frist_quote": r.get("frist_quote"),
        "suche_null_quote": (pr.get("suche") or {}).get("null_quote"),
        "nachlese_recall": ((pr.get("nachlese") or {}).get("recall") or {}).get("quote"),
        "abdeckung": (pr.get("abdeckung") or {}).get("anteil"),
    }
    try:
        pfad = Path(vault) / "_meta" / "tools" / "state" / "doctor-verlauf.jsonl"
        pfad.parent.mkdir(parents=True, exist_ok=True)
        with open(pfad, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(zeile, ensure_ascii=False, separators=(",", ":")) + "\n")
    except OSError:
        pass
