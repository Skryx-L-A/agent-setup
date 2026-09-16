#!/usr/bin/env python3
"""Gedaechtnis eines Agenten: ``MEMORY.md`` mit harter Obergrenze, Archiv im Brain.

Entscheidung vom 16.09.2026 (der Nutzer, docs/AGENTS-PLAN.md, Abschnitt 16): ``MEMORY.md`` enthaelt nur das
Allerwichtigste, hoechstens 2.000 Zeichen und 15 Zeilen unter dem festen Kopf. Der Kopf (Titelzeile und ein
fester Satz, was hineingehoert) zaehlt nicht mit; leere Zeilen und der Platzhalter auch nicht. Alles andere
liegt im Brain (``agents_brain``): ``lehren.md`` im eigenen Bereich ist das Archiv.

- ``stand``: Groesse und Brain-Bereich fuer Ansicht und Traeger.
- ``archivieren``: verschiebt genannte Zeilen nach ``lehren.md`` (erst Brain, dann ``MEMORY.md``), optional
  mit neuen, verdichteten Zeilen; Grundlage des Lernschritts ``archiv``.
- ``bestand_archivieren``: fuer bestehende Agenten alles bis auf die letzten fuenf Lehren
  (``wb-welt gedaechtnis <welt> [<agent>] --archivieren``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402
import agents_brain as ab  # noqa: E402

GRENZE_ZEICHEN = 2000
GRENZE_ZEILEN = 15
GRENZE = {"zeichen": GRENZE_ZEICHEN, "zeilen": GRENZE_ZEILEN}
DATEI = "MEMORY.md"
LESE_LIMIT = 1024 * 1024
PLATZHALTER = "Noch keine Einträge."
LEHREN_UEBERSCHRIFT = "## Lehren"
KOPF_MARKE = "> Ins Gedächtnis gehört nur"
KOPF_SATZ = ("> Ins Gedächtnis gehört nur, was jeden Zug gilt: Regeln, die jeden Zug ändern, Zusagen an Menschen "
             "und offene Verpflichtungen. Hergang, Belege und Themenwissen gehören als Notiz ins Brain "
             "(Lernschritt `notiz`, Archiv `lehren.md`). Grenze: 2.000 Zeichen und 15 Zeilen unter diesem Kopf.")
BEHALTEN_VORGABE = 5
AUSWAHL_LIMIT = 200
NEU_LIMIT = GRENZE_ZEILEN
NEU_ZEILE_LIMIT = 500


def titel(agent_id: str) -> str:
    return "# %s – Gedächtnis" % agent_id


def vorlage(agent_id: str) -> str:
    """``MEMORY.md`` eines neuen Agenten: fester Kopf, noch keine Eintraege."""
    return "%s\n\n%s\n\n%s\n" % (titel(agent_id), KOPF_SATZ, PLATZHALTER)


def trennen(text: str) -> tuple[list[str], list[str]]:
    """(Kopfzeilen, Rumpfzeilen). Kopf: eine ``# ``-Titelzeile am Anfang und der feste Satz direkt danach."""
    lines = text.replace("\r\n", "\n").split("\n")
    kopf: list[str] = []
    i = 0
    if lines and lines[0].startswith("# "):
        kopf.append(lines[0])
        i = 1
        j = i
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and lines[j].startswith(KOPF_MARKE):
            kopf.append(lines[j])
            i = j + 1
    return kopf, lines[i:]


def _inhalt(rumpf: list[str]) -> list[str]:
    return [line for line in rumpf if line.strip() and line.strip() != PLATZHALTER]


def messen(text: str) -> dict[str, Any]:
    """Zeichen und Zeilen unter dem Kopf; leere Zeilen und der Platzhalter zaehlen nicht."""
    _, rumpf = trennen(text)
    inhalt = _inhalt(rumpf)
    zeichen = len("\n".join(inhalt))
    return {"zeichen": zeichen, "zeilen": len(inhalt),
            "ueber_grenze": zeichen > GRENZE_ZEICHEN or len(inhalt) > GRENZE_ZEILEN}


def normalisieren(text: str, agent_id: str) -> str:
    """Setzt Titel und festen Satz an den Anfang; der Rumpf bleibt Zeile fuer Zeile erhalten."""
    _, rumpf = trennen(text)
    while rumpf and not rumpf[0].strip():
        rumpf.pop(0)
    while rumpf and not rumpf[-1].strip():
        rumpf.pop()
    return "%s\n\n%s\n\n%s\n" % (titel(agent_id), KOPF_SATZ, "\n".join(rumpf) if rumpf else PLATZHALTER)


