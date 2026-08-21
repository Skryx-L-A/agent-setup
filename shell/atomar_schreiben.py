"""atomar_schreiben — unteilbares Schreiben/Kopieren fuer jedes Werkzeug, das
etwas in eine Datei schreibt, die eine LAUFENDE Umgebung liest (Konfiguration,
Skript, Rollen-Prompt), waehrend dieses Werkzeug schreibt.

ANLASS (21.08.2026, Auftrag 4/5): `wb-ausrollen` schrieb mit `shutil.copy2`
direkt auf sein Ziel; ein `pi-worker`-Start, der GENAU in diesem Moment lief,
sah eine halb geschriebene Datei und einen Syntaxfehler an einer Stelle, an
der nichts falsch war. Dieselbe Bauart — `open(ziel, "w")`/`shutil.copy2`/
`Path.write_text` direkt aufs Ziel — fand sich danach an drei weiteren
Stellen (`wb-harness-config`, `wb-instructions`, `mcp-shared`). Statt die
Loesung viermal einzeln hinterherzubauen (und beim naechsten Umbau dieselbe
Verdopplung zu wiederholen, die an DEMSELBEN Abend schon einmal bei der
Speicherformel in vier unabhaengigen Fassungen gefunden wurde), steht sie
hier EINMAL.

WOHER ERREICHBAR: eine gewoehnliche `.py`-Datei direkt unter `shell/`, neben
den vier Aufrufern — `import atomar_schreiben` findet sie ohne jede
sys.path-Anpassung, weil Python das Verzeichnis des laufenden Skripts
automatisch vorn in `sys.path` eintraegt. Das gilt im Repo UND nach dem
Ausrollen gleichermassen, weil `shell/` als Ganzes nach `~/.local/bin`
ausgerollt wird (`wb-consistency`s `install_map`) — alle fuenf Dateien landen
zusammen im selben Verzeichnis. Kein `hooks/lib`-artiger Unterordner: `shell/`
kennt diese Konvention bisher nicht, und ein Unterordner haette in jedem der
vier Aufrufer ein `sys.path.insert(0, ...)` gebraucht — genau die neue
Abhaengigkeit, die der Auftrag ausdruecklich vermeiden wollte. Einzige
Ausnahme: `mcp-shared`s `apply`-Unterbefehl fuehrt seinen Python-Teil ueber
`python3 -` (Code von stdin) aus, nicht als Datei — dort setzt der Aufrufer
selbst `sys.path` von Hand (siehe dort), weil Python fuer Code von stdin kein
Skriptverzeichnis kennt, das es automatisch eintragen koennte.

ZWEI FUNKTIONEN, NICHT EINE — die Unterschiede zwischen den vier Aufrufern
werden nicht verschluckt (Auftrag, woertlich: "eine gemeinsame Stelle, die
diese Unterschiede verschluckt, waere schlechter als vier getrennte"):

  kopieren(quelle, ziel)
      Eine Datei kopieren, Inhalt UND Rechte von `quelle` uebernehmen (wie
      `shutil.copy2`, nur unteilbar). Fuer `wb-ausrollen`: hier steht eine
      echte Quelldatei, deren Ausfuehrbit mitgilt.

  schreiben(ziel, inhalt, modus=None, newline=None)
      Erzeugten Text (str, als UTF-8) oder Bytes unteilbar nach `ziel`
      schreiben — keine Quelldatei, der Inhalt kommt aus dem Aufrufer selbst.
      `modus` wird NUR gesetzt, wenn angegeben; sonst behaelt die Nebendatei
      die engen 0600-Rechte, die `tempfile.mkstemp` vergibt — das ist immer
      die SICHERE Richtung (enger statt weiter). Ein Aufrufer, der die
      ueblichen 0644 eines gewoehnlichen `open()` braucht (so wie es vorher,
      ohne diesen Umbau, immer war), uebergibt sie ausdruecklich — genau das
      tun `wb-instructions` und `mcp-shared` unten. `wb-harness-config`
      uebernimmt die Rechte stattdessen von seiner Vorlagendatei
      (`modus=stat.S_IMODE(os.stat(vorlage).st_mode)`), weil sein Inhalt zwar
      erzeugt ist (Platzhalter aufgeloest), die Rechte aber trotzdem von einer
      Quelle stammen sollen. `newline` reicht unveraendert an `open()` durch
      (siehe dort) — `wb-harness-config` schreibt mit `newline=""`, damit
      Zeilenenden in der Vorlage nicht von Pythons universeller Uebersetzung
      angefasst werden.

BEIDE Funktionen: Nebendatei im SELBEN Verzeichnis wie `ziel` (nie in `/tmp`
— ueber eine Dateisystemgrenze hinweg ist `os.replace` kein einzelner Schritt
mehr, sondern Kopie plus Loeschen, und genau dieselbe Luecke waere zurueck),
Rechte DORT setzen, dann `os.replace()` — unter POSIX innerhalb desselben
Dateisystems unteilbar: wer `ziel` in genau diesem Moment liest oder
ausfuehrt, sieht entweder die alte Fassung ganz oder die neue ganz, nie eine
halbe.

Ein Abbruch zwischen Schreiben und Umbenennen laesst die Nebendatei mit einem
erkennbaren Namen liegen (`<ziel-basisname>.atomar-tmp-<zufall>`, KEIN
fuehrender Punkt — ein Rest soll in einem gewoehnlichen `ls` auffallen, nicht
in `ls -a` verschwinden). Ein spaeterer Aufruf im selben Verzeichnis raeumt
Nebendateien auf, die aelter als `_TMP_MINDESTALTER_S` sind — juenger NICHT,
damit ein Lauf nicht die noch nicht fertig geschriebene Nebendatei eines
zweiten, wirklich gleichzeitigen Laufs auf dasselbe Ziel wegraeumt (derselbe
Fall, den `wb-ausrollen` schon vorher geloest hat — hier nur einmal mehr
mitgetragen).
"""
import os
import shutil
import stat
import tempfile
import time

