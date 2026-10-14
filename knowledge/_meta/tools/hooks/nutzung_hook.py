"""Hintergrund-Schreiber des Nutzungsprotokolls fuer den Recall-Hook (2026-09-28, b6-zugang).

`auto-recall.sh` startet dieses Skript abgekoppelt (`( ... & )`) und wartet nicht darauf; die
Mehrzeit des Hooks ist damit nur der Start des Hintergrundprozesses. Eingaben:
- stdin: das JSON von `brain search --json` (leer bei Frist/Fehler/Filter),
- WB_NL_GRUND / WB_NL_DETAIL: Leer-Grund aus dem Shell-Teil (frist, kalt, fehler, filter),
- WB_NL_DATEI: Bericht des Formatierers (grund, detail, gezeigt); wird gelesen und geloescht,
- WB_NL_T0: Startzeit (Epoch-Sekunden) aus dem ersten python-Aufruf des Hooks,
- WB_NL_PROMPT, WB_NL_CWD, WB_NL_VAULT.

Schreibt ueber `braincli.nutzungslog` (geschwaerzt, lokal, gitignoriert). Still bei jedem Fehler.
"""
import json
import os
import sys
import time
from pathlib import Path


def main() -> None:
    ende = time.time()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "braincli"))
    from braincli import nutzungslog as nl

    try:
        roh = sys.stdin.read()
        daten = json.loads(roh) if roh.strip() else {}
    except Exception:
        daten = {}
    bericht = {}
    datei = os.environ.get("WB_NL_DATEI", "")
    if datei:
        try:
            bericht = json.loads(Path(datei).read_text(encoding="utf-8"))
        except Exception:
            bericht = {}
        try:
            os.remove(datei)
        except OSError:
            pass
        # Liegengebliebene Berichte (Schreiber vorher abgebrochen) nach einer Stunde weg.
        try:
            for alt in Path(datei).parent.glob("brain-recall-*.json"):
                if ende - alt.stat().st_mtime > 3600:
                    alt.unlink()
        except OSError:
            pass
    grund = os.environ.get("WB_NL_GRUND") or bericht.get("grund")
    detail = os.environ.get("WB_NL_DETAIL") or bericht.get("detail") or None
    if not grund and not bericht:
        # Formatierer lief, hat aber keinen Bericht geschrieben (abgestuerzt).
        grund, detail = "fehler", "formatierer"
    try:
        dauer = (ende - float(os.environ.get("WB_NL_T0", ""))) * 1000
    except ValueError:
        dauer = None
    treffer = []
    for h in (daten.get("hits") or []) if isinstance(daten, dict) else []:
        if isinstance(h, dict) and h.get("rel"):
            treffer.append({"rel": h["rel"], "score": h.get("score")})
    cwd = os.environ.get("WB_NL_CWD", "")
    nl.protokolliere("recall", os.environ.get("WB_NL_VAULT") or None,
                     anfrage=os.environ.get("WB_NL_PROMPT", ""), treffer=treffer, grund=grund,
                     dauer_ms=dauer, rolle_=nl.rolle(cwd), detail=detail,
                     gezeigt=bericht.get("gezeigt") or None,
                     auftrag=True if bericht.get("auftrag") else None)


def _zeichen(pfad: Path, ohne_frontmatter: bool = False, grenze: int = 0) -> int:
    """Zeichen, die der SessionStart von `pfad` einspielt; mit `grenze` dieselbe Kuerzung an
    der letzten Zeilengrenze wie in session-context.sh (ohne die Hinweiszeile)."""
    try:
        text = pfad.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0
    if ohne_frontmatter and text.startswith("---\n") and "\n---\n" in text[4:]:
        text = text[4:].split("\n---\n", 1)[1]
    if len(text) > grenze > 0:
        schnitt = text.rfind("\n", 0, grenze)
        return len(text[:schnitt if schnitt > 0 else grenze].rstrip())
    return len(text)


def sessionstart() -> None:
    """Kanal sessionstart: WB_NL_TEILE nennt die eingespielten Teile (critical, identity, gast,
    hot, kern:<projekt>, moc:<projekt>); die Zeichenzahl je Teil wird hier aus den Dateien
    bestimmt (KERN nach der Kuerzung auf WB_NL_KERN_MAX), nicht im SessionStart selbst."""
    ende = time.time()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "braincli"))
    from braincli import nutzungslog as nl

    vault = Path(os.environ.get("WB_NL_VAULT") or Path.home() / "Knowledge")
    try:
        kern_max = int(os.environ.get("WB_NL_KERN_MAX", "3200"))
    except ValueError:
        kern_max = 3200
    pfade, teile = [], {}
    for teil in filter(None, os.environ.get("WB_NL_TEILE", "").split(",")):
        name, _, projekt = teil.partition(":")
        if name == "critical":
            rel, n = "CRITICAL-FACTS.md", _zeichen(vault / "CRITICAL-FACTS.md")
        elif name == "identity":
            rel, n = "IDENTITY.md", _zeichen(vault / "IDENTITY.md")
        elif name == "hot":
            rel, n = "HOT.md", _zeichen(vault / "HOT.md")
        elif name in ("kern", "moc") and projekt:
            rel = f"20-projects/{projekt}/{name.upper()}.md"
            n = _zeichen(vault / rel, ohne_frontmatter=True)
            if name == "kern" and n > kern_max > 0:
                teile["kern_gekuerzt_von"] = n
                n = _zeichen(vault / rel, ohne_frontmatter=True, grenze=kern_max)
            elif name == "moc":
                n = min(n, 2500)
        else:
            teile[name] = 1
            continue
        pfade.append((rel, None))
        teile[name] = n
    try:
        dauer = (ende - float(os.environ.get("WB_NL_T0", ""))) * 1000
    except ValueError:
        dauer = None
    cwd = os.environ.get("WB_NL_CWD", "")
    nl.protokolliere("sessionstart", vault, treffer=pfade, dauer_ms=dauer, rolle_=nl.rolle(cwd),
                     teile=teile or None)


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["sessionstart"]:
            sessionstart()
        else:
            main()
    except Exception:
        pass
