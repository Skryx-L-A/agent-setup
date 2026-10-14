"""`brain abo-bruecke`: den Brain-Chat mit dem eigenen Abo beantworten.

Laeuft auf dem Rechner der Person, unter ihrem eigenen Login in den offiziellen
Programmen (BRAIN5-PLAN Entscheidung 28, Architekturentwurf 5.1):

- Claude-Abo:  `claude -p --output-format stream-json` (Claude Code)
- ChatGPT-Abo: `codex exec --json` (Codex CLI)
- Cline Pass:  `opencode run --format json` (Provider `cline-pass`)

Angemeldet wird nur in deren eigenem Ablauf (`claude`, `codex login`,
`opencode auth login`). Die Bruecke liest, speichert und sendet NIE
Zugangsdaten: sie ruft nur das Programm auf und meldet, ob ein Mini-Aufruf
("Antworte nur ok") gelungen ist. Sie entfernt `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` und `CODEX_API_KEY` aus der Umgebung
des Programms, damit wirklich das Abo und kein API-Schluessel benutzt wird.

Ablauf je Chat-Zug:
1. `POST /bruecke/auftraege/holen` mit dem Bruecken-Token (Long-Poll). Der
   Dienst gibt nur Auftraege der Person heraus, der der Token gehoert.
2. Programm in einem leeren, privaten Arbeitsordner starten. Werkzeuge: nur
   die Brain-Werkzeuge ueber einen kleinen MCP-Server dieser Bruecke
   (`brain abo-bruecke mcp`), der jeden Aufruf mit dem Werkzeug-Schluessel des
   Auftrags an den Dienst weitergibt; der Dienst fuehrt ihn mit den Rechten der
   Person aus. Keine Shell, keine Dateien, kein Web.
3. Text und Ende an `/bruecke/auftraege/<id>/ereignisse` streamen. Antwortet
   der Dienst 409 (Stopp in der App, Zeitlimit), wird das Programm beendet.

Kein Dauerprozess auf Vorrat: `--einmal`, `--bis-leer` oder `--dauer 2h`.
Der Token kommt aus `--token-datei` oder `BRAIN_ABO_TOKEN`, nie von der
Kommandozeile (waere in `ps` sichtbar).
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

HTTP_TIMEOUT = 30.0
WARTEN = 25.0
SENDE_TAKT = 0.15
LEBENSZEICHEN = 5.0
PRUEF_TIMEOUT = 120.0
PRUEF_TTL = 12 * 3600.0
MODELL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$")
ABO_FREMDE_SCHLUESSEL = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY",
                         "CODEX_API_KEY")
MCP_NAME = "brain"
# Eingebaute Werkzeuge von Claude Code, die die Bruecke zusaetzlich verbietet
# (`--tools ""` schaltet sie ohnehin ab).
CLAUDE_VERBOTEN = ("Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "WebFetch",
                   "WebSearch", "Task", "Agent", "TodoWrite", "BashOutput", "KillShell")
# Codex-Funktionen, die ueber Shell, Browser oder Rechner gehen.
CODEX_AUS = ("shell_tool", "unified_exec", "apps", "browser_use", "computer_use")
OPENCODE_AGENT = "brainchat"
OPENCODE_VORGABE = "cline-pass/cline-pass/glm-5.3-flash"
PRUEF_TEXT = "Antworte nur ok"


class DienstFehler(Exception):
    def __init__(self, status: int | None, text: str) -> None:
        super().__init__(f"HTTP {status}: {text}" if status else text)
        self.status = status


def dienst_post(base: str, path: str, token: str, body: dict, *,
                timeout: float = HTTP_TIMEOUT, versuche: int = 3) -> tuple[int, dict | None]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last: DienstFehler | None = None
    for attempt in range(versuche):
        req = urllib.request.Request(
            base.rstrip("/") + path, data=data, method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                     "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code < 500:
                raise DienstFehler(exc.code, detail) from None
            last = DienstFehler(exc.code, detail)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = DienstFehler(None, f"Dienst nicht erreichbar: {type(exc).__name__}")
        if attempt + 1 < versuche:
            time.sleep(min(4.0, 0.5 * 2 ** attempt))
    raise last or DienstFehler(None, "unbekannter Fehler")


# ---------------------------------------------------------------------------
# Ausgabe der Programme -> Ereignisse fuer den Dienst
# ---------------------------------------------------------------------------

def _anmeldefehler(text: str) -> bool:
    t = text.lower()
    return any(x in t for x in ("login", "log in", "logged in", "authenticat", "unauthorized",
                                "401", "credential", "not signed", "api key"))


def _fehler(code: str, text: str) -> dict:
    return {"art": "fehler", "code": code, "text": text}


ANMELDEN = {
    "claude": "Claude Code ist auf diesem Rechner nicht angemeldet. Einmal `claude` starten und "
              "mit dem eigenen Konto anmelden.",
    "codex": "Codex ist auf diesem Rechner nicht angemeldet. Einmal `codex login` ausfuehren.",
    "opencode": "opencode ist fuer Cline Pass nicht angemeldet. Einmal `opencode auth login` "
                "ausfuehren.",
}


class Parser:
    programm = ""

    def __init__(self) -> None:
        self.fertig = False            # ende/fehler bereits erzeugt
        self.werkzeug_start = False    # Puffer jetzt senden (Reihenfolge Text vor Werkzeug)
        self.text_gesehen = False

    def zeile(self, obj: dict) -> list[dict]:
        raise NotImplementedError

    def _text(self, text: str, absatz: bool = False) -> list[dict]:
        if not text:
            return []
        if absatz and self.text_gesehen:
            text = "\n\n" + text
        self.text_gesehen = True
        return [{"art": "text", "text": text}]

    def abschluss(self, rc: int, stderr: str) -> list[dict]:
        if self.fertig:
            return []
        self.fertig = True
        if rc == 0:
            return [{"art": "ende", "grund": "fertig", "nutzung": None}]
        if _anmeldefehler(stderr):
            return [_fehler("nicht_angemeldet", ANMELDEN[self.programm])]
        return [_fehler("programm_fehler", f"{PROGRAMME[self.programm].name}: das Programm "
                                           f"endete mit Fehler {rc}.")]


class ClaudeParser(Parser):
    """`claude -p --output-format stream-json --verbose --include-partial-messages`:
    Textstuecke aus `stream_event`/`text_delta`; volle `assistant`-Nachrichten
    nur, wenn fuer diese Nachricht keine Stuecke kamen; `result` beendet."""
    programm = "claude"

    def __init__(self) -> None:
        super().__init__()
        self._nachricht: str | None = None
        self._mit_stuecken: set[str] = set()

    def zeile(self, obj: dict) -> list[dict]:
        typ = obj.get("type")
        if typ == "stream_event":
            ev = obj.get("event") or {}
            et = ev.get("type")
            if et == "message_start":
                self._nachricht = (ev.get("message") or {}).get("id")
            elif et == "content_block_start" and (ev.get("content_block") or {}).get("type") == "tool_use":
                self.werkzeug_start = True
            elif et == "content_block_delta":
                delta = ev.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    if self._nachricht:
                        self._mit_stuecken.add(self._nachricht)
                    return self._text(delta["text"])
            return []
        if typ == "assistant":
            msg = obj.get("message") or {}
            if msg.get("id") in self._mit_stuecken:
                return []
            out: list[dict] = []
            for block in msg.get("content") or []:
                if block.get("type") == "text":
                    out += self._text(block.get("text") or "")
                elif block.get("type") == "tool_use":
                    self.werkzeug_start = True
            return out
        if typ == "result":
            self.fertig = True
            if obj.get("is_error") or str(obj.get("subtype", "")).startswith("error"):
                text = str(obj.get("result") or "")
                if obj.get("subtype") == "error_max_turns":
                    return [{"art": "ende", "grund": "max_runden", "nutzung": _claude_nutzung(obj)}]
                if obj.get("api_error_status") in (401, 403) or _anmeldefehler(text):
                    return [_fehler("nicht_angemeldet", ANMELDEN["claude"])]
                if obj.get("api_error_status") == 429 or "limit" in text.lower():
                    return [_fehler("limit", "Das Claude-Abo meldet ein Nutzungslimit. Bitte "
                                             "spaeter erneut versuchen.")]
                return [_fehler("programm_fehler", "Claude Code meldet einen Fehler.")]
            return [{"art": "ende", "grund": "fertig", "nutzung": _claude_nutzung(obj)}]
        return []


def _claude_nutzung(obj: dict) -> dict | None:
    u = obj.get("usage")
    if not isinstance(u, dict):
        return None
    return {k: int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens")}


class CodexParser(Parser):
    """`codex exec --json`: `item.completed` mit `agent_message` traegt Text,
    `turn.completed` beendet mit Nutzung, `turn.failed`/`error` sind Fehler."""
    programm = "codex"

    def zeile(self, obj: dict) -> list[dict]:
        typ = obj.get("type")
        item = obj.get("item") or {}
        if typ == "item.started" and item.get("type") == "mcp_tool_call":
            self.werkzeug_start = True
            return []
        if typ == "item.completed" and item.get("type") == "agent_message":
            return self._text(str(item.get("text") or ""), absatz=True)
        if typ == "turn.completed":
            self.fertig = True
            u = obj.get("usage") or {}
            return [{"art": "ende", "grund": "fertig", "nutzung": {
                "input_tokens": int(u.get("input_tokens") or 0),
                "output_tokens": int(u.get("output_tokens") or 0),
                "cache_read_input_tokens": int(u.get("cached_input_tokens") or 0)}}]
        if typ in ("turn.failed", "error"):
            self.fertig = True
            err = obj.get("error") if isinstance(obj.get("error"), dict) else {}
            text = str(err.get("message") or obj.get("message") or "")
            if _anmeldefehler(text):
                return [_fehler("nicht_angemeldet", ANMELDEN["codex"])]
            if "limit" in text.lower():
                return [_fehler("limit", "Das ChatGPT-Abo meldet ein Nutzungslimit. Bitte spaeter "
                                         "erneut versuchen.")]
            return [_fehler("programm_fehler", "Codex meldet einen Fehler.")]
        return []


class OpencodeParser(Parser):
    """`opencode run --format json`: `text`-Teile, `tool_use`, `step_finish`
    (Tokens je Schritt), `error`. Das Ende ist das Prozessende."""
    programm = "opencode"

    def __init__(self) -> None:
        super().__init__()
        self.nutzung = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0}

    def zeile(self, obj: dict) -> list[dict]:
        typ = obj.get("type")
        part = obj.get("part") or {}
        if typ == "text":
            return self._text(str(part.get("text") or ""), absatz=True)
        if typ == "tool_use":
            self.werkzeug_start = True
            return []
        if typ == "step_finish":
            tok = part.get("tokens") or {}
            self.nutzung["input_tokens"] += int(tok.get("input") or 0)
            self.nutzung["output_tokens"] += int(tok.get("output") or 0)
            self.nutzung["cache_read_input_tokens"] += int((tok.get("cache") or {}).get("read") or 0)
            return []
        if typ == "error":
            self.fertig = True
            err = obj.get("error") or {}
            text = json.dumps(err) if isinstance(err, dict) else str(err)
            if _anmeldefehler(text):
                return [_fehler("nicht_angemeldet", ANMELDEN["opencode"])]
            return [_fehler("programm_fehler", "opencode meldet einen Fehler.")]
        return []

    def abschluss(self, rc: int, stderr: str) -> list[dict]:
        if not self.fertig and rc == 0:
            self.fertig = True
            return [{"art": "ende", "grund": "fertig", "nutzung": dict(self.nutzung)}]
        return super().abschluss(rc, stderr)


# ---------------------------------------------------------------------------
# Programme
# ---------------------------------------------------------------------------

@dataclass
class Aufruf:
    argv: list[str]
    env: dict[str, str]
    stdin: str


@dataclass
class Programm:
    id: str
    name: str
    befehl: str
    modelle: list[str] = field(default_factory=list)
    vorgabe: str = ""

    def parser(self) -> Parser:
        return {"claude": ClaudeParser, "codex": CodexParser, "opencode": OpencodeParser}[self.id]()

    def aufruf(self, befehl: list[str], modell: str, system: str, prompt: str,
               mcp: list[str] | None, werkzeuge: list[str], ordner: Path,
               max_runden: int) -> Aufruf:
        env = {k: v for k, v in os.environ.items() if k not in ABO_FREMDE_SCHLUESSEL}
        if self.id == "claude":
            argv = [*befehl, "-p", "--output-format", "stream-json", "--verbose",
                    "--include-partial-messages", "--model", modell, "--tools", "",
                    "--setting-sources", "", "--no-session-persistence", "--strict-mcp-config"]
            if mcp:
                datei = ordner / "mcp.json"
                _privat_schreiben(datei, json.dumps({"mcpServers": {MCP_NAME: {
                    "type": "stdio", "command": mcp[0], "args": mcp[1:]}}}))
                argv += ["--mcp-config", str(datei), "--allowedTools",
                         ",".join(f"mcp__{MCP_NAME}__{w}" for w in werkzeuge)]
            argv += ["--disallowedTools", ",".join(CLAUDE_VERBOTEN), "--system-prompt", system,
                     "--max-turns", str(max_runden + 2)]
            return Aufruf(argv, env, prompt)
        if self.id == "codex":
            argv = [*befehl, "exec", "--json", "--ephemeral", "--skip-git-repo-check",
                    "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"]
            for f in CODEX_AUS:
                argv += ["--disable", f]
            argv += ["-c", 'web_search="disabled"', "-c", 'approval_policy="never"']
            if mcp:
                argv += ["-c", f"mcp_servers.{MCP_NAME}.command={json.dumps(mcp[0])}",
                         "-c", f"mcp_servers.{MCP_NAME}.args={json.dumps(mcp[1:])}",
                         "-c", f'mcp_servers.{MCP_NAME}.default_tools_approval_mode="approve"']
            argv += ["-m", modell, "-C", str(ordner / "arbeit"), "-"]
            # Codex kennt keinen eigenen System-Prompt fuer exec: Regeln vor die Frage.
            return Aufruf(argv, env, f"<regeln>\n{system}\n</regeln>\n\n{prompt}")
        # opencode: eigener Agent nur fuer diesen Aufruf, alle Werkzeuge aus ausser Brain.
        cfg: dict = {"agent": {OPENCODE_AGENT: {
            "mode": "primary", "prompt": system,
            "tools": {"*": False, **({f"{MCP_NAME}_*": True} if mcp else {})}}}}
        if mcp:
            cfg["mcp"] = {MCP_NAME: {"type": "local", "command": mcp, "enabled": True}}
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(cfg)
        argv = [*befehl, "run", "--format", "json", "--agent", OPENCODE_AGENT, "-m", modell]
        return Aufruf(argv, env, prompt)


PROGRAMME: dict[str, Programm] = {
    "claude": Programm("claude", "Claude Code", "claude", ["sonnet", "opus", "haiku"], "sonnet"),
    "codex": Programm("codex", "Codex", "codex", ["gpt-6-sol", "gpt-6-luna"], "gpt-6-sol"),
    "opencode": Programm("opencode", "opencode (Cline Pass)", "opencode", [OPENCODE_VORGABE],
                         OPENCODE_VORGABE),
}


def _privat_schreiben(pfad: Path, text: str) -> None:
    fd = os.open(pfad, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


def verlauf_text(nachrichten: list[dict]) -> str:
    """Verlauf aus der App als eine Eingabe (die Programme nehmen im
    Einmal-Modus nur eine Nachricht)."""
    if len(nachrichten) == 1:
        return nachrichten[0]["text"]
    zeilen = ["Bisheriger Verlauf dieser Unterhaltung (nur zur Einordnung):", "<verlauf>"]
    for n in nachrichten[:-1]:
        wer = "Person" if n.get("rolle") == "user" else "Assistent"
        zeilen.append(f"{wer}: {n.get('text', '')}")
    zeilen += ["</verlauf>", "", "Neue Nachricht der Person:", nachrichten[-1]["text"]]
    return "\n".join(zeilen)


# ---------------------------------------------------------------------------
# Programm ausfuehren (Auftrag oder Mini-Pruefung)
# ---------------------------------------------------------------------------

def _stoppen(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        proc.wait(timeout=5)


def programm_laufen(aufruf: Aufruf, parser: Parser, ordner: Path, *, zeitlimit: float,
                    senden, lebenszeichen: float = LEBENSZEICHEN,
                    takt: float = SENDE_TAKT) -> str:
    """Programm starten, Ausgabe parsen, Ereignisse gebuendelt ueber `senden(liste)`
    abgeben. `senden` wirft `DienstFehler(409)`, wenn der Auftrag nicht mehr
    laeuft. Liefert "fertig", "abgebrochen" oder "zeitlimit"."""
    arbeit = ordner / "arbeit"
    arbeit.mkdir(exist_ok=True)
    proc = subprocess.Popen(aufruf.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1, cwd=str(arbeit),
                            env=aufruf.env, start_new_session=True)
    zeilen: queue.Queue = queue.Queue()
    fehlerzeilen: deque = deque(maxlen=30)

    def eingabe():
        try:
            proc.stdin.write(aufruf.stdin)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def lesen():
        for line in iter(proc.stdout.readline, ""):
            zeilen.put(line)
        zeilen.put(None)

    def fehler_lesen():
        for line in iter(proc.stderr.readline, ""):
            fehlerzeilen.append(line.rstrip("\n")[:500])

    threads = [threading.Thread(target=f, daemon=True) for f in (eingabe, lesen, fehler_lesen)]
    for t in threads:
        t.start()
    puffer: list[dict] = []
    ende = time.monotonic() + zeitlimit
    gesendet = time.monotonic()
    ergebnis = "fertig"
    try:
        offen = True
        while offen:
            try:
                item = zeilen.get(timeout=0.05)
            except queue.Empty:
                item = ""
            if item is None:
                offen = False
            elif item:
                try:
                    obj = json.loads(item)
                except ValueError:
                    obj = None
                if isinstance(obj, dict):
                    puffer += parser.zeile(obj)
            jetzt = time.monotonic()
            if jetzt > ende:
                ergebnis = "zeitlimit"
                _stoppen(proc)
                puffer.append(_fehler("zeitlimit", "Das Programm hat zu lange gebraucht und wurde "
                                                   "beendet."))
                parser.fertig = True
                break
            if (puffer and (parser.werkzeug_start or parser.fertig or jetzt - gesendet >= takt)) \
                    or jetzt - gesendet >= lebenszeichen:
                parser.werkzeug_start = False
                senden(puffer)
                puffer = []
                gesendet = jetzt
        if ergebnis == "fertig":
            rc = proc.wait()
            for t in threads[1:]:
                t.join(timeout=5)
            puffer += parser.abschluss(rc, "\n".join(fehlerzeilen))
            if rc != 0 and fehlerzeilen:
                print("brain abo-bruecke: Programm-Ausgabe (stderr, gekuerzt):\n  "
                      + "\n  ".join(list(fehlerzeilen)[-8:]), file=sys.stderr)
        if puffer:
            senden(puffer)
    except DienstFehler as exc:
        if exc.status != 409:
            raise
        ergebnis = "abgebrochen"
    finally:
        _stoppen(proc)
    return ergebnis


def auftrag_ausfuehren(dienst: str, token: str, auftrag: dict, *,
                       befehle: dict[str, list[str]], mcp_befehl: list[str]) -> str:
    aid = auftrag["id"]

    def senden(ereignisse: list[dict]) -> None:
        dienst_post(dienst, f"/bruecke/auftraege/{aid}/ereignisse", token,
                    {"ereignisse": ereignisse})

    programm = PROGRAMME.get(auftrag.get("programm", ""))
    if programm is None or programm.id not in befehle:
        senden([_fehler("programm_nicht_verfuegbar",
                        "Dieses Programm ist auf dem Rechner mit der Bruecke nicht verfuegbar.")])
        return "fehler"
    modell = auftrag.get("modell") or programm.vorgabe
    if not isinstance(modell, str) or not MODELL_RE.match(modell) or \
            (programm.modelle and modell not in programm.modelle):
        senden([_fehler("modell_unbekannt", f"{programm.name} bietet das Modell nicht an.")])
        return "fehler"
    nachrichten = [n for n in auftrag.get("nachrichten") or [] if isinstance(n, dict)]
    if not nachrichten:
        senden([_fehler("anfrage_leer", "Der Auftrag enthaelt keine Nachricht.")])
        return "fehler"
    werkzeuge = [w for w in auftrag.get("werkzeuge") or [] if isinstance(w, dict) and w.get("name")]
    ordner = Path(tempfile.mkdtemp(prefix="brain-abo-"))
    try:
        datei = ordner / "auftrag.json"
        _privat_schreiben(datei, json.dumps({
            "dienst": dienst, "auftrag": aid, "schluessel": auftrag["werkzeug_schluessel"],
            "werkzeuge": werkzeuge}))
        aufruf = programm.aufruf(befehle[programm.id], modell, auftrag.get("system") or "",
                                 verlauf_text(nachrichten), [*mcp_befehl, "--auftrag-datei", str(datei)],
                                 [w["name"] for w in werkzeuge], ordner,
                                 int(auftrag.get("max_runden") or 8))
        return programm_laufen(aufruf, programm.parser(), ordner,
                               zeitlimit=float(auftrag.get("zeitlimit_s") or 600), senden=senden)
    finally:
        shutil.rmtree(ordner, ignore_errors=True)


# ---------------------------------------------------------------------------
# Verfuegbarkeit: Programm im PATH und Mini-Aufruf gelungen (nie Zugangsdaten lesen)
# ---------------------------------------------------------------------------

def _cache_datei() -> Path:
    basis = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return basis / "brain" / "abo-bruecke.json"


def opencode_modelle(befehl: list[str]) -> list[str]:
    """Modelle des Providers cline-pass aus `opencode models cline-pass` (nur Namen)."""
    try:
        out = subprocess.run([*befehl, "models", "cline-pass"], capture_output=True, text=True,
                             timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    return [z.strip() for z in out.stdout.splitlines()
            if z.strip().startswith("cline-pass/") and MODELL_RE.match(z.strip())]


def mini_pruefung(programm: Programm, befehl: list[str], modell: str) -> bool:
    ordner = Path(tempfile.mkdtemp(prefix="brain-abo-pruef-"))
    ergebnisse: list[dict] = []
    try:
        aufruf = programm.aufruf(befehl, modell, "Du bist ein knapper Assistent.", PRUEF_TEXT, None,
                                 [], ordner, 1)
        programm_laufen(aufruf, programm.parser(), ordner, zeitlimit=PRUEF_TIMEOUT,
                        senden=ergebnisse.extend, lebenszeichen=3600)
    except OSError:
        return False
    finally:
        shutil.rmtree(ordner, ignore_errors=True)
    hat_text = any(e["art"] == "text" and e["text"].strip() for e in ergebnisse)
    return hat_text and not any(e["art"] == "fehler" for e in ergebnisse)


def programme_ermitteln(befehle: dict[str, list[str]], *, neu: bool = False,
                        ohne_pruefung: bool = False, ausgabe=print) -> list[dict]:
    """Meldung fuer den Dienst: je Programm verfuegbar/angemeldet/Modelle."""
    cache_datei = _cache_datei()
    try:
        cache = json.loads(cache_datei.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    meldung = []
    for pid, programm in PROGRAMME.items():
        befehl = befehle.get(pid)
        if befehl is None:
            continue
        verfuegbar = shutil.which(befehl[0]) is not None
        modelle, vorgabe = list(programm.modelle), programm.vorgabe
        if verfuegbar and pid == "opencode":
            modelle = opencode_modelle(befehl) or modelle
            vorgabe = vorgabe if vorgabe in modelle else modelle[0]
            programm.modelle, programm.vorgabe = modelle, vorgabe
        eintrag = cache.get(pid) if isinstance(cache.get(pid), dict) else {}
        frisch = eintrag.get("befehl") == befehl and time.time() - float(eintrag.get("ts") or 0) < PRUEF_TTL
        if not verfuegbar:
            angemeldet, geprueft = False, None
        elif ohne_pruefung:
            angemeldet, geprueft = True, None
        elif frisch and not neu:
            angemeldet, geprueft = bool(eintrag.get("angemeldet")), eintrag.get("geprueft_am")
        else:
            ausgabe(f"brain abo-bruecke: pruefe {programm.name} mit einem Mini-Aufruf ...")
            angemeldet = mini_pruefung(programm, befehl, vorgabe)
            geprueft = datetime.now(UTC).isoformat(timespec="seconds")
            cache[pid] = {"befehl": befehl, "angemeldet": angemeldet, "geprueft_am": geprueft,
                          "ts": time.time()}
        meldung.append({"id": pid, "verfuegbar": verfuegbar, "angemeldet": angemeldet,
                        "modelle": modelle, "vorgabe": vorgabe, "geprueft_am": geprueft})
    try:
        cache_datei.parent.mkdir(parents=True, exist_ok=True)
        _privat_schreiben(cache_datei, json.dumps(cache))
    except OSError:
        pass
    return meldung


# ---------------------------------------------------------------------------
# MCP-Server (wird vom Programm gestartet, nicht von Hand)
# ---------------------------------------------------------------------------

def mcp_server(auftrag_datei: Path) -> int:
    import asyncio

    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    daten = json.loads(Path(auftrag_datei).read_text(encoding="utf-8"))
    werkzeuge = daten.get("werkzeuge") or []
    server: Server = Server(MCP_NAME)

    @server.list_tools()
    async def _liste() -> list[types.Tool]:
        return [types.Tool(name=w["name"], description=w.get("description") or "",
                           inputSchema=w.get("input_schema") or {"type": "object"})
                for w in werkzeuge]

    def _aufrufen(name: str, eingabe: dict) -> dict:
        try:
            _, body = dienst_post(daten["dienst"], f"/bruecke/auftraege/{daten['auftrag']}/werkzeug",
                                  daten["schluessel"], {"name": name, "eingabe": eingabe},
                                  timeout=120, versuche=2)
            return body or {"text": "Fehler: leere Antwort des Brain-Dienstes", "fehler": True}
        except DienstFehler as exc:
            if exc.status in (401, 409):
                return {"text": "Fehler: Dieser Chat-Zug ist beendet.", "fehler": True}
            return {"text": "Fehler: Der Brain-Dienst ist nicht erreichbar.", "fehler": True}

    @server.call_tool(validate_input=False)
    async def _aufruf(name: str, arguments: dict | None) -> types.CallToolResult:
        erg = await asyncio.to_thread(_aufrufen, name, arguments or {})
        return types.CallToolResult(content=[types.TextContent(type="text", text=str(erg.get("text")))],
                                    isError=bool(erg.get("fehler")))

    async def main() -> None:
        async with stdio_server() as (lesen, schreiben):
            await server.run(lesen, schreiben, server.create_initialization_options())

    asyncio.run(main())
    return 0


# ---------------------------------------------------------------------------
# Kommandozeile
# ---------------------------------------------------------------------------

DAUER_RE = re.compile(r"^(\d+(?:\.\d+)?)([smh]?)$")


def dauer_sekunden(text: str) -> float:
    m = DAUER_RE.match(text.strip().lower())
    if not m:
        raise ValueError(f"Dauer {text!r}: z.B. 90m, 2h, 3600s")
    faktor = {"": 60, "s": 1, "m": 60, "h": 3600}[m.group(2)]
    return float(m.group(1)) * faktor


def _token(args) -> str:
    if args.token_datei:
        path = Path(args.token_datei).expanduser()
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            print(f"brain abo-bruecke: Warnung: {path} ist fuer andere lesbar ({oct(mode)}), "
                  "besser chmod 600", file=sys.stderr)
        return path.read_text(encoding="utf-8").strip()
    return os.environ.get("BRAIN_ABO_TOKEN", "").strip()


def _befehle(args) -> dict[str, list[str]]:
    wahl = [p.strip() for p in (args.programme or ",".join(PROGRAMME)).split(",") if p.strip()]
    unbekannt = [p for p in wahl if p not in PROGRAMME]
    if unbekannt:
        raise ValueError(f"unbekannte Programme: {', '.join(unbekannt)}")
    eigene = {"claude": args.claude_befehl, "codex": args.codex_befehl,
              "opencode": args.opencode_befehl}
    return {p: (eigene[p].split() if eigene[p] else [PROGRAMME[p].befehl]) for p in wahl}


def _mcp_befehl() -> list[str]:
    return [sys.executable, "-m", "braincli.abo_bruecke", "mcp"]


def run(args) -> int:
    if args.aktion == "mcp":
        if not args.auftrag_datei:
            print("brain abo-bruecke mcp: --auftrag-datei fehlt", file=sys.stderr)
            return 2
        return mcp_server(Path(args.auftrag_datei))
    try:
        befehle = _befehle(args)
    except ValueError as exc:
        print(f"brain abo-bruecke: {exc}", file=sys.stderr)
        return 2
    if args.aktion == "pruefen":
        for p in programme_ermitteln(befehle, neu=True):
            status = ("angemeldet" if p["angemeldet"] else "nicht angemeldet") if p["verfuegbar"] \
                else "nicht installiert"
            print(f"{PROGRAMME[p['id']].name}: {status}"
                  + (f" (Modelle: {', '.join(p['modelle'][:6])})" if p["verfuegbar"] else ""))
        return 0

    if not (args.einmal or args.bis_leer or args.dauer):
        print("brain abo-bruecke: nur mit --einmal, --bis-leer oder --dauer (kein Dauerprozess)",
              file=sys.stderr)
        return 2
    try:
        dauer = dauer_sekunden(args.dauer) if args.dauer else None
    except ValueError as exc:
        print(f"brain abo-bruecke: {exc}", file=sys.stderr)
        return 2
    dienst = args.dienst or os.environ.get("BRAIN_DIENST_URL", "")
    if not dienst:
        print("brain abo-bruecke: --dienst oder BRAIN_DIENST_URL fehlt", file=sys.stderr)
        return 2
    try:
        token = _token(args)
    except OSError as exc:
        print(f"brain abo-bruecke: Token-Datei nicht lesbar: {type(exc).__name__}", file=sys.stderr)
        return 2
    if not token:
        print("brain abo-bruecke: kein Token (--token-datei oder BRAIN_ABO_TOKEN)", file=sys.stderr)
        return 2
    maschine = args.maschine or socket.gethostname().split(".")[0]
    programme = programme_ermitteln(befehle, neu=args.neu_pruefen, ohne_pruefung=args.ohne_pruefung)
    bereit = [PROGRAMME[p["id"]].name for p in programme if p["verfuegbar"] and p["angemeldet"]]
    if not bereit:
        print("brain abo-bruecke: kein Programm ist installiert und angemeldet "
              "(claude, codex, opencode). `brain abo-bruecke pruefen` zeigt den Stand.",
              file=sys.stderr)
        return 3
    print(f"brain abo-bruecke: bereit mit {', '.join(bereit)}"
          + (f" fuer {args.dauer}" if dauer else ""))
    befehle = {p["id"]: befehle[p["id"]] for p in programme if p["verfuegbar"] and p["angemeldet"]}
    schluss = time.monotonic() + dauer if dauer else None
    warten = max(0.0, min(args.warten, 30.0))
    erledigt, rc = 0, 0
    stop = {"jetzt": False}

    def beenden(signum, _frame):
        stop["jetzt"] = True
        raise KeyboardInterrupt

    alte = {}
    try:
        alte = {s: signal.signal(s, beenden) for s in (signal.SIGTERM,)}
    except ValueError:
        pass
    try:
        while not stop["jetzt"]:
            if schluss is not None:
                rest = schluss - time.monotonic()
                if rest <= 0:
                    break
                w = min(warten, rest)
            else:
                w = warten
            try:
                status, auftrag = dienst_post(dienst, "/bruecke/auftraege/holen", token,
                                              {"warten": w, "maschine": maschine,
                                               "programme": programme}, timeout=w + HTTP_TIMEOUT)
            except DienstFehler as exc:
                if exc.status == 401:
                    print("brain abo-bruecke: der Dienst kennt diesen Bruecken-Token nicht",
                          file=sys.stderr)
                    return 1
                print(f"brain abo-bruecke: Auftrag holen fehlgeschlagen: {exc}", file=sys.stderr)
                if schluss is None:
                    return 1
                time.sleep(min(30.0, max(0.0, schluss - time.monotonic())))
                continue
            if status == 204 or not auftrag:
                if schluss is None and (args.bis_leer or args.einmal):
                    if erledigt == 0:
                        print("brain abo-bruecke: kein Auftrag wartet")
                    break
                continue
            name = PROGRAMME.get(auftrag.get("programm", ""), None)
            print(f"brain abo-bruecke: Auftrag {auftrag['id']} ({name.name if name else '?'}, "
                  f"{auftrag.get('modell') or 'Vorgabe'})")
            try:
                ergebnis = auftrag_ausfuehren(dienst, token, auftrag, befehle=befehle,
                                              mcp_befehl=_mcp_befehl())
            except DienstFehler as exc:
                print(f"brain abo-bruecke: Dienst nicht erreichbar: {exc}", file=sys.stderr)
                ergebnis = "fehler"
            erledigt += 1
            print(f"brain abo-bruecke: Auftrag {auftrag['id']} {ergebnis}")
            if ergebnis not in ("fertig", "abgebrochen"):
                rc = 1
            if args.einmal:
                break
    except KeyboardInterrupt:
        print("brain abo-bruecke: beendet")
    finally:
        for s, h in alte.items():
            signal.signal(s, h)
    return rc


def add_parser(sub) -> None:
    p = sub.add_parser("abo-bruecke", help="Brain-Chat mit dem eigenen Abo beantworten "
                                           "(Claude Code, Codex, opencode auf diesem Rechner)",
                       description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("aktion", nargs="?", default="laufen", choices=("laufen", "pruefen", "mcp"),
                   help="laufen (Vorgabe), pruefen (Programme testen), mcp (intern)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--einmal", action="store_true", help="hoechstens einen Auftrag, dann Ende")
    mode.add_argument("--bis-leer", action="store_true", help="Auftraege abarbeiten, bis keiner wartet")
    mode.add_argument("--dauer", default=None, help="so lange bereit sein, z.B. 2h oder 90m")
    p.add_argument("--dienst", default=None, help="Basis-URL des Brain-Dienstes (oder BRAIN_DIENST_URL)")
    p.add_argument("--token-datei", default=None,
                   help="Datei mit dem Bruecken-Token (0600); sonst BRAIN_ABO_TOKEN")
    p.add_argument("--programme", default=None,
                   help="Kommaliste aus claude,codex,opencode (Vorgabe: alle installierten)")
    p.add_argument("--maschine", default=None, help="Name in der App (Vorgabe: Hostname)")
    p.add_argument("--warten", type=float, default=WARTEN, help="Long-Poll-Wartezeit je Anfrage (s)")
    p.add_argument("--neu-pruefen", action="store_true",
                   help="Mini-Aufrufe jetzt wiederholen (sonst 12 h zwischengespeichert)")
    p.add_argument("--ohne-pruefung", action="store_true",
                   help="keine Mini-Aufrufe; installierte Programme gelten als angemeldet")
    p.add_argument("--claude-befehl", default=None, help=argparse.SUPPRESS)
    p.add_argument("--codex-befehl", default=None, help=argparse.SUPPRESS)
    p.add_argument("--opencode-befehl", default=None, help=argparse.SUPPRESS)
    p.add_argument("--auftrag-datei", default=None, help=argparse.SUPPRESS)
    p.set_defaults(func=run)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="brain")
    add_parser(parser.add_subparsers(dest="cmd", required=True))
    args = parser.parse_args(["abo-bruecke", *(sys.argv[1:] if argv is None else argv)])
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
