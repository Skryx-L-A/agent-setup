"""Waehlbares Einbettungsmodell fuer `brain search` (BRAIN5-PLAN Nr. 29, 31).

Zwei Wege, nie gemischt:

- `embeddinggemma` (bisheriger Weg): Vektoren aus dem Gaertner-Index
  (`_meta/tools/gardener/state/gardener.db`) plus dem MOC-Nebenspeicher
  (`extra_embed.py`). Anfrage ohne Praefix.
- ein Modell mit EIGENEM Index (`qwen3-embedding-0.6b`): eine SQLite-Datei je
  Modell unter `_meta/tools/braincli/state/index-<name>.db`. Der Kopf haelt
  Modellname, Ollama-Tag, Ollama-Digest, Dimension, Anfragepraefix und
  Dokumentvorschrift. Die Suche liest nur einen Index, dessen Kopf zum
  gewaehlten Modell passt; sonst faellt sie ganz auf `embeddinggemma` zurueck
  (Anfrage UND Dokumente), nie auf eine Mischung.

Aufbau (`brain index bauen`) schreibt immer eine neue Datei daneben
(`index-<name>.db.neu`), uebernimmt dabei unveraenderte Vektoren aus dem
alten Index nur, wenn dessen Kopf in Modell, Digest, Dimension und Vorschrift
uebereinstimmt, und tauscht erst am Ende per `os.replace` - ein
abgebrochener Lauf laesst den alten Index unberuehrt.

Wahl: `BRAIN_EMBED_MODELL` (z.B. `embeddinggemma` fuer den Rueckweg), sonst
`STANDARD_MODELL`. Messung und Entscheidung: `_meta/tools/eval/suche-einbettung/`.
"""
from __future__ import annotations

import datetime as dt
import math
import os
import sqlite3
import struct
from dataclasses import dataclass
from pathlib import Path

from gardener import config, vault
from gardener.linking import chunk_text
from gardener.ollama import OllamaClient, OllamaError, OllamaUnavailable

ENV = "BRAIN_EMBED_MODELL"
# Vektoren derselben Vorschrift sind wiederverwendbar; eine Aenderung an
# Abschnittsbildung oder Mittelung erhoeht die Zahl und erzwingt Neuaufbau.
# v2 (e28, 2026-09-27): Note.embed_text cuts the gardener-managed ## Relations
# section; the "r" key mark keeps vectors of the rollback rule apart.
# v3 (b6-embedfm, 2026-09-28): Note.embed_text ohne Frontmatter, Schluessel
# ueber den eingebetteten Text (Note.embed_hash) statt ueber die ganze Datei.
INDEX_VERSION = 3
VORSCHRIFT = (f"v{INDEX_VERSION}: chunk_text({config.EMBED_CHUNK_CHARS}/"
              f"{config.EMBED_CHUNK_OVERLAP}/max{config.EMBED_MAX_CHUNKS}) aus Note.embed_text (ohne Frontmatter), "
              "je Abschnitt L2-normiert, gemittelt, erneut L2-normiert; "
              "Korpus braincli.vault.load_search_notes (mit MOC.md)")


@dataclass(frozen=True)
class Modell:
    name: str               # Wert fuer BRAIN_EMBED_MODELL und Indexkopf
    ollama: str             # Ollama-Tag
    dimension: int
    anfrage_praefix: str = ""
    eigener_index: bool = False
    # Fester Kontext fuer JEDEN Aufruf (Bau und Suche): ein anderer num_ctx
    # laedt das Modell in Ollama neu. Ohne Angabe nimmt Ollama den vollen
    # Modellkontext (qwen3-embedding: 32768) und belegt 4,01 GB statt 2,15 GB
    # (gemessen 24.09., Mac, Ollama 0.32.5); die Vektoren sind gleich.
    num_ctx: int | None = None


QWEN3_ANFRAGE = ("Instruct: Given a web search query, retrieve relevant passages "
                 "that answer the query\nQuery:")

MODELLE = {
    "embeddinggemma": Modell("embeddinggemma", config.EMBED_MODEL, 768),
    # Praefix exakt wie `prompts.query` in config_sentence_transformers.json des
    # Originalmodells (Revision 97b0c614), ohne Leerzeichen nach "Query:" -
    # so wurde j1 gemessen. Dokumente ohne Praefix.
    # num_ctx 4096: laengster Abschnitt (4000 Zeichen) hatte 1279 Token.
    "qwen3-embedding-0.6b": Modell("qwen3-embedding-0.6b", "qwen3-embedding:0.6b", 1024,
                                   QWEN3_ANFRAGE, eigener_index=True, num_ctx=4096),
}
ALIASE = {
    "gemma": "embeddinggemma", "embeddinggemma:latest": "embeddinggemma",
    "qwen3": "qwen3-embedding-0.6b", "qwen3-embedding:0.6b": "qwen3-embedding-0.6b",
    "qwen3-embedding": "qwen3-embedding-0.6b",
}
STANDARD_MODELL = "embeddinggemma"