def pfad(root: Path, agent_id: str) -> Path:
    return ad._agent_dir(root, agent_id) / DATEI


def lesen(root: Path, agent_id: str) -> str:
    path = pfad(root, agent_id)
    if path.is_symlink():
        raise ad.AgentsError("Gedaechtnisdatei darf kein Symlink sein")
    if not path.is_file():
        return ""
    with path.open("rb") as stream:
        return stream.read(LESE_LIMIT).decode("utf-8", "replace")


def pruefsumme(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ueber_grenze(root: Path, agent_id: str) -> Optional[dict[str, Any]]:
    """Messung mit Pruefsumme, wenn ``MEMORY.md`` die Grenze reisst; sonst ``None``."""
    text = lesen(root, agent_id)
    messung = messen(text)
    if not messung["ueber_grenze"]:
        return None
    return dict(messung, sha256=pruefsumme(text))


def welt_vault(root: Path) -> Optional[Path]:
    """Vault des Traegerhosts dieser Welt: ``brain.vault`` aus ``traeger.json``, sonst ``~/Knowledge``."""
    konfig = root / "traeger.json"
    raw: Any = None
    if konfig.is_file() and not konfig.is_symlink():
        try:
            data = json.loads(konfig.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "brain" in data:
                raw = (data.get("brain") or {}).get("vault") if isinstance(data.get("brain"), dict) else None
                if raw is None:
                    return None
        except (OSError, ValueError):
            raw = None
    try:
        return ab.vault_pfad(raw or str(Path.home() / "Knowledge"))
    except ab.BrainFehler:
        return None


def stand(root: Path, agent_id: str, vault: Optional[Path] = None, *, text: Optional[str] = None) -> dict[str, Any]:
    """Ansichtsfeld ``gedaechtnis``: Zeichen, Zeilen, Grenze und der Brain-Bereich des Agenten."""
    root = ad.world_path(str(root))
    messung = messen(lesen(root, agent_id) if text is None else text)
    try:
        rel = ab.bereich(root, agent_id, "eigen", vault)
    except ad.AgentsError:
        rel = None
    return {"zeichen": messung["zeichen"], "zeilen": messung["zeilen"], "grenze": dict(GRENZE),
            "ueber_grenze": messung["ueber_grenze"], "brain_bereich": rel,
            "brain_pfad": str(vault / rel) if vault is not None and rel else None}


def auswaehlen(text: str, auswahl: list[Any]) -> list[str]:
    """Zeilen des Rumpfs nach Nummer (1-basiert, wie ``nummeriert`` sie zeigt) oder genauem Text.

    Kopf, Ueberschriften und leere Zeilen werden nie verschoben."""
    if not isinstance(auswahl, list) or not auswahl or len(auswahl) > AUSWAHL_LIMIT:
        raise ad.AgentsError("zeilen muss eine Liste mit 1 bis %d Eintraegen sein" % AUSWAHL_LIMIT)
    _, rumpf = trennen(text)
    inhalt = _inhalt(rumpf)
    chosen: list[str] = []
    for item in auswahl:
        if isinstance(item, bool) or not isinstance(item, (int, str)):
            raise ad.AgentsError("zeilen nennt Zeilennummern oder den genauen Zeilentext")
        if isinstance(item, int):
            if not 1 <= item <= len(inhalt):
                raise ad.AgentsError("Zeile %d gibt es im Gedaechtnis nicht (1 bis %d)" % (item, len(inhalt)))
            line = inhalt[item - 1]
        else:
            wanted = item.strip()
            matches = [line for line in inhalt if line.strip() == wanted]
            if not matches:
                raise ad.AgentsError("Zeile nicht im Gedaechtnis gefunden: %s" % wanted[:80])
            line = matches[0]
        if line.lstrip().startswith("#"):
            raise ad.AgentsError("Ueberschriften bleiben im Gedaechtnis")
        if line not in chosen:
            chosen.append(line)
    return chosen


def nummeriert(text: str) -> str:
    """Rumpfzeilen mit Nummer, so wie ``auswaehlen`` sie zaehlt."""
    _, rumpf = trennen(text)
    return "\n".join("%d: %s" % (n, line) for n, line in enumerate(_inhalt(rumpf), 1))


def _neu_pruefen(neu: Any) -> list[str]:
    if neu is None:
        return []
    if not isinstance(neu, list) or len(neu) > NEU_LIMIT or not all(isinstance(item, str) for item in neu):
        raise ad.AgentsError("neu muss eine Liste mit hoechstens %d Zeilen sein" % NEU_LIMIT)
    lines = []
    for item in neu:
        line = " ".join(item.split())
        if not line:
            continue
        if len(line) > NEU_ZEILE_LIMIT:
            raise ad.AgentsError("Neue Zeile ist laenger als %d Zeichen" % NEU_ZEILE_LIMIT)
        lines.append(line if line.startswith(("- ", "#")) else "- " + line)
    return lines


def umschreiben(text: str, agent_id: str, verschoben: list[str], neu: list[str]) -> str:
    """``MEMORY.md`` ohne die verschobenen Zeilen, mit den neuen Zeilen unter ``## Lehren``."""
    _, rumpf = trennen(text)
    remaining = list(rumpf)
    for line in verschoben:
        if line in remaining:
            remaining.remove(line)
    remaining = [line for line in remaining if line.strip() != PLATZHALTER]
    if neu:
        if LEHREN_UEBERSCHRIFT not in remaining:
            while remaining and not remaining[-1].strip():
                remaining.pop()
            remaining += ["", LEHREN_UEBERSCHRIFT, ""]
        start = remaining.index(LEHREN_UEBERSCHRIFT)
        end = next((i for i in range(start + 1, len(remaining)) if remaining[i].startswith(("# ", "## "))),
                   len(remaining))
        while end > start + 1 and not remaining[end - 1].strip():
            end -= 1
        remaining[end:end] = neu
    # doppelte Leerzeilen, die das Entfernen hinterlaesst, zusammenfassen
    cleaned: list[str] = []
    for line in remaining:
        if not line.strip() and cleaned and not cleaned[-1].strip():
            continue
        cleaned.append(line)
    return normalisieren("\n".join(cleaned), agent_id)


def archivieren(root: Path, agent_id: str, auswahl: list[Any], vault: Any, *, zug: str,
                neu: Any = None, datum: Optional[str] = None, runner: Callable[..., Any] = subprocess.run,
                erwartet: Optional[str] = None) -> dict[str, Any]:
    """Verschiebt Zeilen aus ``MEMORY.md`` nach ``lehren.md`` im Brain und schreibt ``MEMORY.md`` neu.

    Reihenfolge: erst das Brain (Commit, Abgleich), dann ``MEMORY.md`` in einer Welttransaktion. Scheitert das
    Brain, bleibt ``MEMORY.md`` unveraendert, keine Zeile geht verloren. Der Zug steht als Marke in
    ``lehren.md``; ein zweiter Aufruf fuer denselben Zug haengt nichts doppelt an."""
    root = ad.world_path(str(root))
    ad.read_agent(root, agent_id)
    before = lesen(root, agent_id)
    if erwartet is not None and pruefsumme(before) != erwartet:
        raise ad.AgentsError("Gedaechtnis wurde inzwischen geaendert")
    lines = auswaehlen(before, auswahl)
    new_lines = _neu_pruefen(neu)
    brain = ab.lehren_anhaengen(vault, root, agent_id, lines, zug=zug, datum=datum, runner=runner)
    with ad.transaction(root):
        current = lesen(root, agent_id)
        after = umschreiben(current, agent_id, lines, new_lines)
        if after != current:
            ad._write_text(pfad(root, agent_id), after)
    messung = messen(after)
    return {"status": "angewendet", "verschoben": len(lines), "neu": len(new_lines), "brain": brain,
            "zeichen": messung["zeichen"], "zeilen": messung["zeilen"], "ueber_grenze": messung["ueber_grenze"],
            "sha256_vorher": pruefsumme(before), "sha256_nachher": pruefsumme(after)}


def lehren(text: str) -> list[str]:
    """Die Lehren im Rumpf: Aufzaehlungszeilen (``- ``), in Dateireihenfolge."""
    _, rumpf = trennen(text)
    return [line for line in _inhalt(rumpf) if line.startswith("- ")]


def bestand_archivieren(root: Path, agent_id: str, vault: Any, *, behalten: int = BEHALTEN_VORGABE,
                        datum: Optional[str] = None, runner: Callable[..., Any] = subprocess.run) -> dict[str, Any]:
    """Bestehender Agent: alle Lehren bis auf die letzten ``behalten`` nach ``lehren.md``; meldet die Groesse."""
    root = ad.world_path(str(root))
    before = lesen(root, agent_id)
    vorher = messen(before)
    alle = lehren(before)
    move = alle[:-behalten] if behalten > 0 else list(alle)
    if not move:
        return {"agent": agent_id, "status": "nichts", "verschoben": 0, "vorher": vorher, "nachher": vorher,
                "brain_bereich": ab.bereich(root, agent_id, "eigen", ab.vault_pfad(vault))}
    zug = "wb-welt-gedaechtnis-%s" % pruefsumme("\n".join(move))[:16]
    result = archivieren(root, agent_id, move, vault, zug=zug, datum=datum, runner=runner,
                         erwartet=pruefsumme(before))
    with ad.transaction(root):
        ad._append_history(root, agent_id, {
            "id": ad.derived_id("gedaechtnis-archiv", agent_id, zug), "time": ad.now(), "event": "gedaechtnis-archiv",
            "verschoben": result["verschoben"], "brain": result["brain"]["rel"], "commit": result["brain"]["commit"],
            "sync": result["brain"]["sync"].get("status"),
            "actor": {"id": "cli-operator", "verified": False, "source": "wb-welt gedaechtnis"}})
    nachher = messen(lesen(root, agent_id))
    return {"agent": agent_id, "status": "angewendet", "verschoben": result["verschoben"], "vorher": vorher,
            "nachher": nachher, "brain_bereich": ab.bereich(root, agent_id, "eigen", ab.vault_pfad(vault)),
            "brain": result["brain"]}


def cli(args: argparse.Namespace) -> int:
    """``wb-welt gedaechtnis <welt> [<agent>] [--archivieren] [--behalten N] [--vault P] [--json]``."""
    root = ad.world_path(args.world)
    agents = [ad.read_agent(root, args.agent)] if args.agent else ad.list_agents(root)
    vault_raw = args.vault or None
    try:
        vault = ab.vault_pfad(vault_raw) if vault_raw else welt_vault(root)
    except ab.BrainFehler as exc:
        raise ad.AgentsError(str(exc))
    results = []
    for agent in agents:
        if args.archivieren:
            if vault is None:
                raise ad.AgentsError("Kein Brain-Vault auf diesem Host; --vault nennt ihn")
            entry = bestand_archivieren(root, agent["id"], vault, behalten=args.behalten)
            entry["gedaechtnis"] = stand(root, agent["id"], vault)
        else:
            entry = {"agent": agent["id"], "gedaechtnis": stand(root, agent["id"], vault)}
        results.append(entry)
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0
    for entry in results:
        g = entry["gedaechtnis"]
        line = "%s: %d Zeichen, %d Zeilen (Grenze %d/%d)%s" % (
            entry["agent"], g["zeichen"], g["zeilen"], GRENZE_ZEICHEN, GRENZE_ZEILEN,
            ", ueber der Grenze" if g["ueber_grenze"] else "")
        if args.archivieren:
            sync = ((entry.get("brain") or {}).get("sync") or {})
            line += "; %d Lehren nach %s verschoben" % (entry["verschoben"], g["brain_bereich"] + "/lehren.md") \
                if entry["verschoben"] else "; nichts zu verschieben"
            if sync:
                line += " (Brain: %s%s)" % (sync.get("status"), ", " + sync["grund"] if sync.get("grund") else "")
        print(line)
        if g.get("brain_pfad"):
            print("  Brain: %s" % g["brain_pfad"])
    return 0


def parser_ergaenzen(sub: Any) -> None:
    """Unterbefehl ``gedaechtnis`` fuer ``wb-welt`` (agents_data.parser_for)."""
    p = sub.add_parser("gedaechtnis", help="Groesse des Gedaechtnisses; --archivieren verschiebt alte Lehren ins Brain")
    p.add_argument("world")
    p.add_argument("agent", nargs="?")
    p.add_argument("--archivieren", action="store_true")
    p.add_argument("--behalten", type=int, default=BEHALTEN_VORGABE)
    p.add_argument("--vault")
    p.add_argument("--json", action="store_true")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    parser_ergaenzen(sub)
    args = parser.parse_args(argv)
    try:
        return cli(args)
    except ad.AgentsError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


__all__ = ["GRENZE", "GRENZE_ZEICHEN", "GRENZE_ZEILEN", "KOPF_SATZ", "archivieren", "auswaehlen",
           "bestand_archivieren", "lehren", "messen", "normalisieren", "nummeriert", "stand", "trennen",
           "ueber_grenze", "umschreiben", "vorlage", "welt_vault"]


if __name__ == "__main__":
    raise SystemExit(main())
