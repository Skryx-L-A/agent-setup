#!/usr/bin/env python3
"""Read-only view of the skills of one world for the worlds view (Auftrag agentsui Nr. 4).

The inspector's skill tab and the ticket detail of a skill proposal read this, through
the core (app/src/main/welten.ts), the same way `wb-welt ansicht` feeds the rest of the
view.  Nothing here writes: no transaction, no recovery, no `skills.json`, not even the
lock file.  The world lock is held shared, like `world_snapshot`, so a running
acceptance is never seen half done; a writer holding it too long yields a read marked
`consistent: false`.

    agents_skills_ansicht.py <welt> [--bibliothek PFAD] [--letzte N] --json

Per agent: the skill directory from `agents/<id>/skills.json` (or, without that file,
resolved the same way `wb-skill liste --agent` does), each skill with its `SKILL.md`,
the skill and learning-step entries of the agent history and the token evaluation per
ticket kind from `evaluate_measurements`.  Per skill proposal ticket: the stored
proposal and its diff.  Plus the last entries of the world's `skill-verlauf.jsonl`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402
import agents_skills as sk  # noqa: E402

SKILL_MD_LIMIT = 16 * 1024
DIFF_LIMIT = 60 * 1024
HISTORY_LIMIT = 50
WORLD_LOG_LIMIT = 50


def _capped(path: Path, limit: int) -> tuple[str, bool]:
    if path.is_symlink() or not path.is_file():
        return "", False
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    return data[:limit].decode("utf-8", errors="replace"), len(data) > limit


def _directory(root: Path, agent_id: str, library: str | None) -> dict[str, Any]:
    stored = ad._read_optional_json(ad._agent_dir(root, agent_id) / "skills.json", "Skillverzeichnis")
    if isinstance(stored, dict) and isinstance(stored.get("skills"), list):
        return dict(stored, quelle="skills.json")
    return dict(sk.skill_directory(root, agent_id, library), quelle="berechnet")


def _skill_entry(root: Path, agent_id: str, entry: dict[str, Any], library: str | None) -> dict[str, Any]:
    item = {key: entry.get(key) for key in ("name", "ebene", "version", "description", "vorgeladen", "verdeckt", "pfad")}
    try:
        shown = sk.show_skill(root, entry["name"], agent_id, entry.get("ebene"), library)
        text = shown.get("skill_md") or ""
        item.update({"skill_md": text[:SKILL_MD_LIMIT], "gekuerzt": bool(shown.get("gekuerzt")) or len(text) > SKILL_MD_LIMIT,
                     "befunde": shown.get("befunde") or [], "dateien": sorted((shown.get("groessen") or {}).keys())})
        if shown.get("version") and entry.get("version") and shown["version"] != entry["version"]:
            item["veraltet"] = True  # skills.json lags behind the folder; `wb-skill verzeichnis` refreshes it
    except (ad.AgentsError, OSError, KeyError) as exc:
        item.update({"skill_md": "", "gekuerzt": False, "befunde": [{"stufe": "fehler", "text": str(exc)}], "dateien": []})
    return item


def _agent_view(root: Path, agent: dict[str, Any], library: str | None, last: int) -> dict[str, Any]:
    agent_id = agent["id"]
    view: dict[str, Any] = {"fehler": []}
    try:
        directory = _directory(root, agent_id, library)
        view.update({
            "quelle": directory.get("quelle"), "stand": directory.get("updated_at"),
            "skills": [_skill_entry(root, agent_id, entry, library) for entry in directory.get("skills") or []],
            "fehlend": list(directory.get("fehlend") or []),
            "ungueltig": [{"name": x.get("name"), "ebene": x.get("ebene"), "befunde": x.get("befunde") or []}
                          for x in directory.get("ungueltig") or []],
        })
    except (ad.AgentsError, OSError, ValueError) as exc:
        view.update({"quelle": None, "stand": None, "skills": [], "fehlend": [], "ungueltig": []})
        view["fehler"].append("Skills: %s" % exc)
    history = ad._read_optional_json(ad._agent_dir(root, agent_id) / "history.json", "Verlauf") or {}
    entries = [e for e in history.get("entries") or [] if isinstance(e, dict) and e.get("event") in ("skill", "lernschritt")]
    view["verlauf"] = entries[-HISTORY_LIMIT:]
    try:
        view["messung"] = sk.evaluate_measurements(root, agent_id, last)
    except (ad.AgentsError, OSError, ValueError) as exc:
        view["messung"] = {"agent": agent_id, "anzahl": 0, "letzte_n": last, "arten": {}, "fehlerhafte_zeilen": 0}
        view["fehler"].append("Messung: %s" % exc)
    return view


def _proposals(root: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for ticket in ad.list_tickets(root):
        if (ticket.get("limits") or {}).get("art") != "skill-vorschlag":
            continue
        try:
            proposal = sk.read_proposal(root, ticket["id"])
        except ad.AgentsError as exc:
            result[ticket["id"]] = {"fehler": str(exc)}
            continue
        diff, cut = _capped(ad.child(root, sk.PROPOSAL_DIR, ticket["id"]) / "diff.txt", DIFF_LIMIT)
        result[ticket["id"]] = {
            key: proposal.get(key) for key in ("skill", "agent", "ziel", "stand", "version", "basis_version",
                                               "beschreibung", "begruendung", "pruefer", "erstellt_at",
                                               "entschieden_at", "bemerkung", "grund")
        }
        result[ticket["id"]].update({"diff": diff, "diff_gekuerzt": cut,
                                     "entschieden_von": (proposal.get("entschieden_von") or {}).get("id")})
    return result


def _world_log(root: Path) -> list[dict[str, Any]]:
    path = root / sk.WORLD_LOG
    if path.is_symlink() or not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-WORLD_LOG_LIMIT:]
    entries = []
    for line in lines:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries


def skills_view(root: Path, library: str | None = None, last: int = 5) -> dict[str, Any]:
    root = ad.world_path(str(root))
    ad.read_world(root)  # a folder without world.json is no world
    with ad._shared_read(root) as consistent:
        agents = ad.list_agents(root)
        data = {
            "welt": str(root), "consistent": consistent, "bibliothek": str(sk.library_path(library)),
            "agenten": {agent["id"]: _agent_view(root, agent, library, last) for agent in agents},
            "vorschlaege": _proposals(root),
            "verlauf": _world_log(root),
        }
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agents_skills_ansicht.py", description="Skills einer Welt, nur lesend")
    parser.add_argument("world")
    parser.add_argument("--bibliothek")
    parser.add_argument("--letzte", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        data = skills_view(Path(args.world), args.bibliothek, args.letzte)
    except (ad.AgentsError, OSError, ValueError) as exc:
        print("agents_skills_ansicht: FEHLER - %s" % exc, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(data, ensure_ascii=False, sort_keys=True))
    else:
        for agent_id, view in data["agenten"].items():
            print("%s: %d Skills, %d Messungen" % (agent_id, len(view["skills"]), view["messung"].get("anzahl", 0)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