class IndexFehlt(Exception):
    """Der eigene Index des gewaehlten Modells fehlt oder passt nicht."""


def modell_von(name: str | None) -> Modell:
    key = (name or "").strip().lower()
    key = ALIASE.get(key, key)
    if key not in MODELLE:
        raise ValueError(f"unbekanntes Einbettungsmodell {name!r}; bekannt: "
                         f"{', '.join(MODELLE)}")
    return MODELLE[key]


def aktives_modell(explizit: str | None = None) -> Modell:
    """`explizit` (CLI) vor `BRAIN_EMBED_MODELL` vor STANDARD_MODELL. Ein
    unbekannter Env-Wert faellt auf den Standard zurueck statt die Suche (und
    damit den Recall-Hook) scheitern zu lassen."""
    if explizit:
        return modell_von(explizit)
    try:
        return modell_von(os.environ.get(ENV) or STANDARD_MODELL)
    except ValueError:
        return MODELLE[STANDARD_MODELL]


def index_pfad(vault: Path, modell: Modell) -> Path:
    return config.tool_dir_for(vault, "braincli") / "state" / f"index-{modell.name}.db"


def schluessel(note) -> str:
    marke = "r" if vault.embed_relations() else ""
    return f"e{INDEX_VERSION}{marke}:{note.embed_hash}"


# -- Vektoren -----------------------------------------------------------------

def normiert(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n else list(v)


def _pack(v: list[float]) -> bytes:
    return struct.pack(f"<{len(v)}f", *v)


def _unpack(b: bytes) -> list[float]:
    return list(struct.unpack(f"<{len(b) // 4}f", b))


def _embed(client: OllamaClient, modell: Modell, text: str, keep_alive: str | None,
           truncate: bool) -> list[float]:
    nutzlast = {"model": modell.ollama, "input": text, "truncate": truncate}
    if modell.num_ctx:
        nutzlast["options"] = {"num_ctx": modell.num_ctx}
    if keep_alive is not None:
        nutzlast["keep_alive"] = keep_alive
    data = client._post_retrying("/api/embed", nutzlast, "embed")
    if data is None:
        raise OllamaError("embedding failed (transient)")
    embs = data.get("embeddings") or []
    if not embs:
        raise OllamaError(f"empty embedding response: {data}")
    return embs[0]


def anfrage_vektor(client: OllamaClient, modell: Modell, anfrage: str,
                   keep_alive: str | None) -> list[float]:
    """Anfragevektor mit dem Praefix des Modells. Lange Eingaben (der
    Recall-Hook reicht ganze Prompts durch) werden wie bisher auf
    EMBED_MAX_CHARS Zeichen gekappt; Ollama kuerzt den Rest still."""
    text = (modell.anfrage_praefix + anfrage)[:config.EMBED_MAX_CHARS]
    return normiert(_embed(client, modell, text, keep_alive, truncate=True))


def dokument_vektor(client: OllamaClient, modell: Modell, text: str) -> list[float]:
    """Abschnitte einzeln (nie im Batch, siehe BEFUNDE), je Abschnitt normiert,
    gemittelt, erneut normiert. `truncate=False`: ein Abschnitt ueber dem
    Kontext ist ein Fehler, keine stille Kuerzung."""
    teile = [normiert(_embed(client, modell, c, None, truncate=False))
             for c in chunk_text(text)]
    summe = [sum(v[i] for v in teile) / len(teile) for i in range(len(teile[0]))]
    return normiert(summe)


def ollama_digest(client: OllamaClient, tag: str) -> str | None:
    try:
        data = client._get("/api/tags")
    except OllamaError:
        return None
    for m in data.get("models", []):
        if m.get("name") == tag or m.get("model") == tag:
            return m.get("digest")
    return None


# -- Index-Datei --------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS kopf (schluessel TEXT PRIMARY KEY, wert TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vektoren (
    rel TEXT PRIMARY KEY, schluessel TEXT NOT NULL, vektor BLOB NOT NULL,
    aktualisiert REAL NOT NULL);
