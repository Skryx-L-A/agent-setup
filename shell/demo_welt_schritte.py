#!/usr/bin/env python3
"""Run one demo-world data step with a measured-human test fixture.

This helper is deliberately bounded to a caller-declared directory below the
operating system's temporary directory.  It must never become a general wrapper
around ``agents_data`` because its human measurement is a test fixture.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import agents_data as ad  # noqa: E402
import agents_controller as ac  # noqa: E402


def _inside(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def _werte(args: list[str], name: str) -> list[str]:
    """Read repeated argparse-style ``--name value`` and ``--name=value`` pairs."""
    result: list[str] = []
    prefix = name + "="
    for index, item in enumerate(args):
        if item.startswith(prefix):
            result.append(item[len(prefix):])
        elif item == name and index + 1 < len(args):
            result.append(args[index + 1])
    return result


def _controller_frage(world: Path, args: list[str]) -> int:
    """Create a demo question through the same run-bound controller as a real agent."""
    sender = (_werte(args, "--absender") or [""])[-1]
    role = (_werte(args, "--rolle") or [""])[-1]
    text = (_werte(args, "--text") or [""])[-1]
    question_id = (_werte(args, "--id") or [None])[-1]
    ticket_id = (_werte(args, "--ticket") or [None])[-1]
    recommendation = (_werte(args, "--empfehlung") or [None])[-1]
    controller = ac.AgentController(world, "demo-fragenlauf", lambda _binding: True)
    client = controller.bind_agent(sender, role)
    try:
        payload = {
            "text": text,
            "options": _werte(args, "--option"),
        }
        for name, value in (("question_id", question_id), ("recommendation", recommendation),
                            ("ticket_id", ticket_id)):
            if value is not None:
                payload[name] = value
        question = client.request("question.ask", payload)
        if "--json" in args:
            print(json.dumps(question, ensure_ascii=False))
        return 0
    except (ad.AgentsError, ac.ControllerError) as exc:
        print("demo_welt_schritte.py: %s" % exc, file=sys.stderr)
        return 2
    finally:
        client.close()
        controller.close()
        controller.join()


def _controller_agentenaktion(kind: str, world: Path, args: list[str]) -> int | None:
    """Run the two demo steps whose authority is an agent through its bound controller."""
    command = args[0]
    if (kind, command) == ("kanal", "senden") and _werte(args, "--id"):
        sender = (_werte(args, "--absender") or [""])[-1]
        role = (_werte(args, "--rolle") or [""])[-1]
        message_id = (_werte(args, "--id") or [""])[-1]
        payload = {
            "recipients": _werte(args, "--an"),
            "text": (_werte(args, "--text") or [""])[-1],
            "message_id": message_id,
        }
        ticket_id = (_werte(args, "--ticket") or [None])[-1]
        mark = (_werte(args, "--markierung") or [None])[-1]
        if ticket_id is not None:
            payload["ticket_id"] = ticket_id
        if mark is not None:
            payload["mark"] = mark
        if "--direkt" in args:
            payload["direct"] = True
        operation = "message.send"
    elif (kind, command) == ("agent", "antrag"):
        sender = (_werte(args, "--absender") or [""])[-1]
        role = (_werte(args, "--rolle") or [""])[-1]
        request_id = (_werte(args, "--id") or [""])[-1]
        raw = (_werte(args, "--entwurf") or [""])[-1]
        try:
            draft = json.loads(raw)
        except json.JSONDecodeError:
            print("demo_welt_schritte.py: --entwurf braucht JSON", file=sys.stderr)
            return 2
        payload = {"draft": draft, "request_id": request_id}
        operation = "agent.request"
    else:
        return None
    controller = ac.AgentController(world, "demo-agentenlauf", lambda _binding: True)
    client = controller.bind_agent(sender, role)
    try:
        result = client.request(operation, payload)
        if "--json" in args:
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ad.AgentsError, ac.ControllerError) as exc:
        print("demo_welt_schritte.py: %s" % exc, file=sys.stderr)
        return 2
    finally:
        client.close()
        controller.close()
        controller.join()


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] not in {"welt", "agent", "ticket", "kanal", "skill"}:
        print("demo_welt_schritte.py: ART UNTERBEFEHL WELT ... erwartet", file=sys.stderr)
        return 2
    raw_demo = os.environ.get("WB_DEMO_ROOT")
    if not raw_demo:
        print("demo_welt_schritte.py: WB_DEMO_ROOT fehlt", file=sys.stderr)
        return 2
    demo = Path(raw_demo).resolve()
    # Without TMPDIR (a run from `env -i`), Python falls back to /tmp while
    # macOS `mktemp -d` still answers with the per-user temp folder. Both are
    # the system's temp; the demo root must lie strictly inside one of them.
    system_temps = {Path(tempfile.gettempdir()).resolve()}
    if sys.platform == "darwin":
        try:
            user_temp = subprocess.run(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"],
                                       capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            user_temp = ""
        if user_temp:
            system_temps.add(Path(user_temp).resolve())
    if not any(demo != temp and _inside(demo, temp) for temp in system_temps):
        print("demo_welt_schritte.py: Demo-Wurzel liegt nicht unter dem temporaeren Systemordner",
              file=sys.stderr)
        return 2
    args = argv[2:]
    readonly_without_world = (argv[1], args[0]) in {("welt", "finden"), ("agent", "vorlagen")}
    if "--help" in args or readonly_without_world:
        if argv[1] == "skill":
            import agents_skills
            return agents_skills.main(args)
        return ad.run(argv[1], args)
    if len(args) < 2:
        print("demo_welt_schritte.py: Weltpfad fehlt", file=sys.stderr)
        return 2
    world = Path(args[1]).resolve()
    if not _inside(world, demo):
        print("demo_welt_schritte.py: Weltpfad liegt ausserhalb der Demo-Wurzel", file=sys.stderr)
        return 2

    original = ad._measured_human
    ad._measured_human = lambda: (True, "Test-Fixture: gemessener Mensch im Demo-Treiber")
    try:
        if argv[1] == "welt" and args[0] == "frage":
            return _controller_frage(world, args)
        controller_result = _controller_agentenaktion(argv[1], world, args)
        if controller_result is not None:
            return controller_result
        if argv[1] == "skill":
            import agents_skills
            return agents_skills.main(args)
        return ad.run(argv[1], args)
    finally:
        ad._measured_human = original


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
