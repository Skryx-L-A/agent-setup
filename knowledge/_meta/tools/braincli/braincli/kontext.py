"""`brain kontext start|prompt`: harness-neutraler Zugang zu SessionStart und Recall.

Duenne Huelle um die zwei bestehenden Hook-Skripte (ana-zugang Empfehlung 3,
brain-firmenniveau-plan Phase 2 "Ein Zugangsvertrag fuer alle Harnesses"):

- `brain kontext start`  -> `_meta/tools/session-context.sh`
- `brain kontext prompt` -> `_meta/tools/hooks/auto-recall.sh`

Die Skripte bleiben die eine Quelle der Logik; hier wird nur der Eingang
vereinheitlicht (Hook-JSON auf stdin wie bei Claude/Codex, oder Parameter
`--cwd`, `--session-id`, Prompttext) und der Ausgang geformt (Text, JSON oder
Hook-JSON mit `additionalContext`), dazu ein Budget. Ohne Budget und im
Textformat ist die Ausgabe byte-gleich mit dem Skript, wie Claude sie heute
bekommt.

Vertrag wie bei den Skripten: ein Hook darf nie scheitern. Jeder Fehler, jede
Zeitueberschreitung ergibt leere Ausgabe und Rueckgabewert 0.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[2]
START_SKRIPT = TOOLS_DIR / "session-context.sh"
PROMPT_SKRIPT = TOOLS_DIR / "hooks" / "auto-recall.sh"

# Harnesses, deren Hook-Ereignisnamen wir kennen. Der Wert ist nur fuer
# `--format hook` wichtig (hookEventName); die Textausgabe ist fuer alle gleich.
EREIGNIS = {"start": "SessionStart", "prompt": "UserPromptSubmit"}
HARNESSES = ("claude", "codex", "pi", "opencode", "cline", "roh")

KUERZ_HINWEIS = "[gekuerzt: {n} von {gesamt} Zeichen; voll: brain kontext {teil} ohne --max-zeichen]"


def _lies_stdin() -> str:
    """stdin nur lesen, wenn es kein Terminal ist (Handaufruf ohne Pipe)."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return ""
        return sys.stdin.read()
    except (OSError, ValueError):
        return ""


def _als_json(text: str) -> dict | None:
    if not text.strip():
        return None
    try:
        d = json.loads(text)
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def _str(d: dict | None, *keys: str) -> str:
    for k in keys:
        v = (d or {}).get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def kuerzen(text: str, max_zeichen: int | None, teil: str) -> tuple[str, bool]:
    """Auf hoechstens `max_zeichen` kuerzen, an einer Zeilengrenze, mit Hinweis.

    Der Hinweis zaehlt zum Budget. Ein Budget, in das nicht einmal der Hinweis
    passt, liefert nur den Hinweis (nie stillschweigend leer)."""
    if not max_zeichen or max_zeichen <= 0 or len(text) <= max_zeichen:
        return text, False
    gesamt = len(text)
    hinweis = KUERZ_HINWEIS.format(n=0, gesamt=gesamt, teil=teil)
    platz = max_zeichen - len(hinweis) - 1
    kopf = text[:max(platz, 0)]
    if "\n" in kopf:
        kopf = kopf[:kopf.rfind("\n") + 1]
    else:
        kopf = ""
    hinweis = KUERZ_HINWEIS.format(n=len(kopf), gesamt=gesamt, teil=teil)
    return kopf + hinweis + "\n", True


def treffer_begrenzen(text: str, max_treffer: int | None) -> str:
    """Recall-Block auf `max_treffer` Zeilen der Form `- Titel (...)` kuerzen.

    Der Formatierer schreibt Kopfzeilen und je Treffer genau eine `- `-Zeile.
    Bleibt kein Treffer, wird nichts ausgegeben (wie der Hook bei leerem Tor)."""
    if max_treffer is None or max_treffer < 0 or not text:
        return text
    zeilen = text.splitlines()
    treffer = [z for z in zeilen if z.startswith("- ")]
    if len(treffer) <= max_treffer:
        return text
    if max_treffer == 0:
        return ""
    erste = zeilen.index(treffer[0])
    return "\n".join(zeilen[:erste] + treffer[:max_treffer]) + "\n"