_TMP_MARKE = ".atomar-tmp-"
_TMP_MINDESTALTER_S = 60.0


def _verwaiste_tmp_aufraeumen(verzeichnis):
    """Nur Dateien mit der eigenen Marke im Namen, nie etwas Fremdes im
    Zielverzeichnis; nur, wenn sie mindestens `_TMP_MINDESTALTER_S` alt sind
    (Begruendung siehe Kopfkommentar)."""
    jetzt = time.time()
    try:
        for name in os.listdir(verzeichnis):
            if _TMP_MARKE not in name:
                continue
            pfad = os.path.join(verzeichnis, name)
            try:
                alter = jetzt - os.lstat(pfad).st_mtime
            except OSError:
                continue
            if alter < _TMP_MINDESTALTER_S:
                continue
            try:
                os.unlink(pfad)
            except OSError:
                pass
    except OSError:
        pass


def _tmp_anlegen(ziel):
    zielverz = os.path.dirname(os.fspath(ziel)) or "."
    os.makedirs(zielverz, exist_ok=True)
    _verwaiste_tmp_aufraeumen(zielverz)
    fd, tmp = tempfile.mkstemp(
        dir=zielverz, prefix="%s%s" % (os.path.basename(os.fspath(ziel)), _TMP_MARKE))
    os.close(fd)
    return tmp


def kopieren(quelle, ziel):
    """Datei unteilbar nach `ziel` kopieren, Inhalt UND Rechte von `quelle`
    uebernehmen — wie `shutil.copy2(quelle, ziel)`, nur dass kein Leser je
    eine halb geschriebene Fassung von `ziel` sieht."""
    tmp = _tmp_anlegen(ziel)
    try:
        shutil.copy2(quelle, tmp)
        modus = os.stat(quelle).st_mode
        os.chmod(tmp, stat.S_IMODE(modus))
        os.replace(tmp, ziel)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def schreiben(ziel, inhalt, modus=None, newline=None):
    """Erzeugten Text (`str`, als UTF-8) oder `bytes` unteilbar nach `ziel`
    schreiben. `modus` wird nur gesetzt, wenn angegeben (sonst bleiben die
    engen 0600-Rechte von `tempfile.mkstemp` stehen). `newline` reicht
    unveraendert an `open()` durch, nur fuer Text relevant."""
    tmp = _tmp_anlegen(ziel)
    try:
        if isinstance(inhalt, bytes):
            with open(tmp, "wb") as f:
                f.write(inhalt)
        else:
            with open(tmp, "w", encoding="utf-8", newline=newline) as f:
                f.write(inhalt)
        if modus is not None:
            os.chmod(tmp, modus)
        os.replace(tmp, ziel)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
