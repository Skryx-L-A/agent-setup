"""Realitaet-Check: Fakten-Notizen gegen die Maschine, die prueft.

Fakten-Notizen nennen Pfade, Befehle und Dateien, die es inzwischen nicht mehr
gibt. Das hier findet das ohne Modell und rein textlich, identisch auf Mac und
Linux (Brain-5, PLAN-Erweiterung 8: "Fakten gegen die Maschine pruefen"):

- `~/...`-Pfade in Inline-Code und Codebloecken werden gegen den aktuellen
  Home-Ordner geloest und auf Existenz geprueft.
- Absolute Pfade unter `/Users/` oder `/home/` gelten nur als pruefbar, wenn
  sie UNTER dem aktuellen Home liegen. Alles andere zahlt als
  `andere-maschine`: der Vault laeuft auf zwei Maschinen mit anderen Homes
  (Mac `$HOME`, peer `/home/<user>`), ein `/home/...`-Pfad, der auf dem
  Mac fehlt, ist keine Veraltung, sondern ein peer-Pfad.
- Befehlsnamen am Zeilenanfang eines Codeblocks bzw. am Anfang eines
  Inline-Codes, die wie Werkbank-Werkzeuge aussehen (`wb-*`, `brain`,
  `pi-worker`, `claude-worker`, `vault-sync`), werden mit `shutil.which`
  geprueft.

Nicht geprueft (bewusst, keine Alarme ohne Substanz):
- Session-Notizen (`type: session` im Frontmatter oder `sessions`-Pfadteil) -
  sie sind Quellen, nicht dauerhafter Faktenbestand.
- `00-sources/`, `_meta/`, `secrets/` (Quellenlage, Werkzeug, Geheimnisse).
- Platzhalter (`<...>`, `$VAR`, `*`, `...`) und Pfade in `secrets`.

Nur gelesenes Vokabular: Pfade und Befehlsnamen in Codekontext. Prosa bleibt
unbetroffen - ein "brain" im Fliesstext ist kein Befehl.

Kein Modell, keine Schreiboperation: das Modul ist eine reine Funktion von
Vault-Inhalt und Maschinenzustand und laeuft in Sekunden.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import os
import re
import shutil
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config
from .frontmatter import parse as parse_frontmatter

# `shutil.which` als Modulattribut: Tests monkeypatchen genau dieses, damit
# die Suite auf jeder Maschine deterministisch ist (dieselbe Lehre wie
# conftest.py `_keine_echten_limits`: kein Test darf am echten Zustand dieser
# Maschine haengen).
which = shutil.which


def _exists(p: Path) -> bool:
    """Existenzprüfung als Modulattribut, damit Tests sie deterministisch
    vorgibt koennen (gleicher Grund wie `which` oben)."""
    return p.exists()

# Gescannt werden die vier Wissenszweige plus die Wurzeldateien; alles andere
# (00-sources, _meta, secrets, .git, .obsidian, ...) ist ausserhalb.
REVIEW_QUEUE = "review-queue.md"
SCAN_DIRS = ("10-global", "20-projects", "30-topics", "40-people")
# `old-machine` beschreibt ausdruecklich die alte Maschine (Stand 2026-09 nicht mehr
# vorhanden): dort fehlende Pfade sind Geschichte, nicht Veraltung.
SKIP_DIRS = {"00-sources", "_meta", "secrets", "sessions", "old-machine"}

# Snapshots vor dem Loeschen sind vergaenglich (Aufraeumen ist erwuenscht); ein Verweis
# auf einen geleerten Snapshot ist Herkunft, kein veralteter Fakt.
SKIP_PREFIXES = ("~/.local/trash-snapshots/",)

# Bekannte, bewusst stehenbleibende Pfade (historische Aussage, Anleitung zum Anlegen):
# Tabulator-getrennt `notiz<TAB>pfad<TAB>grund`, vault-relativ; `*` als Pfad gilt fuer die ganze Notiz. Zeilennummern bleiben
# absichtlich draussen, damit Bearbeitungen die Ausnahme nicht verlieren.
BEKANNT_DATEI = "_meta/realitaet-bekannt.tsv"

# Pfade in den Geheimnisordner werden niemals gecheckt - weder als Treffer
# noch als Fehler, damit der Bericht nie einen secrets-Pfad wiederholt.
SECRET_MARKER = "secrets"

# Werkbank-Werkzeuge, deren Fehlen ein Befund ist. `wb-*` als Familie,
# Einzelnamen als Menge - neue wb-*-Werkzeuge werden dadurch automatisch erwischt.
TOOLS = frozenset({"brain", "pi-worker", "claude-worker", "vault-sync"})

STATUS_FEHLT = "fehlt"
STATUS_ANDERE = "andere-maschine"

# Segment-Zeichen. Die Platzhalter-Zeichen `<`, `>`, `$` und `*` sind
# bewusst DABEI: `~/AI/<projekt>/x.md` wuerde andernfalls bei `~/AI`
# abgebrochen und als echter, fehlender Pfad alarmieren. Als Ganzes erfasst
# wird der Treffer dann von is_placeholder() aussortiert.
_SEG = r"[\w.@+\-*$<>\[\]…]+"   # \w: Umlaute (`Wasbüttel`) und `_`
# Tilde-Pfade und absolute Pfade in den beiden Home-Roots. Die Lookbehind
# verhindert Doppelzuege (`~/Users/...` wird als EIN Tilde-Pfad erfasst,
# nicht noch mal von innen als `/Users/...`), Treffer mitten im Wort und
# `home`-/`Users`-NAMENSTEELE als Pfadkomponente (`/opt/home/bin`,
# `{tmp}/home/x`): ein `/home/...`-Treffer zaehlt nur, wenn ihm kein
# Pfadzeichen oder Wortzeichen vorsteht - also nur als erster Pfadteil.
PATH_RE = re.compile(
    r"(?<![\w.~/-])"
    r"(?:~(?:/" + _SEG + r")+|(?:/Users|/home)/" + _SEG + r"(?:/" + _SEG + r")*)"
)
QUOTED_PATH_RE = re.compile(r'"((?:~|/Users|/home)/[^"\n$`]+)"')
# Inline-Code, einzeilig. Mehrzeiliger Inline-Code ist in Markdown kein
# gebruechlicher Fall; Codebloecke laufen ueber die Fence-Erkennung.
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
# CommonMark-Fence: 0-3 Einrueckung, ``` oder ~~~.
FENCE_RE = re.compile(r"^[ ]{0,3}(```|~~~)")


@dataclass(frozen=True)
class Befund:
    """Ein einzelner Realitaet-Treffer in einer Notiz."""
    pfad_notiz: str   # vault-relativ, posix
    zeile: int        # 1-basiert
    art: str          # "pfad" | "befehl"
    wert: str         # der geprüfte Pfad bzw. der Befehlsname, wie in der Notiz
    status: str       # "fehlt" | "andere-maschine"


def is_placeholder(value: str) -> bool:
    """Platzhalter-Pfade sind keine Fakten: <...>, $VAR, *, ... und ...."""
    return ("..." in value or "…" in value or "<" in value
            or ">" in value or "$" in value or "*" in value)


def _home_match(value: str, home: Path) -> bool:
    """True, wenn der absolute Pfad unter dem aktuellen Home liegt."""
    h = str(home)
    return value == h or value.startswith(h + os.sep)


def _is_tool(name: str) -> bool:
    if name in TOOLS:
        return True
    if not name.startswith("wb-") or len(name) <= 3:
        return False       # `wb-` ALLEIN ist ein Prafix (Kill-Muster), kein Werkzeug
    # Ein `wb-*`-Token mit Platzhalter-Zeichen ist ein Glob, einer mit Punkt
    # ein Dateiname (`wb-consistency.config.json`), einer mit Doppelpunkt eine
    # Pane-/Fenster-Referenz (`wb-AI:1`); gemessen: kein installiertes
    # wb-Werkzeug dieser Maschine traegt Punkt, * oder …, und der tmux-Name
    # ist der einzige reale Doppelpunkt-Fall.
    return not any(ch in name for ch in "*:.<$>…")


def _check_path(raw: str, rel: str, lineno: int, home: Path) -> list[Befund]:
    if SECRET_MARKER in raw or is_placeholder(raw) or raw.startswith(SKIP_PREFIXES):
        return []
    value = raw.rstrip(".")          # Satzpunkt am Zeilenende ist kein Namensteil
    if value.startswith("~/"):
        if _exists(home / value[2:]):
            return []
        return [Befund(rel, lineno, "pfad", value, STATUS_FEHLT)]
    if _home_match(value, home):
        if _exists(Path(value)):
            return []
        return [Befund(rel, lineno, "pfad", value, STATUS_FEHLT)]
    # Unter /Users/ oder /home/, aber nicht unter DEM Home: andere Maschine.
    return [Befund(rel, lineno, "pfad", value, STATUS_ANDERE)]


def _check_command(code: str, rel: str, lineno: int) -> list[Befund] | None:
    """Befehlsname am Anfang einer Codezeile bzw. eines Inline-Codes."""
    toks = code.strip().split()
    if toks and toks[0] == "$":     # Prompt-Zeichen: der Befehl steht dahinter
        toks = toks[1:]
    if not toks:
        return None
    name = toks[0].rstrip(".,:;")   # Satzzeichen am Zeilenende gehoert nicht zum Namen
    if not _is_tool(name):
        return None
    # Ein alleinstehender `wb-`-Name ohne Argumente ist fast immer eine tmux-Sitzung
    # (`wb-orch`, `wb-AI`): 32 von 32 solcher Treffer waren das am 2026-09-23. Als Befehl
    # zaehlt er nur mit Argumenten; die festen Werkzeuge in TOOLS gelten immer.
    if name not in TOOLS and len(toks) == 1:
        return None
    if which(name) is None:
        return [Befund(rel, lineno, "befehl", name, STATUS_FEHLT)]
    return None


def _whole_path(code: str) -> str | None:
    """Inline-Code, der als Ganzes EIN Pfad mit Leerzeichen ist
    (`~/Library/Application Support/...`): PATH_RE bricht am Leerzeichen ab und meldete
    sonst `~/Library/Application` als fehlend. Befehle (Optionen, Pipes) bleiben aussen vor."""
    s = code.strip()
    if " " not in s or not s.startswith(("~/", "/Users/", "/home/")):
        return None
    if " -" in s or any(ch in s for ch in "|;&`=→") or "  " in s:
        return None
    return s


def _check_code(code: str, rel: str, lineno: int,
                home: Path, inline: bool = False) -> list[Befund]:
    out: list[Befund] = []
    whole = _whole_path(code) if inline else None
    if whole is not None:
        return _check_path(whole, rel, lineno, home)
    # Pfade in Anfuehrungszeichen als Ganzes (Shell-Aufrufe mit `Application Support`).
    for raw in QUOTED_PATH_RE.findall(code):
        out += _check_path(raw, rel, lineno, home)
    code_rest = QUOTED_PATH_RE.sub('""', code)
    for raw in PATH_RE.findall(code_rest):
        out += _check_path(raw, rel, lineno, home)
    cmd = _check_command(code, rel, lineno)
    if cmd:
        out += cmd
    return out


def scan_text(text: str, rel: str, home: Path) -> list[Befund]:
    """Alle Code-Plätze eines Notiztextes pruefen. Fuer Tests und die Pipeline."""
    befunde: list[Befund] = []
    fence_char: str | None = None
    for lineno, line in enumerate(text.splitlines(), 1):
        m = FENCE_RE.match(line)
        if m:
            ch = m.group(1)[0]
            if fence_char is None:
                fence_char = ch
            elif ch == fence_char:    # schliessender Fence
                fence_char = None
            continue
        if fence_char is not None:
            befunde += _check_code(line, rel, lineno, home)
        else:
            for span in INLINE_CODE_RE.findall(line):
                befunde += _check_code(span, rel, lineno, home, inline=True)
    return befunde


def _erzeugt(name: str) -> bool:
    """Generated files carry quoted text, not claims about this machine:
    reports and pipeline proposals (config.EXCLUDE_PREFIXES) and the review
    queue, whose rows cite paths from transcripts of other sessions."""
    return name == REVIEW_QUEUE or name.startswith(config.EXCLUDE_PREFIXES)


def iter_scan_files(vault: Path) -> list[Path]:
    """Alle .md-Dateien der vier Wissenszweige plus die Wurzeldateien."""
    out: list[Path] = []
    try:
        names = sorted(os.listdir(vault))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".md") or name.startswith(".") or _erzeugt(name):
            continue
        p = vault / name
        if p.is_file() and not p.is_symlink():
            out.append(p)
    for d in SCAN_DIRS:
        base = vault / d
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            here = Path(dirpath)
            dirnames[:] = sorted(x for x in dirnames
                                 if x not in SKIP_DIRS
                                 and not x.startswith(".")
                                 and not (here / x).is_symlink())
            for name in sorted(filenames):
                if not name.endswith(".md") or name.startswith(".") or _erzeugt(name):
                    continue
                p = here / name
                if p.is_file() and not p.is_symlink():
                    out.append(p)
    return out


def is_session_note(vault: Path, path: Path) -> bool:
    """Session-Notiz: `type: session` im Frontmatter oder `sessions`-Pfadteil."""
    try:
        rel = path.relative_to(vault)
    except ValueError:
        return False
    if "sessions" in rel.parts:
        return True
    try:
        fields, _ = parse_frontmatter(path.read_text(encoding="utf-8",
                                                     errors="replace"))
    except OSError:
        return False
    return str(fields.get("type") or "").strip().lower() == "session"


def load_bekannt(vault: Path) -> set[tuple[str, str]]:
    """(notiz, pfad)-Paare aus BEKANNT_DATEI; fehlt die Datei, ist die Menge leer."""
    try:
        text = (vault / BEKANNT_DATEI).read_text(encoding="utf-8")
    except OSError:
        return set()
    out = set()
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            out.add((parts[0].strip(), parts[1].strip()))
    return out


def _scan(vault: Path, home: Path) -> tuple[list[Befund], int]:
    """scan() plus Anzahl geprüfter Notizen (fuer Kopf/JSON)."""
    home = Path(os.path.expanduser(str(home))).resolve()
    befunde: list[Befund] = []
    checked = 0
    for path in iter_scan_files(vault):
        if is_session_note(vault, path):
            continue
        checked += 1
        rel = path.relative_to(vault).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        befunde += scan_text(text, rel, home)
    bekannt = load_bekannt(vault)
    befunde = [b for b in befunde
               if (b.pfad_notiz, b.wert) not in bekannt and (b.pfad_notiz, "*") not in bekannt]
    return befunde, checked


def scan(vault: Path, home: Path, remote: str | None = None,
         remote_timeout: float = 8.0) -> list[Befund]:
    """Alle Notizen des Vaults gegen die Maschine `home` pruefen.

    Mit `remote` (ssh-Host, z.B. "peer") werden lokal fehlende Pfade in EINEM ssh-Aufruf auf
    der anderen Maschine geprueft; dort vorhandene gelten als `andere-maschine`. Gemessen
    2026-09-23: 48 von 93 lokal fehlenden Pfaden lagen auf peer — maschinengebunden, nicht
    veraltet. Ist der Host nicht erreichbar, bleibt das Ergebnis unveraendert (kein Fehler)."""
    befunde = _scan(vault, home)[0]
    if remote:
        befunde = mit_gegenmaschine(befunde, remote, remote_timeout)
    return befunde


def mit_gegenmaschine(befunde: list[Befund], remote: str,
                      timeout: float = 8.0) -> list[Befund]:
    """Lokal fehlende Pfade auf `remote` pruefen und dort vorhandene umstufen."""
    kandidaten = sorted({b.wert for b in befunde
                         if b.status == STATUS_FEHLT and b.art == "pfad"})
    if not kandidaten:
        return befunde
    skript = ('while IFS= read -r p; do q="${p/#\\~/$HOME}"; '
              '[ -e "$q" ] && printf "%s\\n" "$p"; done')
    try:
        out = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={int(timeout)}",
             remote, "bash", "-c", shlex.quote(skript)],
            input="\n".join(kandidaten) + "\n", capture_output=True, text=True,
            timeout=timeout + 4)
    except (OSError, subprocess.TimeoutExpired):
        return befunde
    if out.returncode != 0:
        return befunde
    dort = set(out.stdout.splitlines())
    return [Befund(b.pfad_notiz, b.zeile, b.art, b.wert, STATUS_ANDERE)
            if b.status == STATUS_FEHLT and b.wert in dort else b
            for b in befunde]


def _zaehlung(befunde: list[Befund]) -> dict:
    return {
        "gesamt": len(befunde),
        "fehlt": sum(1 for b in befunde if b.status == STATUS_FEHLT),
        "andere_maschine": sum(1 for b in befunde
                               if b.status == STATUS_ANDERE),
    }


def report(befunde: list[Befund], gepruefte_notizen: int | None = None) -> str:
    """Markdown-Bericht: Kopf mit Zaehlung, danach nur die `fehlt`-Befunde,
    gruppiert nach Notiz, mit Zeilennummern."""
    fehlt = [b for b in befunde if b.status == STATUS_FEHLT]
    andere = [b for b in befunde if b.status == STATUS_ANDERE]
    z = _zaehlung(befunde)
    lines = ["# Realitaet-Check: Fakten gegen die Maschine", ""]
    if gepruefte_notizen is not None:
        plural = "en" if gepruefte_notizen != 1 else ""
        lines.append(f"Geprueft: {gepruefte_notizen} Notiz{plural} "
                     "(10-global, 20-projects, 30-topics, 40-people, Wurzel).")
        lines.append("")
    lines.append(f"Zaehlung: {z['gesamt']} Befunde, davon {z['fehlt']} fehlt, "
                 f"{z['andere_maschine']} andere-maschine (Pfade auf anderer "
                 "Maschine sind kein Fehler und werden nicht gelistet).")
    lines.append("")
    if not fehlt:
        lines.append("Keine fehlenden Pfade oder Befehle.")
        return "\n".join(lines) + "\n"
    by_note: dict[str, list[Befund]] = {}
    for b in fehlt:
        by_note.setdefault(b.pfad_notiz, []).append(b)
    for rel in sorted(by_note):
        items = sorted(by_note[rel], key=lambda b: b.zeile)
        lines.append(f"## {rel} ({len(items)})")
        lines.append("")
        for b in items:
            label = "Pfad" if b.art == "pfad" else "Befehl"
            lines.append(f"- Zeile {b.zeile}: {label} fehlt: `{b.wert}`")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m gardener.realitaet",
        description="Fakten-Notizen gegen die Maschine pruefen: Pfade und "
                    "Werkbank-Befehle, ohne Modell. Liest nur, schreibt nichts.")
    ap.add_argument("--vault", default=str(config.DEFAULT_VAULT),
                    help="Vault-Wurzel (Default: %(default)s)")
    ap.add_argument("--home", default=str(Path.home()),
                    help="Home-Ordner, gegen den Pfade geloest werden "
                         "(Default: %(default)s)")
    ap.add_argument("--json", action="store_true",
                    help="JSON statt Markdown")
    ap.add_argument("--remote", default=None,
                    help="ssh-Host der anderen Maschine; dort vorhandene Pfade gelten "
                         "als andere-maschine (z.B. peer bzw. mac)")
    args = ap.parse_args(argv)

    vault = Path(os.path.expanduser(args.vault))
    if not vault.is_dir():
        print(f"Vault nicht gefunden: {vault}", file=sys.stderr)
        return 2
    befunde, checked = _scan(vault, Path(args.home))
    if args.remote:
        befunde = mit_gegenmaschine(befunde, args.remote)
    if args.json:
        print(json.dumps({
            "vault": str(vault),
            "gepruefte_notizen": checked,
            "zaehlung": _zaehlung(befunde),
            "befunde": [asdict(b) for b in befunde],
        }, ensure_ascii=False, indent=2))
    else:
        print(report(befunde, checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