def _lauf(shell: str, skript: Path, stdin_text: str, cwd: str, env: dict, timeout: float) -> str:
    """Skript mit derselben Shell wie im Claude-Hook starten (`bash` fuer den Start,
    `sh` fuer den Recall, siehe ~/.claude/settings.json); stderr verworfen wie dort."""
    if not skript.is_file():
        return ""
    # Eigene Prozessgruppe: bei Zeitueberschreitung muessen auch Kindprozesse (brain search,
    # python3) weg, sonst halten sie stdout offen und die Huelle wartet trotz Frist weiter.
    try:
        proc = subprocess.Popen([shell, str(skript)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, env=env,
                                cwd=cwd if os.path.isdir(cwd) else None, start_new_session=True)
    except OSError:
        return ""
    try:
        out, _ = proc.communicate(stdin_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return ""
    return out or ""


def _ausgabe(text: str, fmt: str, ereignis: str, gekuerzt: bool, harness: str) -> str:
    if fmt == "text":
        return text
    if fmt == "json":
        return json.dumps({"text": text, "zeichen": len(text), "gekuerzt": gekuerzt,
                           "harness": harness, "ereignis": ereignis}, ensure_ascii=False) + "\n"
    # hook: Claude-/Codex-Form. Leerer Text -> gar keine Ausgabe (kein leerer Kontextblock).
    if not text.strip():
        return ""
    return json.dumps({"hookSpecificOutput": {"hookEventName": ereignis,
                                              "additionalContext": text}},
                      ensure_ascii=False) + "\n"


def start_text(cwd: str | None = None, session_id: str = "", source: str = "",
               hook_json: dict | None = None, roh_stdin: str = "",
               timeout: float = 15.0, skript: Path | None = None) -> str:
    """Text des SessionStart, wie `session-context.sh` ihn ausgibt.

    Das Skript liest aus dem Hook-JSON nur `source` und `session_id` (Dedup-Reset
    nach clear/compact). Kommt Hook-JSON ohne Ueberschreibung, geht es unveraendert
    durch; sonst wird es aus den Parametern gebaut."""
    env = dict(os.environ)
    if cwd:
        env["CLAUDE_PROJECT_DIR"] = cwd
    arbeitsordner = env.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if hook_json is not None and not (session_id or source):
        stdin_text = roh_stdin
    elif hook_json is not None or session_id or source:
        d = dict(hook_json or {})
        if session_id:
            d["session_id"] = session_id
        if source:
            d["source"] = source
        d.setdefault("hook_event_name", "SessionStart")
        d.setdefault("cwd", arbeitsordner)
        stdin_text = json.dumps(d)
    else:
        stdin_text = ""
    return _lauf("bash", skript or START_SKRIPT, stdin_text, arbeitsordner, env, timeout)


def prompt_text(prompt: str, cwd: str | None = None, session_id: str = "",
                timeout: float = 4.0, skript: Path | None = None) -> str:
    """Recall-Block wie `auto-recall.sh` ihn fuer diesen Prompt ausgibt."""
    if not prompt.strip():
        return ""
    arbeitsordner = cwd or os.getcwd()
    d = {"hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": arbeitsordner}
    if session_id:
        d["session_id"] = session_id
    return _lauf("sh", skript or PROMPT_SKRIPT, json.dumps(d, ensure_ascii=False), arbeitsordner,
                 dict(os.environ), timeout)


def cmd_start(args) -> int:
    try:
        roh = _lies_stdin() if not args.kein_stdin else ""
        d = _als_json(roh)
        # Im Claude-Hook setzt Claude CLAUDE_PROJECT_DIR; das Skript nimmt es vor pwd. Dann
        # bleibt es massgeblich, damit die Ausgabe gleich bleibt; sonst gilt `cwd` aus dem JSON.
        cwd = args.cwd or (None if os.environ.get("CLAUDE_PROJECT_DIR") else _str(d, "cwd")) or None
        text = start_text(cwd=cwd, session_id=args.session_id or "", source=args.source or "",
                          hook_json=d, roh_stdin=roh,
                          timeout=args.timeout)
        text, gekuerzt = kuerzen(text, args.max_zeichen, "start")
        sys.stdout.write(_ausgabe(text, args.format, EREIGNIS["start"], gekuerzt, args.harness))
    except Exception:  # noqa: BLE001 - Hook-Vertrag: nie scheitern
        pass
    return 0


def cmd_prompt(args) -> int:
    try:
        if args.text:
            prompt, d = " ".join(args.text), None
        else:
            roh = _lies_stdin() if not args.kein_stdin else ""
            d = _als_json(roh)
            # Claude/Codex: "prompt"; andere Harnesses oder Starter reichen Rohtext.
            prompt = _str(d, "prompt", "message", "input", "text") if d is not None else roh
        cwd = args.cwd or _str(d, "cwd") or None
        sid = args.session_id or _str(d, "session_id", "sessionID", "sessionId")
        text = prompt_text(prompt, cwd=cwd, session_id=sid, timeout=args.timeout)
        text = treffer_begrenzen(text, args.max_treffer)
        text, gekuerzt = kuerzen(text, args.max_zeichen, "prompt")
        sys.stdout.write(_ausgabe(text, args.format, EREIGNIS["prompt"], gekuerzt, args.harness))
    except Exception:  # noqa: BLE001 - Hook-Vertrag: nie scheitern
        pass
    return 0


def _gemeinsam(p) -> None:
    p.add_argument("--cwd", help="Arbeitsordner der Sitzung (sonst aus Hook-JSON, sonst aktueller Ordner)")
    p.add_argument("--session-id", default="", help="Sitzungskennung (Recall-Dedup je Kontextfenster)")
    p.add_argument("--harness", choices=HARNESSES, default="claude",
                   help="aufrufender Harness (nur Kennzeichnung im JSON; Text ist fuer alle gleich)")
    p.add_argument("--format", choices=("text", "json", "hook"), default="text",
                   help="text: wie der Claude-Hook; json: mit Zaehlern; hook: hookSpecificOutput.additionalContext")
    p.add_argument("--max-zeichen", type=int, default=None, help="Budget in Zeichen (Kuerzung an Zeilengrenze)")
    p.add_argument("--kein-stdin", action="store_true", help="stdin nicht lesen")


def add_parser(sub) -> None:
    p = sub.add_parser("kontext", help="harness-neutraler Sitzungskontext und Recall (Hook-Huelle)")
    ksub = p.add_subparsers(dest="kontextcmd", required=True)

    p_start = ksub.add_parser("start", help="SessionStart-Kontext (session-context.sh); Hook-JSON auf stdin")
    _gemeinsam(p_start)
    p_start.add_argument("--source", default="", help="startup|resume|clear|compact (setzt Dedup zurueck)")
    p_start.add_argument("--timeout", type=float, default=15.0)
    p_start.set_defaults(func=cmd_start)

    p_prompt = ksub.add_parser("prompt", help="Recall-Zeiger zu einem Prompt (auto-recall.sh)")
    p_prompt.add_argument("text", nargs="*", help="Prompttext (sonst stdin: Hook-JSON oder Rohtext)")
    _gemeinsam(p_prompt)
    p_prompt.add_argument("--max-treffer", type=int, default=None, help="hoechstens N Zeiger (Skript: 3)")
    p_prompt.add_argument("--timeout", type=float, default=4.0)
    p_prompt.set_defaults(func=cmd_prompt)
