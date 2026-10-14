"""Eingebaute Shell-Tripwires fuer Bash-Befehle, nur Standardbibliothek.

Zwei Wiederholungsfehler lassen sich nicht als `befehl`-Regex in FALLEN.yaml ausdruecken,
weil der Befund vom Befehl selbst abhaengt (b6-replay, 28.09.2026: 34 von 73 neuen
Wiederholungsereignissen, Lehren seit 30.07./03.08.):

  pgrep-selbsttreffer     `pgrep -f MUSTER` / `pkill -f MUSTER` unter Linux (procps-ng), wobei
                          MUSTER auf den eigenen Befehlstext passt. Die Tool-Shell (`bash -c
                          '<befehl>'`, auch der Befehlstext von `ssh HOST '...'`) traegt den ganzen
                          Befehl in ihrer Kommandozeile, und procps-pgrep schliesst nur sich selbst
                          aus: `until ! pgrep -f x` wartet ewig, `pkill -f x` beendet die eigene
                          Shell (gemessen auf peer, procps-ng 4.0.7, 28.09.2026).
                          macOS-pgrep schliesst dagegen alle eigenen Vorfahren aus (`man pgrep`,
                          Schalter -a); dort ist derselbe Befehl kein Selbsttreffer und wird nicht
                          gewarnt, ausser mit `-a`.
                          Quelle: 10-global/prozess-hygiene-pgrep-selbsttreffer.
  pgrep-hintergrundwarter
                          macOS: ein Bash-Hintergrundwarter mit `until`/`while pgrep -f`
                          traegt das Muster in seiner rohen Befehlszeile. Andere Shells
                          koennen ihn finden, auch wenn BSD-pgrep eigene Vorfahren ausnimmt.
                          Schalter BRAIN_TRIPWIRE_PGREP_WARTER (Standard 1, 0 schaltet ab).
  backticks-in-shelltext  Backticks an einer Stelle, an der die Shell sie als Befehlsersetzung
                          ausfuehrt: in doppelten Anfuehrungszeichen (`git commit -m "..."`),
                          ungequotet, im Rumpf eines ungequoteten Heredocs (`<<EOF`) und in
                          Text, den `ssh HOST '...'` oder `bash -c '...'` an eine zweite Shell
                          gibt. Ergebnis: "command not found" oder still fehlender Text.
                          Nicht gewarnt: einfache Quotes, gequotete Heredocs (`<<'EOF'`),
                          maskierte `\\``, Kommentare.

Der Scanner ist ein kleiner Zustandsautomat ueber den Befehlstext (Quotes, `$(...)`,
Heredocs, Kommentare), kein vollstaendiger Shell-Parser. Er soll im Zweifel schweigen.
"""
from __future__ import annotations

import os
import re
import shlex
import sys

# ===========================================================================
# Scanner
# ===========================================================================

_HEREDOC_RE = re.compile(r"<<(-?)[ \t]*(\\?)(['\"]?)([A-Za-z_][A-Za-z0-9_.-]*)\3")


