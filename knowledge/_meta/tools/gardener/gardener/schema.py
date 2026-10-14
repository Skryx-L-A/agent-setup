"""Schema-4-Lint: Pflichtfelder, Typ-Vokabular, Klasse gegen Pfad (b6-struktur, 2026-09-28).

Nur Standardbibliothek und keine Importe aus diesem Paket: der pre-commit-Hook
(`git-hooks/notiz_lint.py`) laedt diese Datei per Pfad und laeuft mit dem System-python3.
Eine Definition der Regeln fuer Hook, `gardener.lint.run_lint` und `brain doctor`.

Was geprueft wird (Bezug: ana-struktur, Empfehlung 2):

- Pflichtfelder `id`, `schema`, `class`, `type`;
- `type` aus dem Vokabular (heutige Werte plus decision/pitfall/system/term);
- `class` aus source|knowledge|derived|meta und passend zum Pfad: `sessions/` und `00-sources/`
  sowie `type: session` verlangen `class: source` (die Schutzregel "Sitzungen nie umschreiben"
  haengt am Pfad, der Waisen-Code an `class` - hier wird beides in Deckung gebracht);
- genau ein Frontmatter-Block (Basic-Memory-Rest);
- keine Claude-Memory-Felder `name:` / `metadata:` auf oberster Ebene;
- `id` ist eine ULID.

Neu gegen Bestand: eine Notiz mit `created` ab `STICHTAG` zaehlt als neu, jede andere (auch
ohne `created`) als Bestand. Der Hook behandelt jede vorgemerkte Datei als neu. Nie blockierend.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

STICHTAG = "2026-09-28"

PFLICHTFELDER = ("id", "schema", "class", "type")
TYPEN = frozenset({
    # heutige Werte
    "note", "reference", "session", "incident", "decision", "person", "asset", "report", "secret",
    # neue Typen mit eigener Vorlage (Schema 4, Stand 2026-09-28)
    "pitfall", "system", "term",
})
KLASSEN = frozenset({"source", "knowledge", "derived", "meta"})
MEMORY_FELDER = ("name", "metadata")

ZWEIGE = ("00-sources/", "10-global/", "20-projects/", "30-topics/", "40-people/")
AUSGENOMMEN_NAMEN = frozenset({"MOC.md", "DECISIONS.md", "README.md", "brain-vorschlaege.md",
                               "review-queue.md"})
# erzeugte Berichte (config.EXCLUDE_PREFIXES): tragen keine Notiz-Identitaet
AUSGENOMMEN_PRAEFIXE = ("gardener-report-", "brain-health-", "dream-report-", "brain-run-",
                        "brain-vorschlaege")

_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_BLOCK_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):[ \t]*(.*)$")
_CREATED_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


@dataclass(frozen=True)
class Befund:
    kind: str          # pflichtfeld | typ | klasse | klasse-pfad | mehrfach-frontmatter | memory-rest | id-format
    detail: str


@dataclass
class NotizBefund:
    rel: str
    befunde: list[Befund]
    neu: bool

    def text(self) -> str:
        return "; ".join(b.detail for b in self.befunde)


@dataclass
class Bericht:
    neu: list[NotizBefund] = field(default_factory=list)
    bestand: list[NotizBefund] = field(default_factory=list)
    geprueft: int = 0

    def je_art(self, alle: list[NotizBefund]) -> dict[str, int]:
        out: dict[str, int] = {}
        for nb in alle:
            for kind in {b.kind for b in nb.befunde}:
                out[kind] = out.get(kind, 0) + 1
        return out


def im_geltungsbereich(rel: str) -> bool:
    """rel: Pfad relativ zur Vault-Wurzel, mit `/`."""
    if not rel.endswith(".md") or not rel.startswith(ZWEIGE):
        return False
    teile = rel.split("/")
    if "_assets" in teile or any(t.startswith(".") for t in teile):
        return False
    name = teile[-1]
    return name not in AUSGENOMMEN_NAMEN and not name.startswith(AUSGENOMMEN_PRAEFIXE)


def _bloecke(text: str) -> list[str]:
    """Fuehrende Frontmatter-Bloecke ohne Trenner; Basic-Memory trennt seinen vorgesetzten
    Block per Leerzeile vom eigenen."""
    out: list[str] = []
    rest = text.lstrip("﻿")
    while True:
        m = _BLOCK_RE.match(rest.lstrip("\n"))
        if not m:
            break
        block = m.group(1)
        erste = next((z for z in block.splitlines() if z.strip() and not z.lstrip().startswith("#")), "")
        if not _KEY_RE.match(erste):
            break                   # `---`-Linie im Text, kein Frontmatter
        out.append(block)
        rest = rest.lstrip("\n")[m.end():]
    return out


def felder(text: str) -> tuple[dict[str, str], int]:
    """(Felder oberster Ebene, spaetere Bloecke gewinnen; Anzahl Bloecke)."""
    bloecke = _bloecke(text)
    out: dict[str, str] = {}
    for block in bloecke:
        for zeile in block.splitlines():
            m = _KEY_RE.match(zeile)
            if m:
                wert = re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("'\"")
                out[m.group(1)] = wert
    return out, len(bloecke)


def _klasse_erwartet(rel: str, typ: str) -> str | None:
    teile = rel.split("/")
    if rel.startswith("00-sources/") or "sessions" in teile[:-1] or typ == "session":
        return "source"
    return None


def pruefe(rel: str, text: str) -> list[Befund]:
    """Befunde einer Notiz; leer = in Ordnung. Erzeugte Seiten (class: derived,
    gardener-generated) sind ausgenommen: der Gaertner besitzt sie."""
    f, n_bloecke = felder(text)
    if n_bloecke == 0:
        return [Befund("pflichtfeld", "kein Frontmatter")]
    if f.get("class") == "derived" or "gardener-generated" in f:
        return []
    out: list[Befund] = []
    fehlt = [k for k in PFLICHTFELDER if not f.get(k)]
    if fehlt:
        out.append(Befund("pflichtfeld", "Pflichtfeld fehlt: " + ", ".join(fehlt)))
    if f.get("id") and not _ULID_RE.match(f["id"]):
        out.append(Befund("id-format", f"id '{f['id'][:30]}' ist keine ULID"))
    typ = f.get("type", "")
    if typ and typ not in TYPEN:
        out.append(Befund("typ", f"type '{typ}' nicht im Vokabular ({'|'.join(sorted(TYPEN))})"))
    klasse = f.get("class", "")
    if klasse and klasse not in KLASSEN:
        out.append(Befund("klasse", f"class '{klasse}' unbekannt ({'|'.join(sorted(KLASSEN))})"))
    erwartet = _klasse_erwartet(rel, typ)
    if erwartet and klasse and klasse in KLASSEN and klasse != erwartet:
        grund = "Pfad sessions/ oder 00-sources/" if typ != "session" else "type: session"
        out.append(Befund("klasse-pfad", f"{grund} verlangt class: {erwartet}, steht class: {klasse}"))
    if n_bloecke > 1:
        out.append(Befund("mehrfach-frontmatter", f"{n_bloecke} Frontmatter-Bloecke (Basic-Memory-Rest)"))
    reste = [k for k in MEMORY_FELDER if k in f]
    if reste:
        out.append(Befund("memory-rest", "Claude-Memory-Felder: " + ", ".join(k + ":" for k in reste)))
    return out


def ist_neu(text: str, stichtag: str = STICHTAG) -> bool:
    """`created` ab Stichtag; ohne lesbares `created` gilt die Notiz als Bestand."""
    m = _CREATED_RE.match(felder(text)[0].get("created", ""))
    return bool(m) and m.group(1) >= stichtag


def scan_vault(vault: str, stichtag: str = STICHTAG) -> Bericht:
    """Alle Notizen im Geltungsbereich, getrennt nach neu und Bestand (nur Lesen)."""
    bericht = Bericht()
    vault = os.path.abspath(vault)
    for zweig in ZWEIGE:
        wurzel = os.path.join(vault, zweig.rstrip("/"))
        for pfad, dirs, dateien in os.walk(wurzel):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "_assets")
            for name in sorted(dateien):
                rel = os.path.relpath(os.path.join(pfad, name), vault).replace(os.sep, "/")
                if not im_geltungsbereich(rel):
                    continue
                try:
                    with open(os.path.join(pfad, name), encoding="utf-8", errors="replace") as fh:
                        text = fh.read()
                except OSError:
                    continue
                bericht.geprueft += 1
                befunde = pruefe(rel, text)
                if befunde:
                    nb = NotizBefund(rel, befunde, ist_neu(text, stichtag))
                    (bericht.neu if nb.neu else bericht.bestand).append(nb)
    return bericht