"""


def lies_kopf(pfad: Path) -> dict[str, str]:
    if not pfad.exists():
        return {}
    try:
        conn = sqlite3.connect(f"file:{pfad}?mode=ro", uri=True)
        try:
            return dict(conn.execute("SELECT schluessel, wert FROM kopf").fetchall())
        finally:
            conn.close()
    except sqlite3.Error:
        return {}


def kopf_passt(kopf: dict[str, str], modell: Modell) -> bool:
    return (kopf.get("modell") == modell.name
            and kopf.get("ollama") == modell.ollama
            and kopf.get("dimension") == str(modell.dimension)
            and kopf.get("anfrage_praefix") == modell.anfrage_praefix
            and kopf.get("vorschrift") == VORSCHRIFT)


def lade_vektoren(vault: Path, modell: Modell) -> list[tuple[str, list[float]]]:
    """(rel, normierter Vektor) aus dem eigenen Index; IndexFehlt, wenn die
    Datei fehlt oder ihr Kopf nicht zu `modell` passt."""
    pfad = index_pfad(vault, modell)
    kopf = lies_kopf(pfad)
    if not kopf:
        raise IndexFehlt(f"kein Index fuer {modell.name} ({pfad})")
    if not kopf_passt(kopf, modell):
        raise IndexFehlt(f"Index {pfad.name} passt nicht zu {modell.name} "
                         f"(Kopf: {kopf.get('modell')}/{kopf.get('dimension')})")
    conn = sqlite3.connect(f"file:{pfad}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT rel, vektor FROM vektoren").fetchall()
    finally:
        conn.close()
    out = [(rel, _unpack(b)) for rel, b in rows]
    if any(len(v) != modell.dimension for _, v in out):
        raise IndexFehlt(f"Index {pfad.name}: Vektorlaenge weicht von {modell.dimension} ab")
    return out


def index_zeilen(vault: Path, modell: Modell) -> tuple[dict[str, str], float | None, dict]:
    """(rel -> schluessel, juengste Aktualisierung als Epoch, Kopf) fuer die
    Veraltungspruefung; leer, wenn kein passender Index da ist."""
    pfad = index_pfad(vault, modell)
    kopf = lies_kopf(pfad)
    if not kopf or not kopf_passt(kopf, modell):
        return {}, None, kopf
    conn = sqlite3.connect(f"file:{pfad}?mode=ro", uri=True)
    try:
        rows = dict(conn.execute("SELECT rel, schluessel FROM vektoren").fetchall())
        newest = conn.execute("SELECT max(aktualisiert) FROM vektoren").fetchone()[0]
    finally:
        conn.close()
    return rows, newest, kopf


def bauen(vault: Path, modell: Modell, voll: bool = False,
          client: OllamaClient | None = None, notes=None,
          fortschritt=None) -> dict:
    """Baut den Index von `modell` neben dem alten auf und tauscht atomar.

    Wiederverwendet werden nur Vektoren eines alten Index mit passendem Kopf
    UND gleichem Ollama-Digest (neue Gewichte unter gleichem Tag = neue
    Vektoren) und gleichem Inhaltsschluessel. `voll=True` bettet alles neu ein.
    Eine Notiz, deren Einbettung scheitert, fehlt im neuen Index und wird
    gemeldet; faellt Ollama ganz aus, bleibt der alte Index stehen.
    """
    if not modell.eigener_index:
        raise ValueError(f"{modell.name} nutzt den Gaertner-Index; "
                         "neu bauen mit `brain gardener run --phase embed`")
    from .vault import load_search_notes

    client = client or OllamaClient(embed_model=modell.ollama)
    digest = ollama_digest(client, modell.ollama)
    if digest is None:
        raise OllamaUnavailable(f"{modell.ollama} ist in Ollama nicht vorhanden "
                                f"(`ollama pull {modell.ollama}`) oder Ollama antwortet nicht")
    notes = load_search_notes(vault) if notes is None else notes
    ziel = index_pfad(vault, modell)
    ziel.parent.mkdir(parents=True, exist_ok=True)
    neu = ziel.with_name(ziel.name + ".neu")
    alt: dict[str, tuple[str, bytes]] = {}
    alter_kopf = lies_kopf(ziel)
    if not voll and kopf_passt(alter_kopf, modell) and alter_kopf.get("ollama_digest") == digest:
        conn = sqlite3.connect(f"file:{ziel}?mode=ro", uri=True)
        try:
            alt = {rel: (k, b) for rel, k, b in
                   conn.execute("SELECT rel, schluessel, vektor FROM vektoren")}
        finally:
            conn.close()
    # Reste eines abgebrochenen Laufs, samt Journal: ein liegengebliebenes
    # `-journal` wuerde SQLite sonst in die neue Datei zurueckspielen.
    for rest in (neu, *(neu.with_name(neu.name + s) for s in ("-journal", "-wal", "-shm"))):
        rest.unlink(missing_ok=True)
    stand = {"uebernommen": 0, "eingebettet": 0, "fehlgeschlagen": []}
    jetzt = dt.datetime.now(dt.timezone.utc)
    conn = sqlite3.connect(neu)
    try:
        conn.executescript(SCHEMA)
        for i, n in enumerate(notes, 1):
            k = schluessel(n)
            if n.rel in alt and alt[n.rel][0] == k:
                conn.execute("INSERT INTO vektoren VALUES (?,?,?,?)",
                             (n.rel, k, alt[n.rel][1], jetzt.timestamp()))
                stand["uebernommen"] += 1
                continue
            try:
                vec = dokument_vektor(client, modell, n.embed_text)
            except OllamaUnavailable:
                raise
            except OllamaError as e:
                stand["fehlgeschlagen"].append(f"{n.rel}: {e}")
                continue
            if len(vec) != modell.dimension:
                raise OllamaError(f"{modell.ollama} lieferte {len(vec)} statt "
                                  f"{modell.dimension} Dimensionen")
            conn.execute("INSERT INTO vektoren VALUES (?,?,?,?)",
                         (n.rel, k, _pack(vec), jetzt.timestamp()))
            stand["eingebettet"] += 1
            if fortschritt and i % 25 == 0:
                fortschritt(i, len(notes))
        kopf = {"modell": modell.name, "ollama": modell.ollama, "ollama_digest": digest,
                "dimension": str(modell.dimension), "anfrage_praefix": modell.anfrage_praefix,
                "vorschrift": VORSCHRIFT, "erstellt": jetzt.isoformat(timespec="seconds"),
                "notizen": str(stand["uebernommen"] + stand["eingebettet"])}
        conn.executemany("INSERT INTO kopf VALUES (?,?)", sorted(kopf.items()))
        conn.commit()
    except BaseException:
        conn.close()
        neu.unlink(missing_ok=True)
        raise
    conn.close()
    os.replace(neu, ziel)
    stand["pfad"] = str(ziel)
    stand["notizen"] = stand["uebernommen"] + stand["eingebettet"]
    stand["ollama_digest"] = digest
    return stand


def nachziehen(vault: Path, rels: list[str], client_fuer=None) -> dict[str, str]:
    """Einzelne Notizen in JEDEM vorhandenen eigenen Index neu einbetten
    (`brain undo`): gleiche Regel wie dort fuer den Gaertner-Index - ist kein
    Modell erreichbar, wird der veraltete Vektor geloescht statt stehengelassen.
    Ein Index, dessen Kopf nicht passt, bleibt unberuehrt (die Suche liest ihn
    ohnehin nicht). Rueckgabe: {"<modell>:<rel>": "neu eingebettet"|"Vektor geloescht"}."""
    from gardener.vault import parse_note

    out: dict[str, str] = {}
    for modell in MODELLE.values():
        if not modell.eigener_index:
            continue
        pfad = index_pfad(vault, modell)
        if not kopf_passt(lies_kopf(pfad), modell):
            continue
        client = (client_fuer(modell) if client_fuer
                  else OllamaClient(embed_model=modell.ollama))
        conn = sqlite3.connect(pfad)
        try:
            for rel in rels:
                datei = Path(vault) / rel
                if not datei.exists():
                    conn.execute("DELETE FROM vektoren WHERE rel=?", (rel,))
                    continue
                note = parse_note(Path(vault), datei)
                try:
                    vec = dokument_vektor(client, modell, note.embed_text)
                except (OllamaError, OSError):
                    vec = None
                if vec is None or len(vec) != modell.dimension:
                    conn.execute("DELETE FROM vektoren WHERE rel=?", (rel,))
                    out[f"{modell.name}:{rel}"] = "Vektor geloescht"
                else:
                    conn.execute("INSERT OR REPLACE INTO vektoren VALUES (?,?,?,?)",
                                 (rel, schluessel(note), _pack(vec),
                                  dt.datetime.now(dt.timezone.utc).timestamp()))
                    out[f"{modell.name}:{rel}"] = "neu eingebettet"
            conn.commit()
        finally:
            conn.close()
    return out