class _Scan:
    """Ein Durchlauf ueber `text`. Ergebnis:
    - `ticks`: Liste von (start, inhalt) je Backtick-Paar, das die Shell ausfuehrt
    - `code`: Kopie von `text`, in der Inhalte von Strings, Kommentaren und Heredoc-Rumpfen
      durch Leerzeichen ersetzt sind (Offsets bleiben gleich) -- fuer die Suche nach
      Befehlswoertern wie `pgrep`
    - `strings`: Liste von (start, ende, art, wert) fuer Strings auf Befehlsebene
      ('S' einfach, 'D' doppelt; `wert` ist der entquotete Inhalt)
    - `heredocs`: Liste von (position von `<<`, rumpf_start, rumpf_ende)
    """

    def __init__(self, text: str):
        self.t = text
        self.n = len(text)
        self.code = list(text)
        self.ticks: list[tuple[int, str]] = []
        self.strings: list[tuple[int, int, str, str]] = []
        self.heredocs: list[tuple[int, int, int]] = []
        self.pending: list[tuple[str, bool, bool, int]] = []  # (delim, gequotet, strip_tabs, position)
        try:
            self._normal(0, top=True)
        except Exception:
            pass
        self.code_str = "".join(self.code)

    def _mask(self, a: int, b: int) -> None:
        for i in range(max(a, 0), min(b, self.n)):
            if self.code[i] != "\n":
                self.code[i] = " "

    # Befehlsebene (auch innerhalb von `$(...)`); endet bei passender `)`, wenn nested
    def _normal(self, i: int, top: bool = False, nested: bool = False) -> int:
        t, n = self.t, self.n
        depth = 0
        word_start = True
        while i < n:
            c = t[i]
            if c == "\\":
                i += 2
                word_start = False
                continue
            if c == "'":
                j = t.find("'", i + 1)
                if j < 0:
                    j = n
                self.strings.append((i, j + 1, "S", t[i + 1:j]))
                self._mask(i + 1, j)
                i = j + 1
                word_start = False
                continue
            if c == '"':
                i = self._dquote(i)
                word_start = False
                continue
            if c == "`":
                i = self._tick(i)
                word_start = False
                continue
            if c == "$" and i + 1 < n and t[i + 1] == "(":
                if i + 2 < n and t[i + 2] == "(":  # $(( arithmetik ))
                    j = t.find("))", i + 3)
                    i = n if j < 0 else j + 2
                    continue
                i = self._normal(i + 2, nested=True)
                word_start = False
                continue
            if c == "#" and word_start:
                j = t.find("\n", i)
                j = n if j < 0 else j
                self._mask(i, j)
                i = j
                continue
            if c == "<" and t.startswith("<<", i) and not t.startswith("<<<", i):
                m = _HEREDOC_RE.match(t, i)
                if m:
                    quoted = bool(m.group(2) or m.group(3))
                    self.pending.append((m.group(4), quoted, m.group(1) == "-", i))
                    i = m.end()
                    word_start = False
                    continue
            if c == "\n":
                i += 1
                if self.pending:
                    i = self._heredoc_bodies(i)
                word_start = True
                continue
            if nested:
                if c == "(":
                    depth += 1
                elif c == ")":
                    if depth == 0:
                        return i + 1
                    depth -= 1
            word_start = c in " \t;&|()"
            i += 1
        return n

    def _dquote(self, i: int) -> int:
        t, n = self.t, self.n
        start = i
        i += 1
        val: list[str] = []
        while i < n:
            c = t[i]
            if c == "\\" and i + 1 < n:
                nxt = t[i + 1]
                if nxt in '$`"\\\n':
                    if nxt != "\n":
                        val.append(nxt)
                else:
                    val.append(c + nxt)
                self._mask(i, i + 2)
                i += 2
                continue
            if c == '"':
                self.strings.append((start, i + 1, "D", "".join(val)))
                return i + 1
            if c == "`":
                j = self._tick(i)
                val.append(t[i:j])
                i = j
                continue
            if c == "$" and i + 1 < n and t[i + 1] == "(" and not t.startswith("$((", i):
                j = self._normal(i + 2, nested=True)
                val.append(t[i:j])
                i = j
                continue
            val.append(c)
            self._mask(i, i + 1)
            i += 1
        self.strings.append((start, n, "D", "".join(val)))
        return n

    def _tick(self, i: int) -> int:
        """Befehlsersetzung mit Backticks ab `i`; liefert Index hinter dem Schluss-Backtick."""
        t, n = self.t, self.n
        j = i + 1
        while j < n:
            if t[j] == "\\":
                j += 2
                continue
            if t[j] == "`":
                break
            j += 1
        self.ticks.append((i, t[i + 1:j]))
        self._mask(i + 1, j)
        return min(j + 1, n)

    def _heredoc_bodies(self, i: int) -> int:
        t, n = self.t, self.n
        pending, self.pending = self.pending, []
        for delim, quoted, strip_tabs, op in pending:
            rumpf = i
            while i < n:
                j = t.find("\n", i)
                j = n if j < 0 else j
                line = t[i:j]
                cmp_line = line.lstrip("\t") if strip_tabs else line
                if cmp_line.rstrip() == delim:
                    self.heredocs.append((op, rumpf, i))
                    i = j + 1
                    break
                if not quoted:
                    k = i
                    while k < j:
                        if t[k] == "\\":
                            k += 2
                            continue
                        if t[k] == "`":
                            k = self._tick(k)
                            continue
                        k += 1
                self._mask(i, j)
                i = j + 1
            else:
                self.heredocs.append((op, rumpf, n))
        return i


