#!/usr/bin/env python3
"""Codex-Sperre: Werkzeugaufrufe eines Codex-Zuges im Modellproxy pruefen (docs/AGENTS-SPERREN.md, "Codex").

Codex hat keine Sperr-Hooks. Jeder Befehl, den Codex im Zug ausfuehrt, kommt aber als Werkzeugaufruf aus der
Modellantwort, und diese laeuft durch den laufgebundenen Modellproxy auf dem Host (gemessen an Codex 0.160.1:
ohne eigene Konfiguration startet Codex weder Hooks noch ``notify`` noch MCP-Server, siehe
``shell/messungen/agents-remote/results/20261009-codexsperre/``). Der Proxy reicht deshalb jede Antwort durch
:class:`CodexSperre`: ein erlaubter Aufruf geht in normalisierter Form weiter, ein verbotener wird durch einen
Aufruf ersetzt, der nur die Ablehnung ausgibt. Codex fuehrt den urspruenglichen Befehl nie aus.

Die Entscheidung treffen dieselben Hook-Skripte wie beim Claude-Zug (``skills-sperre.sh`` und
``profil-sperre.sh`` aus ``<laufzeit>/hooks``) mit der Umgebung, die sie im Zug saehen; die Fehlermeldung ist
deshalb dieselbe. Die Hooks entscheiden ueber das Dateisystem (Pfadwoerter, ``realpath``, Symlinks); sie laufen
darum wie beim Claude-Zug in der Dateisystemsicht des Zuges: per ``nsenter`` im Benutzer- und Mount-Namensraum
des laufenden Sandbox-Prozesses (``namensraum``), nicht auf dem Host (gemessen 09.10.2026, siehe
``shell/messungen/agents-remote/results/20261009-codexsperre/``). Ziel ist einmal je Zug das innere bwrap; vor
und nach jedem Hook muessen PID, Startzeit und beide Namensraeume gleich sein. Ohne erreichbaren oder bei
geaendertem Namensraum: verweigert.
Abbildung der Codex-Werkzeuge:

  exec_command   -> Bash (``cmd``, Arbeitsordner aus ``workdir``); keine eigene Shell, keine Login-Shell, kein TTY.
                    Ein reiner Lesebefehl (``cat``, ``head -n N``, ``sed -n 'a,bp'`` ...) gilt wie Claudes Read je Datei,
                    denn Codex hat kein Lesewerkzeug; lehnt Read ab, entscheidet die Bash-Pruefung
  write_stdin    -> nur Nachfragen ohne Eingabe (``chars`` leer)
  apply_patch    -> Write (Datei anlegen, loeschen, Ziel einer Verschiebung) und Edit (Datei aendern) je Pfad
  view_image     -> Read
  alles andere   -> verweigert, auch Plan, Ziele, Uhr und Rueckfragen (kein Werkzeug am Profil vorbei; ein Zug hat
                    keinen Menschen im Kanal), ``exec`` des Code-Modus, Unteragenten, MCP, unbekannte Typen

Fail-closed: jede unklare Antwort eines Hooks, jede Frist, jeder unlesbare Aufruf verweigert.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

HOOK_FRIST_S = 10  # wie der Settings-Eintrag des Claude-Zuges
EREIGNIS_GRENZE = 16 * 1024 * 1024
SANDBOX_UMGEBUNG = (("HOME", "/home/agent"), ("PATH", "/usr/local/bin:/usr/bin:/bin"), ("TMPDIR", "/tmp"),
                    ("LANG", "C.UTF-8"), ("USER", "agent"))
NSENTER = "/usr/bin/nsenter"
NAMESPACES = frozenset({"functions", "clock"})
# Aufruftypen, die der Anbieter selbst ausfuehrt; der Proxy laesst Webwerkzeuge nur mit Webrecht zu.
SERVERAUFRUFE = frozenset({"web_search_call"})
EXEC_FELDER = frozenset({"cmd", "workdir", "yield_time_ms", "max_output_tokens", "login", "tty", "justification",
                         "prefix_rule", "sandbox_permissions", "shell"})
STDIN_FELDER = frozenset({"session_id", "chars", "yield_time_ms", "max_output_tokens"})
BILD_FELDER = frozenset({"path", "detail"})
# Streaming-Teilstuecke eines Aufrufs; Codex fuehrt erst das fertige Element aus (gemessen), die Teile entfallen.
TEILEREIGNISSE = frozenset({"response.function_call_arguments.delta", "response.function_call_arguments.done",
                            "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"})
# Lesebefehl ohne Shell-Wirkung: dieselbe Pruefung wie Claudes Read-Werkzeug je Datei (Codex hat kein eigenes).
_LESEZEICHEN = re.compile(r"[;&|<>$`(){}\[\]*?~\\!#\n\r\t\x00]")
_SED_DRUCK = re.compile(r"[0-9]+(,[0-9]+)?p\Z")
_ZAHL = re.compile(r"[0-9]{1,7}\Z")
_PATCH_KOPF = re.compile(r"\*\*\* (Add File|Update File|Delete File|Move to): (.*)\Z")
_STEUERZEICHEN = re.compile(r"[\x00-\x1f\x7f]")


class SperrFehler(Exception):
    """Aufruf ist nicht pruefbar; wird als Verweigerung behandelt."""


def ablehnung(grund: str) -> str:
    """Shell-Befehl, der nur die Ablehnung ausgibt und mit 1 endet."""
    text = _STEUERZEICHEN.sub(" ", str(grund))[:1500]
    return "printf '%%s\\n' '%s'; exit 1" % text.replace("'", "'\\''")


class CodexSperre:
    """Prueft die Werkzeugaufrufe eines gesperrten Codex-Zuges mit den Sperr-Hooks des Claude-Zuges."""

    def __init__(self, hooks: Path, umgebung: Iterable[tuple[str, str]], cwd: str | os.PathLike[str], *,
                 session_id: str = "",
                 hook_runner: Optional[Callable[[str, dict[str, Any]], Optional[str]]] = None,
                 namensraum: Optional[Callable[[], Iterable[int]]] = None,
                 hauptprozess: Optional[Callable[[], int]] = None,
                 protokoll: Optional[Path] = None) -> None:
        """``namensraum`` liefert die Host-PIDs des laufenden Zuges (cgroup der Unit); ohne ihn laufen die Hooks
        auf dem Host (nur fuer Tests ohne Sandbox). ``protokoll`` bekommt je Entscheidung eine JSON-Zeile."""
        self.hooks = Path(hooks)
        self.cwd = os.path.abspath(str(cwd))
        self.session_id = str(session_id)
        self.namensraum = namensraum
        # PID des aeusseren bwrap (Hauptprozess der Unit, aus dem Receipt des Launchers); sein Kind ist das Ziel.
        self.hauptprozess = hauptprozess
        self._ziel: Optional[tuple[int, int, int, int]] = None  # PID, Startzeit, Inode ns/mnt, Inode ns/user
        self.protokoll = Path(protokoll) if protokoll is not None else None
        env = dict(SANDBOX_UMGEBUNG)
        # Eine Datei im beschreibbaren HOME des Zuges (usercustomize, .pth) darf den Pruefkern nicht beeinflussen.
        env["PYTHONNOUSERSITE"] = "1"
        if sys.platform == "darwin":
            # /home ist auf macOS autofs: jeder Blick auf /home/agent kostet Sekunden. Ein ebenso fremdes,
            # nicht vorhandenes HOME hat fuer die Pruefung dieselbe Wirkung (nichts darunter ist freigegeben).
            env["HOME"] = "/var/empty/wb-agent-home"
        env.update(dict(umgebung))
        # Der Pruefkern laeuft auf dem Host: mit dessen Python (auf Peer-Rechner /usr/bin, also der Pfad des Zuges; auf dem
        # Mac sonst der xcrun-Shim, der ohne echtes HOME Sekunden braucht und die Hook-Frist sprengt).
        python = os.path.dirname(os.path.realpath(sys.executable))
        if os.path.isfile(os.path.join(python, "python3")) and python not in env["PATH"].split(os.pathsep) \
                and namensraum is None:
            env["PATH"] = python + os.pathsep + env["PATH"]
        if not env.get("WB_AGENT_ID") or not env.get("WB_WELT") or not env.get("WB_AGENT_ZUG"):
            raise ValueError("Codex-Sperre braucht die Zugbindung WB_AGENT_ID, WB_WELT und WB_AGENT_ZUG")
        self.umgebung = env
        self._hook_runner = hook_runner or self._hook
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, Any]] = {}
        self.zaehler = {"erlaubt": 0, "verweigert": 0}
        self.verweigerungen: list[str] = []
        self._gezaehlt: set[str] = set()

    # Hooks ---------------------------------------------------------------------------
    @staticmethod
    def _zustand(pid: int) -> tuple[int, int, int]:
        """Startzeit (Feld 22 von /proc/<pid>/stat) und Inodes von ns/mnt und ns/user eines Prozesses."""
        text = Path("/proc/%d/stat" % pid).read_text()
        start = int(text[text.rindex(")") + 2:].split()[19])
        return start, os.stat("/proc/%d/ns/mnt" % pid).st_ino, os.stat("/proc/%d/ns/user" % pid).st_ino

    @staticmethod
    def _eigener_mnt() -> int:
        return os.stat("/proc/self/ns/mnt").st_ino

    @staticmethod
    def _kinder(pid: int) -> list[int]:
        return [int(k) for task in Path("/proc/%d/task" % pid).iterdir()
                for k in (task / "children").read_text().split()]

    def _ziel_festlegen(self) -> tuple[int, int, int, int]:
        """Legt beim ersten Hook des Zuges das Ziel fest: das einzige Kind des aeusseren bwrap (Hauptprozess der Unit)
        in der cgroup des Zuges mit eigenem Mount-Namensraum, also das innere bwrap. Danach nie ein anderes."""
        with self._lock:
            if self._ziel is not None:
                return self._ziel
            if self.hauptprozess is None:
                raise SperrFehler("Hauptprozess des Zuges unbekannt")
            try:
                haupt = int(self.hauptprozess())
                mitglieder = set(int(p) for p in self.namensraum())  # type: ignore[misc]
                eigen = self._eigener_mnt()
                kandidaten = [(k, self._zustand(k)) for k in self._kinder(haupt) if k in mitglieder]
            except (OSError, ValueError, TypeError, IndexError, AttributeError) as exc:
                raise SperrFehler("Zugprozesse nicht lesbar: %s" % exc) from None
            kandidaten = [(k, z) for k, z in kandidaten if z[1] != eigen]
            if len(kandidaten) != 1:
                raise SperrFehler("%d statt genau einem inneren bwrap des Zuges" % len(kandidaten))
            pid, (start, mnt, user) = kandidaten[0]
            self._ziel = (pid, start, mnt, user)
            return self._ziel

    def _ziel_pruefen(self, ziel: tuple[int, int, int, int], wann: str) -> Optional[str]:
        """Meldung, wenn PID, Startzeit oder ein Namensraum des festgelegten Ziels nicht mehr stimmen."""
        try:
            gleich = self._zustand(ziel[0]) == ziel[1:] and ziel[0] in set(int(p) for p in self.namensraum())  # type: ignore[misc]
        except (OSError, ValueError, TypeError, IndexError):
            gleich = False
        if gleich:
            return None
        return ("Codex-Sperre: Zielprozess %d des Zuges hat sich %s der Pruefung geaendert oder beendet (Startzeit, "
                "Namensraum oder cgroup), der Zugriff bleibt gesperrt." % (ziel[0], wann))

    def _hook(self, datei: str, ereignis: dict[str, Any]) -> Optional[str]:
        """Grund der Verweigerung eines Hook-Skripts oder ``None``; alles Unklare verweigert."""
        pfad = self.hooks / datei
        if self.namensraum is None and not pfad.is_file():
            return "Codex-Sperre: %s fehlt -- ohne Pruefung ist nichts erlaubt." % datei
        argv, cwd, ziel = ["/bin/bash", str(pfad)], self.cwd if os.path.isdir(self.cwd) else "/", None
        try:
            if self.namensraum is not None:
                # Benutzer- und Mount-Namensraum, Wurzel und cwd des Zuges (gemessen: unprivilegiert, ~2 ms); den
                # Arbeitsordner der Pruefung nennt das Ereignis.
                ziel = self._ziel_festlegen()
                abweichung = self._ziel_pruefen(ziel, "vor")
                if abweichung:
                    return abweichung
                argv = [NSENTER, "-t", str(ziel[0]), "-U", "-m", "-r", "-w", "--preserve-credentials", "--"] + argv
                cwd = "/"
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    env=self.umgebung, start_new_session=True, cwd=cwd)
        except (OSError, SperrFehler, TypeError, ValueError) as exc:
            return "Codex-Sperre: %s im Namensraum des Zuges nicht ausfuehrbar (%s) -- ohne Pruefung ist nichts " \
                   "erlaubt." % (datei, exc if isinstance(exc, SperrFehler) else type(exc).__name__)
        try:
            out, _ = proc.communicate(json.dumps(ereignis).encode("utf-8"), timeout=HOOK_FRIST_S)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            proc.communicate()
            return "Codex-Sperre: %s hat seine Frist ueberschritten, der Zugriff bleibt gesperrt." % datei
        text = out.decode("utf-8", "replace").strip()
        if ziel is not None:
            abweichung = self._ziel_pruefen(ziel, "waehrend")
            if abweichung:
                return abweichung
        if not text and proc.returncode == 0:
            return None
        try:
            daten = json.loads(text)
            spezifisch = daten["hookSpecificOutput"]
            entscheidung = spezifisch.get("permissionDecision")
        except (ValueError, KeyError, TypeError, AttributeError):
            return "Codex-Sperre: %s lieferte keine lesbare Entscheidung -- ohne Pruefung ist nichts erlaubt." % datei
        if entscheidung == "allow" and proc.returncode == 0:
            return None
        return str(spezifisch.get("permissionDecisionReason") or "%s verweigert ohne Grund" % datei)

    def werkzeug_pruefen(self, werkzeug: str, eingabe: dict[str, Any], cwd: str) -> Optional[str]:
        """Dieselben Hooks wie der Claude-Zug: Skills-Sperre fuer ihre Werkzeuge, Profil-Sperre fuer alle."""
        ereignis = {"hook_event_name": "PreToolUse", "tool_name": werkzeug, "tool_input": eingabe, "cwd": cwd,
                    "session_id": self.session_id}
        for datei in ("skills-sperre.sh", "profil-sperre.sh"):
            grund = self._hook_runner(datei, ereignis)
            if grund:
                return grund
        return None

    # Aufrufe -------------------------------------------------------------------------
    def _arbeitsordner(self, workdir: object) -> str:
        if workdir is None:
            return self.cwd
        if not isinstance(workdir, str) or not workdir.strip() or _STEUERZEICHEN.search(workdir):
            raise SperrFehler("exec_command mit ungueltigem workdir")
        return os.path.normpath(workdir if os.path.isabs(workdir) else os.path.join(self.cwd, workdir))

    @staticmethod
    def _argumente(item: dict[str, Any], felder: frozenset[str]) -> dict[str, Any]:
        try:
            args = json.loads(item.get("arguments") or "")
        except (TypeError, ValueError):
            raise SperrFehler("Argumente sind kein JSON") from None
        if not isinstance(args, dict) or set(args) - felder:
            raise SperrFehler("unerwartete Argumente %s" % sorted(set(args) - felder if isinstance(args, dict)
                                                                  else []))
        return args

    @staticmethod
    def _zahl(args: dict[str, Any], neu: dict[str, Any], name: str) -> None:
        if name in args and args[name] is not None:
            if type(args[name]) is not int or args[name] < 0:
                raise SperrFehler("%s ist keine Zahl" % name)
            neu[name] = args[name]

    @classmethod
    def lesedateien(cls, cmd: str) -> Optional[list[str]]:
        """Dateien eines reinen Lesebefehls oder einer Kette daraus mit ``&&``/``;``, sonst ``None``."""
        dateien: list[str] = []
        for teil in re.split(r"\s*(?:&&|;)\s*", cmd.strip()):
            einzeln = cls._lesebefehl(teil)
            if einzeln is None:
                return None
            dateien += einzeln
        return dateien or None

    @staticmethod
    def _lesebefehl(cmd: str) -> Optional[list[str]]:
        """Dateien eines Lesebefehls (``cat``, ``head``, ``tail``, ``nl -ba``, ``wc``, ``sed -n 'a,bp'``), sonst
        ``None``. Keine Shell-Syntax, keine Globs, keine Variablen, keine Tilde, keine fremden Optionen; ein am
        Trenner zerschnittenes Quoting scheitert an shlex und faellt so auf die Bash-Pruefung zurueck."""
        if _LESEZEICHEN.search(cmd):
            return None
        try:
            worte = shlex.split(cmd)
        except ValueError:
            return None
        if len(worte) < 2:
            return None
        programm, rest = worte[0], worte[1:]
        if programm in ("head", "tail") and len(rest) >= 3 and rest[0] == "-n" and _ZAHL.match(rest[1]):
            rest = rest[2:]
        elif programm == "sed" and len(rest) >= 3 and rest[0] == "-n" and _SED_DRUCK.match(rest[1]):
            rest = rest[2:]
        elif programm == "nl" and rest[:1] == ["-ba"]:
            rest = rest[1:]
        elif programm == "wc" and rest[:1] in (["-l"], ["-c"], ["-w"]):
            rest = rest[1:]
        elif programm == "cat" and rest[:1] == ["-n"]:
            rest = rest[1:]
        elif programm not in ("cat", "head", "tail", "wc"):
            return None
        if not rest or any(not wort or wort.startswith("-") for wort in rest):
            return None
        return rest

    def _exec(self, item: dict[str, Any]) -> tuple[Optional[str], dict[str, Any]]:
        args = self._argumente(item, EXEC_FELDER)
        cmd = args.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip() or "\x00" in cmd:
            raise SperrFehler("exec_command ohne Befehl")
        if args.get("shell") not in (None, ""):
            return "Codex-Sperre: exec_command mit eigener Shell ist im gesperrten Zug nicht erlaubt.", item
        cwd = self._arbeitsordner(args.get("workdir"))
        dateien = self.lesedateien(cmd)
        lesegrund = None
        for datei in dateien or ():
            lesegrund = self.werkzeug_pruefen("Read", {"file_path": os.path.normpath(os.path.join(cwd, datei))}, cwd)
            if lesegrund:
                break
        if dateien and lesegrund is None:
            grund = None  # wie Read; sonst gilt die Bash-Pruefung mit ihrer Meldung
        else:
            grund = self.werkzeug_pruefen("Bash", {"command": cmd, "description": ""}, cwd)
            if grund and lesegrund:
                grund = "%s [als Lesebefehl: %s]" % (grund, lesegrund)
        if grund:
            return grund, item
        # Keine Login-Shell (sie liest Profildateien), kein TTY; Eskalationsfelder haben ohne Codex-Sandbox keinen Sinn.
        neu: dict[str, Any] = {"cmd": cmd, "login": False, "tty": False}
        if args.get("workdir") is not None:
            neu["workdir"] = cwd
        for name in ("yield_time_ms", "max_output_tokens"):
            self._zahl(args, neu, name)
        return None, dict(item, arguments=json.dumps(neu, ensure_ascii=False))

    def _stdin(self, item: dict[str, Any]) -> tuple[Optional[str], dict[str, Any]]:
        args = self._argumente(item, STDIN_FELDER)
        if args.get("chars") not in (None, ""):
            return ("Codex-Sperre: write_stdin darf im gesperrten Zug nur ohne Eingabe nachfragen; jeder Befehl "
                    "geht als eigener exec_command durch die Profil-Sperre."), item
        neu: dict[str, Any] = {}
        if type(args.get("session_id")) is not int:
            raise SperrFehler("write_stdin ohne session_id")
        neu["session_id"] = args["session_id"]
        for name in ("yield_time_ms", "max_output_tokens"):
            self._zahl(args, neu, name)
        return None, dict(item, arguments=json.dumps(neu))

    def _bild(self, item: dict[str, Any]) -> tuple[Optional[str], dict[str, Any]]:
        args = self._argumente(item, BILD_FELDER)
        pfad = args.get("path")
        if not isinstance(pfad, str) or not pfad.strip() or _STEUERZEICHEN.search(pfad):
            raise SperrFehler("view_image ohne Pfad")
        return self.werkzeug_pruefen("Read", {"file_path": pfad}, self.cwd), item

    def patch_ziele(self, text: str) -> list[tuple[str, str]]:
        """(Werkzeug, absoluter Pfad) je Datei eines apply_patch-Textes; alles Unbekannte ist ein Fehler."""
        if not isinstance(text, str) or "\x00" in text:
            raise SperrFehler("apply_patch ohne Text")
        ziele: list[tuple[str, str]] = []
        quelle: Optional[str] = None
        for zeile in text.splitlines():
            kern = zeile.strip()
            if not kern.startswith("***"):
                continue
            if kern in ("*** Begin Patch", "*** End Patch", "*** End of File"):
                continue
            m = _PATCH_KOPF.match(kern)
            if not m or not m.group(2).strip() or m.group(2) != m.group(2).strip() \
                    or _STEUERZEICHEN.search(m.group(2)):
                raise SperrFehler("unbekannte Patchzeile")
            art, pfad = m.group(1), m.group(2)
            ziel = os.path.normpath(pfad if os.path.isabs(pfad) else os.path.join(self.cwd, pfad))
            if art == "Move to":
                if quelle is None:
                    raise SperrFehler("Move to ohne Update File")
                ziele.append(("Write", ziel))
            else:
                ziele.append(("Edit" if art == "Update File" else "Write", ziel))
            quelle = ziel if art == "Update File" else None
        if not ziele:
            raise SperrFehler("apply_patch nennt keine Datei")
        return ziele

    def _patch(self, item: dict[str, Any], text: object) -> tuple[Optional[str], dict[str, Any]]:
        for werkzeug, pfad in self.patch_ziele(text):  # type: ignore[arg-type]
            grund = self.werkzeug_pruefen(werkzeug, {"file_path": pfad, "content": ""} if werkzeug == "Write" else
                                          {"file_path": pfad, "old_string": "", "new_string": ""}, self.cwd)
            if grund:
                return grund, item
        return None, item

    def _entscheiden(self, item: dict[str, Any]) -> tuple[Optional[str], dict[str, Any]]:
        art = item.get("type")
        if art == "local_shell_call":
            return "Codex-Sperre: local_shell_call ist im gesperrten Zug nicht freigegeben.", item
        if art not in ("function_call", "custom_tool_call"):
            return "Codex-Sperre: Aufruftyp '%s' ist im gesperrten Zug nicht freigegeben." % art, item
        name = item.get("name")
        namespace = item.get("namespace")
        if namespace is not None and namespace not in NAMESPACES:
            return "Codex-Sperre: Werkzeug '%s.%s' ist im gesperrten Zug nicht freigegeben." % (namespace, name), item
        if art == "custom_tool_call":
            if name == "apply_patch":
                return self._patch(item, item.get("input"))
            return "Codex-Sperre: Werkzeug '%s' ist im gesperrten Zug nicht freigegeben." % name, item
        if name == "exec_command":
            return self._exec(item)
        if name == "write_stdin":
            return self._stdin(item)
        if name == "view_image":
            return self._bild(item)
        if name == "apply_patch":
            args = self._argumente(item, frozenset({"input"}))
            return self._patch(item, args.get("input"))
        return "Codex-Sperre: Werkzeug '%s' ist im gesperrten Zug nicht freigegeben." % name, item

    def aufruf(self, item: dict[str, Any]) -> dict[str, Any]:
        """Erlaubter Aufruf (normalisiert) oder ein Ersatzaufruf, der nur die Ablehnung ausgibt."""
        schluessel = json.dumps(item, sort_keys=True, ensure_ascii=False)
        with self._lock:
            if schluessel in self._cache:
                return self._cache[schluessel]
        try:
            grund, neu = self._entscheiden(item)
        except SperrFehler as exc:
            grund, neu = "Codex-Sperre: Aufruf nicht pruefbar (%s) -- ohne Pruefung ist nichts erlaubt." % exc, item
        except Exception as exc:  # noqa: BLE001 - eigener Fehler verweigert
            grund, neu = "Codex-Sperre: interner Fehler der Pruefung (%s)." % type(exc).__name__, item
        if grund:
            neu = {"type": "function_call", "call_id": str(item.get("call_id") or "wb-codex-sperre"),
                   "name": "exec_command",
                   "arguments": json.dumps({"cmd": ablehnung(grund), "login": False, "tty": False}, ensure_ascii=False)}
            for feld in ("id", "status"):
                if isinstance(item.get(feld), str):
                    neu[feld] = item[feld]
        self._protokollieren(item, grund)
        with self._lock:
            # Ein Aufruf erscheint im Strom mehrfach (Element und ``response.completed``); gezaehlt wird er einmal.
            zaehlung = "%s/%s" % (item.get("call_id"), "v" if grund else "e")
            if zaehlung not in self._gezaehlt:
                self._gezaehlt.add(zaehlung)
                self.zaehler["verweigert" if grund else "erlaubt"] += 1
                if grund:
                    self.verweigerungen.append(grund[:300])
            self._cache[schluessel] = neu
        return neu

    def _protokollieren(self, item: dict[str, Any], grund: Optional[str]) -> None:
        """Entscheidung auf dem Host festhalten (Zugordner, im Zug nur lesbar); ein Schreibfehler aendert nichts."""
        if self.protokoll is None:
            return
        zeile = {"call_id": item.get("call_id"), "typ": item.get("type"), "name": item.get("name"),
                 "eingabe": str(item.get("arguments") if "arguments" in item else item.get("input"))[:4000],
                 "entscheidung": "verweigert" if grund else "erlaubt", "grund": grund}
        try:
            with self._lock, open(self.protokoll, "a", encoding="utf-8") as datei:
                datei.write(json.dumps(zeile, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # Antworten -----------------------------------------------------------------------
    def umschreiben(self, wert: Any) -> Any:
        """Ersetzt jeden Werkzeugaufruf an jeder Stelle einer Antwort (Ereignis, Element, ``response.output``)."""
        if isinstance(wert, list):
            return [self.umschreiben(v) for v in wert]
        if not isinstance(wert, dict):
            return wert
        art = wert.get("type")
        if isinstance(art, str) and art in ("function_call", "custom_tool_call") or (
                isinstance(art, str) and art.endswith("_call") and art not in SERVERAUFRUFE):
            return self.aufruf(wert)
        return {k: self.umschreiben(v) for k, v in wert.items()}

    def strom(self) -> "SseUmschreiber":
        return SseUmschreiber(self)

    def json_koerper(self, body: bytes) -> bytes:
        """Nicht gestreamte Antwort: JSON-Koerper ganz; alles andere wie ein Ereignisstrom, falls Codex ihn so liest."""
        try:
            daten = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            if not re.search(rb"(?m)^data:", body):
                return body  # kein Ereignisstrom, kein JSON: Fehlertext ohne Aufrufe
            strom = self.strom()
            return strom.feed(body) + strom.ende()
        neu = self.umschreiben(daten)
        return body if neu == daten else json.dumps(neu, ensure_ascii=False).encode("utf-8")


class SseUmschreiber:
    """Schreibt einen Server-Sent-Events-Strom der Responses-API ereignisweise um."""

    def __init__(self, sperre: CodexSperre) -> None:
        self.sperre = sperre
        self.puffer = b""
        self.cr = b""
        self.begonnen = False
        self.begonnen_puffer = b""
        self.aufruf_ids: set[str] = set()

    def _ereignis(self, roh: bytes) -> bytes:
        zeilen = roh.split(b"\n")
        daten = [z[5:][1:] if z[5:6] == b" " else z[5:] for z in zeilen if z.startswith(b"data:")]
        if not daten:
            return roh + b"\n\n"
        nutzlast = b"\n".join(daten)
        if nutzlast.strip() == b"[DONE]":
            return roh + b"\n\n"
        try:
            ereignis = json.loads(nutzlast.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            # Was hier nicht pruefbar ist, geht nicht weiter (ein anderer Parser koennte es lesen).
            return b""
        if not isinstance(ereignis, dict):
            return b""
        art = ereignis.get("type")
        item = ereignis.get("item")
        aufruf = isinstance(item, dict) and isinstance(item.get("type"), str) and item["type"].endswith("_call") \
            and item["type"] not in SERVERAUFRUFE
        if aufruf and isinstance(item.get("id"), str):
            self.aufruf_ids.add(item["id"])
        # Der Anfang eines Aufrufs traegt nur Teilargumente; Codex fuehrt erst das fertige Element aus (gemessen).
        if (aufruf and art == "response.output_item.added") or art in TEILEREIGNISSE or (isinstance(ereignis.get("item_id"), str) and ereignis["item_id"] in self.aufruf_ids
                                     and art != "response.output_item.done"):
            return b""
        neu = self.sperre.umschreiben(ereignis)
        if neu == ereignis:
            return roh + b"\n\n"
        rest = [z for z in zeilen if not z.startswith(b"data:")]
        return b"\n".join(rest + [b"data: " + json.dumps(neu, ensure_ascii=False, separators=(",", ":"))
                                  .encode("utf-8")]) + b"\n\n"

    def feed(self, chunk: bytes) -> bytes:
        """Zeilenenden nach SSE-Spezifikation (``\\r\\n``, ``\\r``, ``\\n``), auch ueber Chunkgrenzen; ein BOM am
        Stromanfang faellt weg, wie ihn ein konformer Parser verwirft."""
        daten = self.cr + chunk
        self.cr = b""
        if daten.endswith(b"\r"):  # vielleicht die erste Haelfte von \r\n
            daten, self.cr = daten[:-1], b"\r"
        if not self.begonnen and daten:
            self.begonnen_puffer += daten
            if len(self.begonnen_puffer) < 3 and b"\xef\xbb\xbf".startswith(self.begonnen_puffer):
                return b""
            daten, self.begonnen_puffer, self.begonnen = self.begonnen_puffer, b"", True
            if daten.startswith(b"\xef\xbb\xbf"):
                daten = daten[3:]
        self.puffer += daten.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        teile = self.puffer.split(b"\n\n")
        self.puffer = teile.pop()
        if len(self.puffer) > EREIGNIS_GRENZE:
            raise SperrFehler("Ereignis zu gross")
        return b"".join(self._ereignis(t) for t in teile if t)

    def ende(self) -> bytes:
        # Ein unvollstaendiges letztes Ereignis verwirft auch Codex; nichts Ungepruefte geht weiter.
        self.puffer = self.cr = self.begonnen_puffer = b""
        return b""


__all__ = ["CodexSperre", "SperrFehler", "SseUmschreiber", "ablehnung"]
