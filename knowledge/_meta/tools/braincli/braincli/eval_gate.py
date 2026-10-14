"""`brain eval gate`: Tor T1 der Suche als duenner Aufruf von `_meta/tools/eval/blind_eval.py tor`.

Alles hinter `gate` geht unveraendert an `blind_eval.py tor` (Flags: `blind_eval.py tor --help`),
der Exit-Code kommt unveraendert zurueck: 0 bestanden, 3 nicht bestanden, 4 ungueltig (zu viele
ungeurteilte Paare, Rueckfall des Rerankers oder der LLM-Stufe (ueber 5 %), veralteter Index, verschiedener Vault-Stand oder Modell-Digest
zwischen Basis und Variante), 2 verweigert (Testhaelfte schon gesehen, auch als `--basis`, oder zwei
verschiedene `BRAIN_SEARCH_LLM_CACHE`). Zwei Zutaten gehoeren hierher:

- Interpreter: das eigene venv des Messwerkzeugs (`eval/.venv`), sonst der Interpreter dieses
  Prozesses (das braincli-venv reicht, `blind_eval.py` braucht nur PyYAML).
- Pfade absolut: die Suche laeuft mit cwd=Vault, ein relativer Pfad (`--basis-brain ../x/brain`)
  scheiterte dort (b6-suche). Pfad-Flags werden hier gegen das Arbeitsverzeichnis des Aufrufers
  aufgeloest; `--vault` folgt dem globalen `brain --vault`, wenn er nicht selbst gesetzt ist.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2]
EVAL = TOOLS / "eval"
BLIND_EVAL = EVAL / "blind_eval.py"

# Flags, deren Wert ein Pfad ist; bei den brain-Befehlen zaehlt nur das erste Wort
# (`--basis-brain "uv run brain"` behaelt seine Argumente).
_PFAD_FLAGS = {"--basis-lauf", "--vault", "--ungeurteilt-out"}
_BRAIN_FLAGS = {"--basis-brain", "--variante-brain"}


def interpreter() -> str:
    eigen = EVAL / ".venv" / "bin" / "python"
    return str(eigen) if eigen.exists() else sys.executable


def _absolut(wert: str) -> str:
    return str(Path(wert).expanduser().resolve())


def _brain_absolut(wert: str) -> str:
    erstes, _, rest = wert.strip().partition(" ")
    if "/" in erstes or erstes.startswith("~"):
        erstes = _absolut(erstes)
    return f"{erstes} {rest}".rstrip()


def absolute_argumente(rest: list[str], vault: str | None) -> list[str]:
    """Die Argumente fuer `blind_eval.py tor` mit absoluten Pfaden."""
    out: list[str] = []
    gesetzt: set[str] = set()
    it = iter(rest)
    for arg in it:
        flag, gleich, wert = arg.partition("=")
        if flag in _PFAD_FLAGS | _BRAIN_FLAGS:
            gesetzt.add(flag)
            if not gleich:
                wert = next(it, "")
            wandel = _absolut if flag in _PFAD_FLAGS else _brain_absolut
            out += [flag, wandel(wert)] if wert else [flag]
        else:
            out.append(arg)
    if "--vault" not in gesetzt and vault:
        out += ["--vault", _absolut(vault)]
    return out


def trenner(argv: list[str]) -> list[str]:
    """`--` hinter `eval gate` einsetzen: argparse kennt die Flags von `tor` nicht und lehnt sie
    sonst vor dem REMAINDER-Argument ab. Nur wenn `eval gate` direkt aufeinander folgen und
    nach einem optionalen globalen `--vault X` kommen."""
    i = 0
    if argv[:1] and argv[0].startswith("--vault"):
        i = 1 if "=" in argv[0] else 2
    if argv[i:i + 2] == ["eval", "gate"] and argv[i + 2:i + 3] != ["--"]:
        return [*argv[:i + 2], "--", *argv[i + 2:]]
    return argv


def cmd_gate(args) -> int:
    rest = list(args.gate_args or [])
    if rest[:1] == ["--"]:
        rest = rest[1:]
    if not BLIND_EVAL.exists():
        print(f"brain eval gate: {BLIND_EVAL} fehlt", file=sys.stderr)
        return 1
    cmd = [interpreter(), str(BLIND_EVAL), "tor", *absolute_argumente(rest, args.vault)]
    try:
        return subprocess.run(cmd).returncode
    except KeyboardInterrupt:
        return 130


def add_parser(sub) -> None:
    p = sub.add_parser("eval", help="Messwerkzeuge der Suche (Tor T1)")
    esub = p.add_subparsers(dest="evalcmd", required=True)
    g = esub.add_parser(
        "gate", help="Tor T1: Basis und Variante auf der Testhaelfte messen, gepaart vergleichen "
                     "(Exit 0 bestanden, 3 nicht bestanden, 4 ungueltig, 2 verweigert)")
    g.add_argument("gate_args", nargs=argparse.REMAINDER,
                   help="unveraendert an `blind_eval.py tor` (z. B. --name X --basis-brain PFAD "
                        "[--variante-brain PFAD] [--split test])")
    g.set_defaults(func=cmd_gate)