# ===========================================================================
# Zweite Shell: `ssh HOST '...'`, `bash -c '...'`
# ===========================================================================

_SEP = r"(?:^|[;&|(\n]|\$\(|&&|\|\|)"
_SECOND_SHELL_RE = re.compile(
    r"(?:\bssh\b(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*\s+[^\s;&|'\"]+"   # ssh [opts] host
    r"|\b(?:ba|z|da|k)?sh\s+(?:-[a-z]*c[a-z]*))\s+$"                  # bash -c / sh -lc
)


# Befehl laeuft auf einer anderen Maschine/VM; im Haus sind das Linux-Systeme (peer,
# Agent-Server, Lima-VMs, Container)
_REMOTE_RE = re.compile(r"\b(?:ssh|limactl|docker|podman|kubectl|machinectl|lxc|multipass|orb)\b")


def _segment_vor(sc: _Scan, start: int) -> str:
    """Der einfache Befehl links von `start` (bis zum letzten Trenner)."""
    prefix = sc.code_str[max(0, start - 200):start]
    cut = max(prefix.rfind(ch) for ch in ";\n|&")
    return prefix[cut + 1:] if cut >= 0 else prefix


def _second_shell_strings(sc: _Scan) -> list[tuple[str, bool]]:
    """(entquoteter String, entfernt) fuer Strings, die als Befehl an eine zweite Shell gehen."""
    out = []
    for start, _end, _art, wert in sc.strings:
        seg = _segment_vor(sc, start)
        if _SECOND_SHELL_RE.search(seg):
            out.append((wert, bool(_REMOTE_RE.search(seg))))
    return out


# Heredoc an eine Shell: `bash <<EOF`, `sh -s <<'EOF'`, `ssh HOST [bash] <<'EOF'`
_HEREDOC_SHELL_RE = re.compile(r"(?:\bssh\b.*|\b(?:ba|z|da|k)?sh(?:\s+-[A-Za-z]+)*)\s*$")


def befehlscode(command: str, _tiefe: int = 0) -> str:
    """Der Befehlstext ohne Text: Inhalte von Strings, Kommentaren und Heredoc-Rumpfen sind
    durch Leerzeichen ersetzt. Was eine Shell trotzdem ausfuehrt, bleibt Code und kommt
    angehaengt dazu: Strings fuer `ssh HOST '...'`/`bash -c '...'`, Backticks und Heredocs an
    eine Shell. Fuer `befehl`-Ausloeser mit `ohne_text: true` (Rauschbefund 13.10.2026:
    `g-killmuster` feuerte auf `grep -n "pkill"` und auf Text in Heredocs)."""
    sc = _Scan(command)
    teile = [sc.code_str]
    if _tiefe < 3:
        innen = [wert for wert, _ in _second_shell_strings(sc)]
        innen += [inhalt for _, inhalt in sc.ticks]
        innen += [command[a:b] for op, a, b in sc.heredocs
                  if _HEREDOC_SHELL_RE.search(_segment_vor(sc, op))]
        teile += [befehlscode(x, _tiefe + 1) for x in innen]
    return "\n".join(teile)


# ===========================================================================
# Detektoren
# ===========================================================================

_PGREP_RE = re.compile(r"(?:^|[\s;&|(`!{])(pgrep|pkill)(?=\s)")
_OPTS_WITH_ARG = set("uUgGPstFdLc")  # pgrep/pkill: Schalter mit eigenem Argument
_EINSCHRAENKUNG = set("uUgGPstF")
_WEITER_RE = re.compile(r"[;&|\n)`]")
_STOP = {";", "&&", "||", "|", "&", ")", "(", ">", ">>", "<", "2>", "2>&1", ">&"}


