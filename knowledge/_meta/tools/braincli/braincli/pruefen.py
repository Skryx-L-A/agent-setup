"""`brain pruefen <notiz>`: eine kanonische Seite als geprueft markieren (Guru-/Notion-Prinzip).

Setzt im Frontmatter `verified: JJJJ-MM-TT`, `verified-by: <Handle aus IDENTITY.md>` und
`review-after: "JJJJ-MM"` (heute + 3 Monate). Sonst aendert der Befehl nichts: der Text bleibt
Byte fuer Byte, es wird nichts committet und nichts eingebettet.

Verweigert (Exit 2): Session-/Quellnotizen, `secrets/`, Notizen, an denen je ein anderer
Git-Autor als `config.GIT_AUTHOR` committet hat (ein Mitnutzer), Notizen ausserhalb des Vaults, nicht
kanonische Seiten und Dateien mit mehreren Frontmatter-Bloecken. Kanonisch: `type: system|decision|
pitfall|term` und alle KERN.md/STATUS.md (`gardener.lint.ist_kanonisch`). Dass ein Mensch die Seite
wirklich gelesen hat, sagt der Aufrufer mit dem Befehl; das Werkzeug prueft es nicht.
"""
from __future__ import annotations

import datetime as dt
import os
import re
import tempfile
from pathlib import Path

from gardener import config, frontmatter, protect
from gardener.lint import KANONISCH_DATEIEN, KANONISCH_TYPEN, PRUEF_MONATE
from gardener.vault import build_resolver, key_of, load_notes

_HANDLE_RE = re.compile(r"GitHub\s+`?([A-Za-z0-9][A-Za-z0-9-]*)`?")
_BLOCK_RE = frontmatter.BLOCK_RE


class Verweigert(Exception):
    """Der Befehl fasst diese Notiz nicht an; `str(e)` sagt warum."""


def handle_aus_identity(vault: Path) -> str | None:
    """`GitHub <Handle>` aus der lokalen, gitignorierten IDENTITY.md des Vaults."""
    try:
        text = (Path(vault) / "IDENTITY.md").read_text(encoding="utf-8")
    except OSError:
        return None
    m = _HANDLE_RE.search(text)
    return m.group(1) if m else None


def review_nach(today: dt.date, monate: int = PRUEF_MONATE) -> str:
    idx = today.year * 12 + (today.month - 1) + monate
    return f"{idx // 12}-{idx % 12 + 1:02d}"


def _finden(vault: Path, angabe: str) -> Path:
    """Pfad im Vault (relativ oder absolut) oder, sonst, Dateiname/Titel/Alias einer Notiz."""
    for kandidat in (Path(angabe), vault / angabe):
        if kandidat.is_file():
            return kandidat.resolve()
    treffer = build_resolver(load_notes(vault)).get(key_of(angabe))
    if treffer is None:
        raise Verweigert(f"keine Notiz gefunden: {angabe}")
    return treffer.path


def _autoren_fremd(pfad: Path) -> list[str]:
    """Git-Autoren der Datei ausser dem eigenen; aus dem Repo, in dem die Datei liegt (Spaces
    haben ein eigenes .git, `git -C <vault>` sieht sie nicht)."""
    eigen = protect.own_author_name()
    return [a for a in protect.AuthorCache(pfad.parent).authors_of(pfad.name)
            if a.casefold() != eigen]


def _setzen(block: str, felder: dict[str, str]) -> str:
    zeilen = block.split("\n")
    for schluessel, wert in felder.items():
        neu = f"{schluessel}: {wert}"
        muster = re.compile(rf"^{re.escape(schluessel)}:")
        for i, z in enumerate(zeilen):
            if muster.match(z):
                zeilen[i] = neu
                break
        else:
            zeilen.append(neu)
    return "\n".join(zeilen)


def pruefen(vault: Path, angabe: str, handle: str | None = None,
            heute: dt.date | None = None, trocken: bool = False) -> dict:
    """Markiert die Notiz als geprueft und liefert `{rel, verified, verified_by, review_after}`.
    Wirft `Verweigert`, wenn die Notiz tabu oder nicht kanonisch ist."""
    vault = Path(vault).resolve()
    heute = heute or dt.date.today()
    handle = (handle or handle_aus_identity(vault) or "").strip()
    if not handle:
        raise Verweigert("kein Handle: `GitHub <Handle>` in IDENTITY.md fehlt, `--von` angeben")
    pfad = _finden(vault, angabe)
    try:
        rel = pfad.relative_to(vault).as_posix()
    except ValueError:
        raise Verweigert(f"ausserhalb des Vaults: {pfad}") from None
    if protect.is_secret(rel):
        raise Verweigert(f"{rel}: secrets wird nie angefasst")
    text = pfad.read_text(encoding="utf-8")
    if protect.is_session_or_source(rel, text):
        raise Verweigert(f"{rel}: Session-/Quellnotiz, unveraenderliches Archiv")
    fremd = _autoren_fremd(pfad)
    if fremd:
        raise Verweigert(f"{rel}: fremde Git-Autoren ({', '.join(fremd)}); "
                         "der Eigentuemer prueft selbst")
    fm, _ = frontmatter.parse(text)
    ntype = str(fm.get("type") or "note").strip()
    if ntype not in KANONISCH_TYPEN and pfad.name not in KANONISCH_DATEIEN:
        raise Verweigert(f"{rel}: nicht kanonisch (type: {ntype}); geprueft werden "
                         f"{'|'.join(sorted(KANONISCH_TYPEN))} sowie KERN.md/STATUS.md")
    blocks, _ = frontmatter.split_blocks(text)
    m = _BLOCK_RE.match(text)
    if len(blocks) != 1 or not m:
        raise Verweigert(f"{rel}: {len(blocks)} Frontmatter-Bloecke, erwartet genau einer")
    ergebnis = {"rel": rel, "verified": heute.isoformat(), "verified_by": handle,
                "review_after": review_nach(heute)}
    if trocken:
        return ergebnis
    block = _setzen(m.group(1), {"verified": ergebnis["verified"],
                                 "verified-by": handle,
                                 "review-after": f'"{ergebnis["review_after"]}"'})
    neu = text[:m.start(1)] + block + text[m.end(1):]
    fd, tmp = tempfile.mkstemp(dir=pfad.parent, prefix=".pruefen-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(neu)
        os.chmod(tmp, pfad.stat().st_mode & 0o777)
        os.replace(tmp, pfad)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return ergebnis


def cmd_pruefen(args) -> int:
    config.bind_vault(args.vault)
    try:
        r = pruefen(Path(args.vault), args.notiz, handle=args.von, trocken=args.dry_run)
    except Verweigert as e:
        print(f"verweigert: {e}")
        return 2
    print(f"{'wuerde pruefen' if args.dry_run else 'geprueft'}: {r['rel']} "
          f"(verified {r['verified']} von {r['verified_by']}, review-after {r['review_after']})")
    return 0


def add_parser(sub) -> None:
    p = sub.add_parser("pruefen", help="kanonische Seite als geprueft markieren "
                                       "(verified, verified-by, review-after +3 Monate)")
    p.add_argument("notiz", help="Pfad im Vault oder Titel/Dateiname der Notiz")
    p.add_argument("--von", help="Handle des Pruefers (Voreinstellung: IDENTITY.md)")
    p.add_argument("--dry-run", action="store_true", help="nur zeigen, nichts schreiben")
    p.set_defaults(func=cmd_pruefen)