def _pgrep_calls(sc: _Scan):
    """(werkzeug, muster, schalter, entfernt, letzter, position) je pgrep/pkill-Aufruf mit -f auf
    Befehlsebene; `letzter`: letzter einfacher Befehl des Textes, nicht in Pipe oder `$(`.
    Ausgelassen: Aufrufe, deren Ausgabe per `| grep -v` gefiltert wird (filtert die eigene
    Zeile, da sie `pgrep` enthaelt), und Aufrufe mit Einschraenkung auf Benutzer, Gruppe,
    Elternprozess, Sitzung oder Terminal (die eigene Shell faellt meist heraus)."""
    code = sc.code_str
    for m in _PGREP_RE.finditer(code):
        vorn = code[max(0, m.start() - 300):m.start() + 1]
        cut = max(vorn.rfind(ch) for ch in ";\n|&(")
        entfernt = bool(_REMOTE_RE.search(vorn[cut + 1:] if cut >= 0 else vorn))
        rest = sc.t[m.end():m.end() + 2000]
        line_end = len(rest)
        k = rest.find("\n")
        if k >= 0:
            line_end = k
        try:
            lex = shlex.shlex(rest[:line_end], posix=True, punctuation_chars=";&|()<>")
            lex.whitespace_split = True
            toks = list(lex)
        except ValueError:
            continue
        flags: set = set()
        pattern = None
        skip = False
        for tok in toks:
            if tok in _STOP or tok[:1] in ";&|()<>":
                break
            if skip:
                skip = False
                continue
            if tok.startswith("--"):
                continue
            if tok.startswith("-") and len(tok) > 1 and pattern is None:
                for k, ch in enumerate(tok[1:]):
                    flags.add(ch)
                    if ch in _OPTS_WITH_ARG:
                        if k == len(tok) - 2:
                            skip = True
                        break
                continue
            pattern = tok
            break
        if not pattern or "f" not in flags or flags & _EINSCHRAENKUNG:
            continue
        nach = code[m.end():m.end() + line_end]
        if re.match(r"[^;&\n]*\|\s*grep\s+(-\w*\s+)*-\w*v", nach):
            continue
        if "$$" in sc.t[m.end():m.end() + line_end]:  # eigene PID ausdruecklich ausgeschlossen
            continue
        # letzter einfacher Befehl eines `-c`-Strings: bash/dash ersetzen sich per exec
        letzter = not _WEITER_RE.search(code, m.end()) and not re.search(
            r"(\||\$\(|`)\s*$", code[max(0, m.start(1) - 50):m.start(1)])
        yield m.group(1), pattern, flags, entfernt, letzter, m.start(1)


def _resolve_vars(pattern: str, command: str) -> str | None:
    """`$VAR`/`${VAR}` im Muster ueber eine Zuweisung im selben Befehl aufloesen; sonst None."""
    def repl(m):
        name = m.group(1) or m.group(2)
        a = re.search(r"(?:^|[\s;&(])%s=('([^']*)'|\"([^\"]*)\"|(\S+))" % re.escape(name), command)
        if not a:
            raise KeyError(name)
        return next(g for g in (a.group(2), a.group(3), a.group(4)) if g is not None)
    try:
        return re.sub(r"\$(?:\{(\w+)\}|(\w+))", repl, pattern)
    except KeyError:
        return None


def _self_hit(pattern: str, flags: set, command: str, plattform: str) -> bool:
    # macOS/BSD: Vorfahren sind ohne -a ausgeschlossen, die eigene Shell zaehlt nicht.
    if not plattform.startswith("linux") and "a" not in flags:
        return False
    if "x" in flags:  # -x: ganze Kommandozeile muss passen
        return False
    if re.search(r"\$(?:\{\w+\}|\w)", pattern):
        pattern = _resolve_vars(pattern, command)
        if pattern is None:
            return False
    try:
        rx = re.compile(pattern, re.IGNORECASE if "i" in flags else 0)
    except re.error:
        return pattern in command
    return bool(rx.search(command))


def _hintergrund_warter(pattern: str, flags: set, command: str, code: str, position: int) -> bool:
    """Mac: eine zweite Shell kann die rohe Befehlszeile dieses Warters finden."""
    if "x" in flags or not re.search(r"\b(?:until|while)\b[^;\n]*$", code[:position]):
        return False
    if re.search(r"\$(?:\{\w+\}|\w)", pattern):
        pattern = _resolve_vars(pattern, command)
        if pattern is None:
            return False
    try:
        return bool(re.search(pattern, command, re.IGNORECASE if "i" in flags else 0))
    except re.error:
        return False


def detect(command: str, plattform: str | None = None, _tiefe: int = 0,
           *, run_in_background: bool = False) -> list[dict]:
    """Befunde fuer einen Bash-Befehl: Liste von {klasse, detail}. `plattform` wie
    `sys.platform` der Shell, die den Befehl ausfuehrt (Standard: diese Maschine).
    `run_in_background` kommt aus `tool_input` und gilt nur fuer den aeusseren Befehl."""
    plattform = plattform or sys.platform
    if not command or ("`" not in command and "pgrep" not in command and "pkill" not in command):
        return []
    sc = _Scan(command)
    out: list[dict] = []
    # Ein einzelner einfacher Befehl in `bash -c '...'`/`ssh HOST '...'` wird von der Shell
    # per exec ersetzt; dann gibt es keine Shell mit dem Muster (gemessen auf peer, 28.09.).
    code = sc.code_str
    einzeln = _tiefe > 0 and not re.search(r"[;&|\n`]|\$\(", code.strip())
    for werkzeug, pattern, flags, entfernt, letzter, position in ([] if einzeln else _pgrep_calls(sc)):
        # `ssh HOST pgrep ...` ohne Quotes: die Gegenstelle bekommt nur diesen einen Befehl
        if entfernt or (_tiefe > 0 and letzter):
            continue
        if (run_in_background and _tiefe == 0 and plattform == "darwin"
                and os.environ.get("BRAIN_TRIPWIRE_PGREP_WARTER", "1") == "1"
                and werkzeug == "pgrep"
                and _hintergrund_warter(pattern, flags, command, code, position)):
            out.append({"klasse": "pgrep-hintergrundwarter", "detail": "pgrep -f %s" % pattern})
        if _self_hit(pattern, flags, command, plattform):
            out.append({"klasse": "pgrep-selbsttreffer", "detail": "%s -f %s" % (werkzeug, pattern)})
            break
    for _start, inhalt in sc.ticks:
        if inhalt.strip():
            out.append({"klasse": "backticks-in-shelltext", "detail": "`%s`" % inhalt.strip()[:40]})
            break
    if _tiefe < 2:
        for inner, per_ssh in _second_shell_strings(sc):
            # Gegenstellen per ssh sind im Haus Linux (peer, Agent-Server)
            for b in detect(inner, "linux" if per_ssh else plattform, _tiefe + 1):
                if not any(o["klasse"] == b["klasse"] for o in out):
                    if not b["detail"].endswith(" (in zweiter Shell)"):
                        b = dict(b, detail=b["detail"] + " (in zweiter Shell)")
                    out.append(b)
    return out


_TEXT = {
    "pgrep-hintergrundwarter": (
        "%s: auf dem Mac kann eine zweite Hintergrund-Shell mit demselben Muster diesen "
        "Warter finden; beide warten dann aufeinander. Gegenmittel: mit `kill -0 PID` auf "
        "die bekannte PID warten oder mit `comm` und Programmpfad filtern. "
        "Quelle: 10-global/prozess-hygiene-pgrep-selbsttreffer.md"
    ),
    "pgrep-selbsttreffer": (
        "%s: das Muster passt auf diesen Befehl selbst; unter Linux traegt die Tool-Shell ihn "
        "in ihrer Kommandozeile, pgrep findet sie also immer (Warteschleife endet nie, pkill "
        "beendet die eigene Shell). "
        "Gegenmittel: auf die PID warten (`$!`, PID-Datei, `while kill -0 $PID`) oder nach "
        "Programmpfad und `comm` suchen (`ps -eo pid,comm,args`). "
        "Quelle: 10-global/prozess-hygiene-pgrep-selbsttreffer"
    ),
    "backticks-in-shelltext": (
        "Backticks %s stehen, wo die Shell sie ausfuehrt (doppelte Quotes, ungequoteter Heredoc "
        "oder Text fuer ssh/bash -c): Folge ist \"command not found\" oder fehlender Text. "
        "Gegenmittel: Text in einfache Quotes, Heredoc als <<'EOF', `git commit -F <datei>` "
        "oder Datei mit Write schreiben. Quelle: regeln/maschinen.md (Shelltext mit Backticks)"
    ),
}


def format_findings(findings: list[dict]) -> str:
    if not findings:
        return ""
    zeilen = ["Fallenbuch-Tripwire (Shell), %d Treffer:" % len(findings)]
    for f in findings:
        zeilen.append("- [%s] %s" % (f["klasse"], _TEXT[f["klasse"]] % f["detail"]))
    return "\n".join(zeilen)
