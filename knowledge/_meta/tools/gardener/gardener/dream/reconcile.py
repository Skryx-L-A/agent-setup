"""M4: groups, merging, supersession candidates, and where a claim's page goes.

This module answers the question M2b/M3 deliberately left open: which note does
a claim belong to? The provisional answer in `shadow.route` - first wikilink,
else first backticked identifier, else the source document's stem - produced 20
hunks from 93 of 293 stored claims and named its pages after transcript UUIDs.

The answer here is built on four measurements against the real store, written
up in `messungen/m4/BEFUNDE.md`. Two of them are negative and shape the design
more than the positive ones do:

1. **A claim's embedding cannot find its note.** Three variants (mean-pooled
   chunks, max over chunks, embeddinggemma's asymmetric task prefixes): median
   0.42, max 0.665, and no band where right and wrong targets separate. So
   embeddings are used for what DREAM-PLAN.md Abschnitt 5 gives them - grouping
   claims against each other - and never as a target search.
2. **A claim's terms cannot find its note either.** 9 of 293 hit the resolver,
   half of them by accident. The reason is the corpus, not the method: the vault
   has no note yet for most of what these claims are about. Routing therefore
   creates well-named pages, and the page TITLE is where the quality sits.
3. **Claim against claim does separate**, at 0.72 (see config).
4. **Subjects come from provenance and from marked-up vocabulary.** A term
   counts as a subject when it is identifier-shaped, or when some human
   somewhere in the corpus put it in backticks or a wikilink - a stoplist
   derived from the corpus itself rather than a hand-maintained word list.

Three rules hold everywhere below:

- **The model judges relations, it never writes text.** A merged wording could
  not be cited: one quote cannot cover a sentence that fuses two sources, and a
  concatenated quote blob is exactly the construction the 2026-08-07 review
  pass removed from the citation gate, where everything vouched for everything.
  So the model answers from a closed list and every line that ever reaches the
  vault stays a stored, quoted claim. Nothing here needs `gate_rendering`
  loosened.
- **Code has the last word.** Ids must come from the group; a supersession is
  refused unless the surviving claim is strictly newer, whatever the model says.
- **Every subject term must appear literally in a member's quote.** The title of
  a created page is not covered by `added_text` (which strips frontmatter), yet
  it is what `brain search` and the resolver key on. A title built only from
  quoted terms passes a title value gate by construction instead of by
  exception.

Nothing in this module writes to the vault. It writes its cache under the
dream's state directory and its plan into the versioned audit path.
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import json
import logging
import re
import sqlite3
import time
from array import array
from dataclasses import asdict, dataclass, field
from pathlib import Path

try:                                  # numpy macht die Gruppierung schnell,
    import numpy as _np               # ist aber keine Bedingung: fehlt es,
except ImportError:                   # rechnet die reine Python-Schleife
    _np = None                        # weiter, nur langsamer.

from ..linking import cosine
from ..vault import Note, build_resolver, key_of, load_notes
from . import claims as claims_mod
from . import config as dcfg
from . import jsonflick
from .budget import BudgetExhausted
from . import shadow as shadow_mod

log = logging.getLogger("gardener.dream")

SCHEMA = """
CREATE TABLE IF NOT EXISTS claim_vectors (
    claim_id TEXT PRIMARY KEY,
    text_hash TEXT NOT NULL,
    vector BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_verdicts (
    fingerprint TEXT PRIMARY KEY,
    relation TEXT NOT NULL,
    keep TEXT,
    older TEXT,
    reason TEXT,
    model TEXT NOT NULL,
    decided_at TEXT NOT NULL
);
"""

RELATION_SAME = "same"
RELATION_DISTINCT = "distinct"
RELATION_SUPERSEDES = "supersedes"
RELATIONS = (RELATION_SAME, RELATION_DISTINCT, RELATION_SUPERSEDES)

DECIDED_SINGLE = "single"           # a group of one - nothing to decide
DECIDED_MECHANICAL = "mechanical"   # same subject, identical values
DECIDED_CLOUD = "cloud"
DECIDED_UNJUDGED = "unjudged"       # values differ and no cloud call was made

# Marks a verdict the CODE turned down rather than the model - counted and
# reported separately, because a model that gets the direction of a supersession
# wrong is a defect signal, not an operating event.
REFUSAL_MARKER = "Ablehnung:"

_WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)")
_BACKTICK_RE = re.compile(r"`([^`]+)`")
# A bare token that could name something: letters first, then word characters
# and the marks an identifier carries.
_TOKEN_RE = re.compile(r"[A-Za-zÄÖÜäöüß][\w./:-]{2,}")
_IDENTIFIER_MARKS = "-_./:"

# `worker-result:<task>/<file>.md#<n>` and `project-doc:<project>/<path>#<n>`
# both name their subject in the first path element. That element is a path the
# code read off disk, not model text, which is why it may title a page without
# standing in a quote.
_SOURCE_RE = re.compile(r"^(?P<klass>[a-z-]+):(?P<rest>.*)$")


class ReconcileStore:
    """Embedding cache and cloud verdict cache. Mirrors ClaimStore's read_only
    contract so a dry run never creates the database."""

    def __init__(self, db_path: Path, read_only: bool = False):
        db_path = Path(db_path)
        self.read_only = read_only
        if read_only and not db_path.exists():
            self.conn = sqlite3.connect(":memory:")
            self.conn.executescript(SCHEMA)
            return
        if read_only:
            self.conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            return
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # -- embeddings ---------------------------------------------------------

    def get_vector(self, claim_id: str, text_hash: str) -> list[float] | None:
        row = self.conn.execute(
            "SELECT vector FROM claim_vectors WHERE claim_id=? AND text_hash=?",
            (claim_id, text_hash)).fetchone()
        if row is None:
            return None
        return list(_unpack(row[0]))

    def put_vector(self, claim_id: str, text_hash: str,
                   vector: list[float]) -> list[float]:
        """Stores and returns the vector AS STORED. The round trip is the point:
        packing to float32 rounds, and a run that used the full-precision value
        it just computed would group marginally differently from the next run,
        which reads the rounded one back. Idempotence must not depend on whether
        a vector was cached yet."""
        packed = _pack(vector)
        if not self.read_only:
            self.conn.execute(
                "INSERT OR REPLACE INTO claim_vectors (claim_id, text_hash, vector) "
                "VALUES (?,?,?)", (claim_id, text_hash, packed))
            self.conn.commit()
        return list(_unpack(packed))

    # -- verdicts -----------------------------------------------------------

    def get_verdict(self, fingerprint: str) -> dict | None:
        row = self.conn.execute(
            "SELECT relation, keep, older, reason FROM pair_verdicts "
            "WHERE fingerprint=?", (fingerprint,)).fetchone()
        if row is None:
            return None
        return {"relation": row[0], "keep": row[1], "older": row[2],
                "reason": row[3], "cached": True}

    def put_verdict(self, fingerprint: str, verdict: dict, model: str) -> None:
        if self.read_only:
            return
        self.conn.execute(
            "INSERT OR REPLACE INTO pair_verdicts (fingerprint, relation, keep, "
            "older, reason, model, decided_at) VALUES (?,?,?,?,?,?,?)",
            (fingerprint, verdict.get("relation"), verdict.get("keep"),
             verdict.get("older"), verdict.get("reason"), model, _now_iso()))
        self.conn.commit()


def _pack(vector: list[float]) -> bytes:
    return array("f", vector).tobytes()


def _unpack(blob: bytes) -> array:
    out = array("f")
    out.frombytes(blob)
    return out


def _now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_claims(rows: list[dict], client, store: ReconcileStore, *,
                 preflight=None) -> dict[str, list[float]]:
    """Embed every claim's TEXT, reusing the cache by (claim_id, text hash).

    `preflight` is called once, before the first uncached embedding, and is the
    mandatory `check-resources` step from CLAUDE.md - a wave of model calls does
    not start without looking at the machine first. It is a parameter rather
    than a hard import so a test injects its own and never shells out. When
    every vector is already cached, no model runs and no preflight is needed.
    """
    vectors: dict[str, list[float]] = {}
    todo: list[dict] = []
    for row in rows:
        cached = store.get_vector(row["claim_id"], text_hash(row["text"]))
        if cached is not None:
            vectors[row["claim_id"]] = cached
        else:
            todo.append(row)
    if not todo:
        return vectors
    if preflight is not None:
        resources = preflight()
        log.info("dream reconcile: check-resources before embedding %d claims: %s",
                 len(todo), json.dumps(resources)[:300])
    for row in todo:
        try:
            vec = client.embed(row["text"])
        except Exception as e:            # one bad claim must not kill the wave
            log.warning("dream reconcile: embedding failed for %s: %s",
                        row["claim_id"][:12], e)
            continue
        vectors[row["claim_id"]] = store.put_vector(
            row["claim_id"], text_hash(row["text"]), vec)
    return vectors


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------

def _gruppen_numpy(order: list[dict], vectors: dict, min_sim: float
                   ) -> list[list[str]]:
    """Dieselbe Vorschrift wie die Schleife darunter, nur rechnet numpy alle
    Aehnlichkeiten einer Aussage in einem Zug statt einzeln.

    Zwei Dinge muessen dabei erhalten bleiben, sonst gruppiert der schnelle Weg
    anders als der langsame:

    1. **Die ERSTE erreichte Gruppe gewinnt**, nicht die aehnlichste. Deshalb
       `argmax` ueber die Ja/Nein-Maske und nicht ueber die Aehnlichkeiten.
    2. **Die Reihenfolge der Gruppen** ist die ihrer Entstehung. Aussagen ohne
       Vektor bilden eigene Gruppen, bekommen aber keine Zeile in der Matrix;
       `zeile_zu_gruppe` haelt deshalb fest, welche Matrixzeile zu welcher
       Gruppe gehoert. Weil beide Listen nur angehaengt werden, bleibt die
       Reihenfolge dieselbe.

    Gerechnet wird in float64, wie die Schleife auch: Python-Fliesskommazahlen
    sind float64, und in float32 waere der Unterschied nicht mehr nur
    Rundung.
    """
    dim = len(next(iter(vectors.values()))) if vectors else 0
    members: list[list[str]] = []
    matrix = _np.empty((max(len(order), 1), dim), dtype=_np.float64)
    normen = _np.empty(max(len(order), 1), dtype=_np.float64)
    zeile_zu_gruppe: list[int] = []
    belegt = 0
    begonnen = time.monotonic()
    for gezaehlt, row in enumerate(order, start=1):
        if gezaehlt % dcfg.RECONCILE_GROUP_LOG_EVERY == 0:
            log.info("dream reconcile: gruppiert %d/%d Aussagen, %d Gruppen, "
                     "%.0f s", gezaehlt, len(order), len(members),
                     time.monotonic() - begonnen)
        cid = row["claim_id"]
        vec = vectors.get(cid)
        if vec is None:
            members.append([cid])
            continue
        v = _np.asarray(vec, dtype=_np.float64)
        nv = float(_np.sqrt(v @ v))
        treffer = -1
        if belegt and nv:
            # cosine = dot / (|v| * |c|). Eine Gruppe mit Norm 0 kann die
            # Schwelle nie erreichen - die Schleife liefert dort 0.0 -, und
            # ohne den Schutz gaebe es hier eine Division durch null.
            nenner = normen[:belegt] * nv
            aehnlich = _np.zeros(belegt, dtype=_np.float64)
            gut = nenner > 0
            aehnlich[gut] = (matrix[:belegt] @ v)[gut] / nenner[gut]
            maske = aehnlich >= min_sim
            if maske.any():
                treffer = int(maske.argmax())
        if treffer >= 0:
            g = zeile_zu_gruppe[treffer]
            n = len(members[g])
            matrix[treffer] = (matrix[treffer] * n + v) / (n + 1)
            normen[treffer] = _np.sqrt(matrix[treffer] @ matrix[treffer])
            members[g].append(cid)
            continue
        matrix[belegt] = v
        normen[belegt] = nv
        zeile_zu_gruppe.append(len(members))
        belegt += 1
        members.append([cid])
    return members


def group_claims(rows: list[dict], vectors: dict[str, list[float]],
                 min_sim: float = dcfg.RECONCILE_GROUP_MIN_SIMILARITY,
                 ) -> list[list[str]]:
    """Claims that may be talking about the same thing, as lists of claim ids.

    A claim joins the FIRST group whose centroid it reaches, and the centroid is
    the running mean of the members. Single-linkage was rejected on purpose: it
    chains, so A-B and B-C at threshold drag A and C into one group however far
    apart they are, and one long chain would swallow a whole topic. A centroid
    keeps a group anchored to what it is already about.

    Claims without a vector (an embedding that failed) form their own group and
    are never silently dropped.

    Die Schleife ist von Natur aus quadratisch - jede Aussage wird gegen jede
    bestehende Gruppe geprueft, und am echten Bestand bildeten 91 Prozent der
    Aussagen ihre eigene Gruppe, es wird also kaum je frueh abgebrochen.
    Gemessen am 16.08.2026: 4,52 s fuer 500 Aussagen, 18,60 s fuer 1.000, also
    sauber vervierfacht bei doppelter Menge; hochgerechnet auf die 27.980
    Aussagen des Bestands rund vier Stunden. Deshalb rechnet `_gruppen_numpy`
    dieselbe Vorschrift mit numpy, wenn es da ist. Der Rueckfallweg bleibt
    erhalten und ist die Referenz: `test_dream_reconcile_numpy.py` prueft
    beide Wege am echten Bestand auf Gruppe fuer Gruppe gleiche Ergebnisse.
    """
    order = sorted(rows, key=lambda r: (r["recorded_at"], r["claim_id"]))
    if _np is not None:
        return _gruppen_numpy(order, vectors, min_sim)
    members: list[list[str]] = []
    centroids: list[list[float]] = []
    # Diese Schleife ist die laengste STILLE Phase des ganzen Laufs: am
    # 16.08.2026 rechnete sie ueber eine Stunde, ohne eine einzige Zeile zu
    # schreiben, und hat die Wache zu Recht anschlagen lassen - ein Lauf, der
    # nichts sagt, ist von einem Lauf, der haengt, nicht zu unterscheiden.
    # Deshalb ein Lebenszeichen je Block, mit der Zahl der Gruppen: die sagt
    # zugleich, wie teuer der Rest wird, denn jede Aussage wird gegen jede
    # bestehende Gruppe geprueft.
    begonnen = time.monotonic()
    for gezaehlt, row in enumerate(order, start=1):
        if gezaehlt % dcfg.RECONCILE_GROUP_LOG_EVERY == 0:
            log.info("dream reconcile: gruppiert %d/%d Aussagen, %d Gruppen, "
                     "%.0f s", gezaehlt, len(order), len(members),
                     time.monotonic() - begonnen)
        cid = row["claim_id"]
        vec = vectors.get(cid)
        if vec is None:
            members.append([cid])
            centroids.append([])
            continue
        joined = False
        for i, centroid in enumerate(centroids):
            if not centroid:
                continue
            if cosine(vec, centroid) >= min_sim:
                n = len(members[i])
                centroids[i] = [(c * n + v) / (n + 1)
                                for c, v in zip(centroid, vec)]
                members[i].append(cid)
                joined = True
                break
        if not joined:
            members.append([cid])
            centroids.append(list(vec))
    return members


# ---------------------------------------------------------------------------
# Values: what makes a merge unsafe
# ---------------------------------------------------------------------------

def value_signature(claim: dict) -> frozenset[str]:
    """Every number, date, path, filename, backticked identifier and model name
    in a claim's text, normalized for comparison.

    Built from `claims.py`'s own extractors rather than a second set of
    patterns: the applier's citation gate judges exactly these five value kinds
    (DREAM-PLAN.md Abschnitt 7, Regel 4), and a merge decision that used a
    different notion of "a value" than the gate would let through a merge the
    gate then refuses.
    """
    text = str(claim.get("text") or "")
    out: set[str] = set()
    for v in claims_mod._significant_numbers(text):
        out.add("num:" + claims_mod.normalize(v))
    for needed in claims_mod._find_dates(text):
        out.add("date:" + ".".join(
            f"{v:02d}" if v is not None else "?" for v in needed))
    for v in claims_mod._slash_values(text) + claims_mod._bare_filenames(text):
        out.add("path:" + claims_mod.normalize(v))
    for v in claims_mod._IDENTIFIER_RE.findall(text):
        out.add("id:" + claims_mod.normalize(v))
    for v in claims_mod._model_names(text):
        out.add("model:" + claims_mod.normalize(v).lower())
    return frozenset(out)


# ---------------------------------------------------------------------------
# Subjects
# ---------------------------------------------------------------------------

def marked_vocabulary(rows: list[dict]) -> frozenset[str]:
    """Lowercased terms a human put in backticks or a wikilink ANYWHERE in the
    corpus - the corpus's own answer to "is this word a name or just a word".

    Measured over the real store: 103 terms, which admits `Ollama`,
    `context-guard`, `pi-worker`, `wb-pane-write`, `bash-guard.py` and rejects
    `Prüfung`, `Link`, `Guard`, `Pane`, `Skript`, `Maschine` - frequent German
    nouns that would make meaningless page titles. A hand-maintained stoplist
    would have to be kept in step with a growing vault; this one grows with it.

    ZWEITE SCHRANKE seit 2026-08-12, und sie war teuer erkauft. Bei 2.818
    Aussagen schickte der Plan 135 davon auf eine Seite namens `und.md`, 61 auf
    `ein.md` und 46 auf `eine.md` - zusammen elf Prozent der Ausbeute auf drei
    Seiten, deren Titel nichts benennt. Der Weg dahin: Irgendwer hatte
    irgendwann `und` in Backticks gesetzt, und ein einziges Vorkommen reichte.

    Die Gegenfrage an denselben Korpus schliesst die Luecke: In wie vielen
    Aussagen kommt der Begriff ueberhaupt vor? Ein Funktionswort steht fast
    ueberall, ein Name in wenigen. Gemessen: `und` in 18,0 Prozent der
    Aussagen, `ein` in 7,9, `eine` in 5,8 - waehrend `claude` bei 2,6 liegt,
    `live` bei 2,3, `ollama` bei 1,2 und `context-guard` bei 0,3. Das 99.
    Perzentil aller markierten Begriffe liegt bei 0,82 Prozent.

    Bei der gewaehlten Schranke fallen deshalb GENAU die drei Funktionswoerter
    heraus und kein einziges echtes Thema. Das bleibt dem Entwurf treu: Die
    Sperrliste kommt weiter aus dem Korpus und nicht aus einer gepflegten
    Wortliste, und sie waechst mit ihm, weil sie relativ zaehlt.

    Ein Begriff mit Bezeichnerform (`<ein eigenes Mailwerkzeug>`, `art-9`) ist von der Schranke
    ausgenommen: Ein Funktionswort sieht nie so aus, und ein haeufiger
    Bezeichner ist gerade ein wichtiges Thema."""
    markiert: set[str] = set()
    dokumente: collections.Counter[str] = collections.Counter()
    for row in rows:
        blob = f"{row.get('text') or ''} {row.get('quote') or ''}"
        for pattern in (_BACKTICK_RE, _WIKILINK_RE):
            for m in pattern.finditer(blob):
                value = m.group(1).strip()
                if 2 < len(value) < 60:
                    markiert.add(value.lower())
        # Je Aussage EINMAL zaehlen: gefragt ist, in wie vielen Aussagen ein
        # Begriff vorkommt, nicht wie oft insgesamt. Sonst schlaegt eine
        # einzelne Aufzaehlung durch.
        for token in set(_TOKEN_RE.findall(blob.lower())):
            dokumente[token] += 1
    if len(rows) < dcfg.RECONCILE_SUBJECT_FREQ_MIN_ROWS:
        return frozenset(markiert)
    schranke = dcfg.RECONCILE_SUBJECT_MAX_DOC_SHARE * len(rows)
    return frozenset(t for t in markiert
                     if _is_identifier_shaped(t) or dokumente.get(t, 0) < schranke)


def _is_identifier_shaped(term: str) -> bool:
    return any(c in term for c in _IDENTIFIER_MARKS) or any(c.isdigit()
                                                            for c in term)


def basename_subject(term: str) -> str:
    """A path-like subject reduced to its last element.

    Two things at once, both measured 2026-08-08. It dedupes: the same file is
    named `hooks/bash-guard.py` in one claim and `bash-guard.py` in another, and
    without this they became two pages about one thing. And it titles better -
    `test-abschirmung.sh` reads as a subject where
    `shell/tests/test-abschirmung.sh` reads as a location.

    The title gate is unaffected: a basename is a substring of the path it came
    from, so if the path stood literally in the quote, so does the basename.
    """
    if "/" not in term:
        return term
    tail = term.rstrip("/").rsplit("/", 1)[-1]
    return tail or term


def is_function_word(term: str) -> bool:
    """Ob der Begriff ein Funktionswort ist und deshalb nie eine Seite betitelt.

    Die DRITTE Schranke neben Dokumentanteil und Mindestzahl, und die einzige,
    die nicht aus dem Korpus kommt - weil beide Korpus-Signale an diesem Fall
    gemessen und beide zu schwach befunden wurden; die Zahlen stehen bei
    `RECONCILE_SUBJECT_STOPWORDS` in config.py.

    Ein Begriff mit Bezeichnerform ist ausgenommen, wie bei den anderen
    Schranken auch: `art-9` oder `b2b` sehen aus wie Namen und nicht wie
    Sprache, und ein Funktionswort sieht nie so aus.
    """
    key = term.strip().lower()
    if not key or _is_identifier_shaped(key):
        return False
    return key in dcfg.RECONCILE_SUBJECT_STOPWORDS


def titelfaehig(term: str) -> bool:
    """Ob der Begriff ueberhaupt eine Seite betiteln darf.

    Sammelt die Bedingungen, die vorher verstreut und deshalb ungleich
    angewandt wurden. Am 16.08.2026 im ersten vollstaendigen Changeset
    gefunden: neben den Fuellwoertern standen dort Ziele wie `e.md`, `b.md`,
    `r.md`, `2.md`, `3.md` und `07.md`.

    Zwei Ursachen, beide nicht grundsaetzlicher Natur, sondern schlicht
    ungleich geprueft:

    * Der Weg ueber blosse Tokens verlangte seit je drei Zeichen, der Weg
      ueber Markiertes (Backticks, Wikilink) verlangte gar nichts - ein
      einzelnes `` `e` `` irgendwo im Korpus genuegte fuer eine Seite.
    * Eine reine Zahl galt als bezeichnerfoermig, weil sie Ziffern enthaelt,
      und war damit von JEDER Schranke ausgenommen. `_ID_LIKE_RE` faengt erst
      ab sechs Ziffern.

    Eine Zahl benennt eine Menge, kein Ding, und ein einzelner Buchstabe
    benennt gar nichts - das sind Formregeln wie `_ID_LIKE_RE` und keine
    Wortliste.
    """
    key = term.strip()
    if len(key) < dcfg.RECONCILE_MIN_SUBJECT_LEN:
        return False
    if key.isdigit():
        return False
    return not is_machine_stem(key) and not is_function_word(key)


def is_machine_stem(term: str) -> bool:
    """Whether a term is a machine-generated name rather than a subject.

    Delegates to `shadow`'s own patterns instead of restating them: a UUID, a
    run timestamp and stems like `done`/`index` are already rejected there as
    note titles (`usable_subject`), and a second copy of that judgement is a
    second copy that eventually disagrees. The behaviour is pinned by a test, so
    a rename in shadow.py fails loudly rather than silently admitting UUIDs.
    """
    key = term.strip()
    return bool(shadow_mod._ID_LIKE_RE.match(key)) or \
        key.lower() in shadow_mod._GENERIC_STEMS


def claim_subject_candidates(claim: dict,
                             vocabulary: frozenset[str]) -> list[str]:
    """Every subject this claim could be filed under, best first.

    In descending order of how much a human had to do with the term: wikilinks,
    then backticked identifiers, then bare tokens that are either
    identifier-shaped or part of the marked vocabulary (longest first, the most
    specific name in the sentence). Every candidate must appear LITERALLY in
    this claim's own quote - the title-gate condition, applied at the source.

    A LIST rather than one winner, because whether a term is a topic is not
    knowable from one claim. Measured 2026-08-08: "Stolperfalle: <ein eigenes Mailwerkzeug> kann
    weiterhin keine Anhaenge; Anhang-Versand wurde per einmaligem MIME-Skript
    ... geloest" offers both `MIME-Skript` (named once in the whole store) and
    `<ein eigenes Mailwerkzeug>` (named twice). Committing to the longest here dropped the claim
    onto a rare term, the frequency rule then refused it a page, and a genuine
    supersession about <ein eigenes Mailwerkzeug> lost its target.
    """
    text = str(claim.get("text") or "")
    quote = str(claim.get("quote") or "")
    norm_quote = claims_mod.normalize(quote)

    def quoted(term: str) -> bool:
        return term in quote or claims_mod.normalize(term) in norm_quote

    marked: list[str] = []
    for pattern in (_WIKILINK_RE, _BACKTICK_RE):
        for m in pattern.finditer(text):
            term = m.group(1).strip()
            if term and not is_machine_stem(term) \
                    and not is_function_word(term) and quoted(term):
                marked.append(term)
    plain = _BACKTICK_RE.sub(" ", _WIKILINK_RE.sub(" ", text))
    bare: list[str] = []
    for m in _TOKEN_RE.finditer(plain):
        term = m.group(0).strip(".,-:")
        if len(term) < 3 or is_machine_stem(term) or is_function_word(term):
            continue
        if not (_is_identifier_shaped(term) or term.lower() in vocabulary):
            continue
        if quoted(term):
            bare.append(term)
    # Longest first among the bare ones; lexicographic on ties, so the order
    # never depends on where the word happened to stand in the sentence.
    ordered = marked + sorted(bare, key=lambda t: (-len(t), t))
    out: list[str] = []
    for term in ordered:
        term = basename_subject(term)
        if term and titelfaehig(term) and term not in out:
            out.append(term)
    return out


def claim_subject(claim: dict, vocabulary: frozenset[str]) -> str | None:
    """The single subject this claim names best, or None. Used where one claim
    has to be compared with one other - the safe-merge check - rather than
    where a page is being named."""
    candidates = claim_subject_candidates(claim, vocabulary)
    return candidates[0] if candidates else None


def provenance_subject(source: str) -> str | None:
    """The subject the SOURCE PATH names: a worker task, a project directory,
    or the gardener. This is a path the code read off disk, not model output, so
    it may title a page without standing in a quote - the title gate is about
    free model text, and frontmatter written by machinery is not that.
    """
    m = _SOURCE_RE.match(str(source or ""))
    if m is None:
        return None
    klass, rest = m.group("klass"), m.group("rest")
    if klass == "gardener-report":
        return "Gardener"
    if klass not in ("worker-result", "project-doc"):
        return None          # transcripts are UUIDs; vault sources are the vault
    first = rest.split("#", 1)[0].split("/", 1)[0].strip()
    if not first or is_machine_stem(first):
        return None
    return first


def subject_frequency(rows: list[dict], vocabulary: frozenset[str]) -> dict[str, int]:
    """How many claims in the WHOLE store name each candidate subject. A topic
    is something more than one claim talks about; a term exactly one claim
    mentions is an incidental token, whatever shape it has."""
    counts: dict[str, int] = {}
    for row in rows:
        for subject in claim_subject_candidates(row, vocabulary):
            counts[subject] = counts.get(subject, 0) + 1
    return counts


def _most_named(counts: dict[str, int]) -> str | None:
    """Most members, then longest, then lexicographic - so the choice never
    depends on the order the claims happened to arrive in."""
    if not counts:
        return None
    return sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0]))[0][0]


def group_text_subject(rows: list[dict], vocabulary: frozenset[str],
                       accept=None) -> str | None:
    """The subject the group's own claims name. `accept` filters the candidates
    - routing uses it to ask "which of these is an existing note" and "which of
    these is common enough to title a new page" without re-deriving them."""
    counts: dict[str, int] = {}
    for row in rows:
        for subject in claim_subject_candidates(row, vocabulary):
            if accept is None or accept(subject):
                counts[subject] = counts.get(subject, 0) + 1
    return _most_named(counts)


def group_provenance_subject(rows: list[dict]) -> str | None:
    """The subject the group's SOURCE PATHS name: a worker task, a project, the
    gardener. Coarser than a text subject - it names where the knowledge came
    from, not what it is about - which is why it is the fallback."""
    counts: dict[str, int] = {}
    for row in rows:
        subject = provenance_subject(row.get("source", ""))
        if subject:
            counts[subject] = counts.get(subject, 0) + 1
    return _most_named(counts)


def subject_of_group(rows: list[dict], vocabulary: frozenset[str],
                     shared: dict[str, int] | None = None,
                     min_claims: int = dcfg.RECONCILE_MIN_CLAIMS_PER_SUBJECT,
                     ) -> str | None:
    """The subject a NEW page could be titled after, or None.

    A term only titles a page the dream invents when the corpus shows it is a
    topic: `shared` counts how many claims name it store-wide, and below
    `min_claims` it gives way to the provenance subject. Measured 2026-08-08 on
    the real store: without this rule the 293 claims spread over 125 files,
    among them one-claim pages called `ad401f8` (a git SHA), `af5`, `app` and
    `content` - the failure `usable_subject` prevents for machine file stems,
    reappearing through identifiers that happened to stand in one sentence.
    With it, the same claims aggregate onto 15 pages their sources are about.

    Naming an EXISTING note is a different question and is not asked here: a
    note a person wrote is itself the evidence that the subject is real, so
    `build_plan` tries the plain text subject against the resolver first and
    only comes here when it is about to invent a page.
    """
    shared = subject_frequency(rows, vocabulary) if shared is None else shared
    named = group_text_subject(rows, vocabulary,
                               accept=lambda s: shared.get(s, 0) >= min_claims)
    return named or group_provenance_subject(rows)


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def existing_note_for(subject: str | None,
                      resolver: dict[str, Note]) -> str | None:
    """The existing note this subject names exactly, or None.

    Only an EXACT resolver hit counts. Befund 1 and 2 both showed the fuzzy
    variants inventing a target, and a wrong target here means a line appended
    to a note that is not about it. `00-sources` and the managed root files are
    excluded HERE, at routing time, not only at apply time - otherwise every run
    proposes the same hunk, it is refused every run, and it is then remembered
    as an issue forever (measured 2026-08-07: ten of 42 hunks).
    """
    if not subject:
        return None
    note = resolver.get(key_of(subject))
    if note is None or shadow_mod.is_forbidden_target(note.rel):
        return None
    return note.rel


def new_page_for(subject: str, vault: Path) -> tuple[str, str]:
    """(target rel, op) for a page in the dream's own branch: created once,
    appended to on every run after that."""
    rel = f"{dcfg.DREAM_DERIVED_DIR}/{shadow_mod.slug(subject)}.md"
    exists = (Path(vault) / rel).exists()
    return rel, (shadow_mod.OP_APPEND if exists else shadow_mod.OP_CREATE)


def route_group(member_rows: list[dict], vocabulary: frozenset[str],
                shared: dict[str, int], resolver: dict[str, Note],
                vault: Path) -> tuple[str | None, str | None, str | None]:
    """(subject, target, op) for one group, or (None, None, None).

    The cascade, in descending order of how much evidence there is that the
    subject is real:

    1. The subject the group's claims name, when an existing note carries
       exactly that title. A note a person wrote is the evidence.
    2. That same subject as a NEW page - but only when enough claims name it
       that the corpus calls it a topic (see subject_of_group).
    3. The provenance subject: the worker task, the project, the gardener.
       Coarser, but always a real name off a path the code read.
    4. Nothing. The claim stays in the store and waits; an honest remainder
       beats an invented target.
    """
    named = group_text_subject(
        member_rows, vocabulary,
        accept=lambda s: existing_note_for(s, resolver) is not None)
    rel = existing_note_for(named, resolver)
    if rel is not None:
        return named, rel, shadow_mod.OP_APPEND
    subject = subject_of_group(member_rows, vocabulary, shared=shared)
    if subject is None:
        return None, None, None
    rel = existing_note_for(subject, resolver)
    if rel is not None:
        return subject, rel, shadow_mod.OP_APPEND
    target, op = new_page_for(subject, vault)
    return subject, target, op


# ---------------------------------------------------------------------------
# The cloud judgement - relations only, never prose
# ---------------------------------------------------------------------------

JUDGE_PROMPT = """\
Zwei belegte Aussagen aus einem persoenlichen Wissensarchiv. Entscheide NUR
ihre Beziehung zueinander. Du schreibst keinen neuen Text, du fasst nichts
zusammen und du formulierst nichts um.

[A] id={a_id}  erfasst={a_recorded}
    Aussage: {a_text}
    Zitat:   {a_quote}

[B] id={b_id}  erfasst={b_recorded}
    Aussage: {b_text}
    Zitat:   {b_quote}

Antworte NUR mit diesem JSON, ohne Codezaun und ohne Erklaerung davor:
{{"relation": "same|distinct|supersedes", "keep": "<id>", "older": "<id oder null>",
  "reason": "<ein kurzer Satz>"}}

same       Beide sagen dasselbe ueber denselben Gegenstand; die Unterschiede
           sind nur Formulierung oder Schreibweise. keep ist die Aussage, die
           stehen bleibt, older ist null.
supersedes Derselbe Gegenstand, aber der Sachverhalt hat sich geaendert, und
           die juengere Aussage gilt heute. keep ist die geltende Aussage,
           older die abgeloeste.
distinct   Verschiedene Gegenstaende oder verschiedene Sachverhalte. Das gilt
           auch dann, wenn die Saetze aehnlich gebaut sind: verschiedene
           Zahlen, Dateien, Werkzeuge, Testlaeufe oder Messungen sind
           verschiedene Aussagen, keine Umformulierungen.

Im Zweifel distinct. keep und older muessen genau eine der beiden ids oben sein.
"""


def pair_fingerprint(a: dict, b: dict) -> str:
    """Identifies a judged PAIR by content, not by position: the same two claims
    are the same question whichever order they arrive in, and a changed prompt
    is a different question."""
    parts = sorted([f"{a['claim_id']}:{text_hash(a['text'])}",
                    f"{b['claim_id']}:{text_hash(b['text'])}"])
    payload = "\x1f".join(parts + [str(dcfg.RECONCILE_PROMPT_VERSION),
                                   dcfg.RECONCILE_MODEL])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def build_judge_prompt(a: dict, b: dict) -> str:
    return JUDGE_PROMPT.format(
        a_id=shadow_mod.short_id(a["claim_id"]), a_recorded=a["recorded_at"],
        a_text=a["text"], a_quote=a["quote"],
        b_id=shadow_mod.short_id(b["claim_id"]), b_recorded=b["recorded_at"],
        b_text=b["text"], b_quote=b["quote"])


def parse_verdict(raw: object, a: dict, b: dict) -> dict:
    """The model's answer, forced back into the closed list and into ids that
    exist. Code is the final authority here exactly as it is for
    `source_trust`: anything unrecognized becomes `distinct`, which changes
    nothing about the vault.

    The direction rule is enforced here and not only downstream: only a claim
    with a strictly NEWER `recorded_at` may retire an older one (DREAM-PLAN.md
    Abschnitt 7, Regel 3). A model that names the older claim as the survivor is
    not corrected into the opposite - it is downgraded to `distinct`, because a
    model that got the direction wrong has not shown it understood the pair.
    """
    by_short = {shadow_mod.short_id(a["claim_id"]): a,
                shadow_mod.short_id(b["claim_id"]): b}
    data = raw if isinstance(raw, dict) else {}
    relation = str(data.get("relation") or "").strip().lower()
    reason = str(data.get("reason") or "")[:300]
    if relation not in RELATIONS:
        return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
                "reason": f"unbekannte Relation {relation!r} - als distinct gewertet"}
    keep = by_short.get(str(data.get("keep") or "").strip())
    if relation == RELATION_SAME:
        if keep is None:
            return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
                    "reason": "keep nennt keine der beiden Aussagen"}
        return {"relation": RELATION_SAME, "keep": keep["claim_id"],
                "older": None, "reason": reason}
    if relation == RELATION_SUPERSEDES:
        older = by_short.get(str(data.get("older") or "").strip())
        if keep is None or older is None or keep["claim_id"] == older["claim_id"]:
            return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
                    "reason": "keep/older nennen nicht genau zwei bekannte Aussagen"}
        if not str(keep["recorded_at"]) > str(older["recorded_at"]):
            return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
                    "reason": (f"{REFUSAL_MARKER} die als geltend genannte Aussage "
                               "ist nicht juenger als die abzuloesende")}
        return {"relation": RELATION_SUPERSEDES, "keep": keep["claim_id"],
                "older": older["claim_id"], "reason": reason}
    return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
            "reason": reason}


def judge_pair(a: dict, b: dict, call, store: ReconcileStore) -> dict:
    """One relation verdict, cached by pair fingerprint so a second run over an
    unchanged corpus costs nothing. `call` is the injected cloud caller (the
    stripped `extract.call_claude_cli`); a transport failure is not fatal and
    leaves the pair `distinct`, which is the outcome that changes nothing."""
    fingerprint = pair_fingerprint(a, b)
    cached = store.get_verdict(fingerprint)
    if cached is not None:
        return cached
    try:
        envelope = call(build_judge_prompt(a, b))
    except BudgetExhausted:
        # Das Ende des Budgets ist kein Fehlschlag dieses Paares: `distinct`
        # waere hier eine stille Falschentscheidung.
        raise
    except Exception as e:
        log.warning("dream reconcile: judge call failed (%s) - pair stays distinct", e)
        # `transport_error` ist die Fahne, an der `build_plan` eine Fehlserie
        # erkennt. Ohne sie sieht ein Transportfehler wie ein Urteil aus: am
        # 16.08.2026 war der Modellserver ueber Stunden nicht startbar, und der
        # Lauf hat jedes Paar als "distinct" abgehakt, ohne dass irgendwo etwas
        # anderes stand als eine Warnzeile je Paar. Ein Plan, in dem nichts
        # zusammengefuehrt wird, weil nichts gefragt werden konnte, sieht
        # genauso aus wie einer, in dem nichts zusammengehoert.
        return {"relation": RELATION_DISTINCT, "keep": None, "older": None,
                "reason": f"Aufruf fehlgeschlagen: {e}", "cost_usd": 0.0,
                "transport_error": True}
    try:
        payload = _parse_result(envelope.get("result"))
    except ValueError as e:
        log.warning("dream reconcile: judge returned non-JSON (%s)", e)
        payload = {}
    verdict = parse_verdict(payload, a, b)
    verdict["cost_usd"] = float(envelope.get("total_cost_usd") or 0.0)
    store.put_verdict(fingerprint, verdict, dcfg.RECONCILE_MODEL)
    return verdict


def _parse_result(result_text: object) -> dict:
    """Same tolerance as extract.parse_result_json, without depending on that
    module: the shared piece lives in `jsonflick`, which both import. Kept
    separate for the reason the older comment gave - this module must keep
    working while extract.py is being changed - but through a small stable
    module instead of a second copy of the same code.

    Since 2026-08-12 the answer also goes through the quote repair. The judge
    writes a free `reason` sentence, and grug will happily copy a German
    quotation mark out of the two claims it is comparing; verbatim in a JSON
    string, that ends the string early. A lost verdict is cheaper here than a
    lost extraction batch - the pair simply stays undecided - but it is the
    same defect and it has the same one-line cure."""
    if not isinstance(result_text, str):
        raise ValueError("result field is not a string")
    text = result_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text[:4].lower() == "json":
            text = text[4:]
        text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    data, geflickt = jsonflick.lade_mit_flicken(text)
    if geflickt:
        log.warning("dream reconcile: %d woertlich kopierte(s) Zeichen im "
                   "Urteil maskiert, Antwort danach lesbar", geflickt)
    if not isinstance(data, dict):
        raise ValueError("top-level JSON is not an object")
    return data


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Group:
    group_id: str
    members: list
    subject: str | None
    target: str | None
    op: str | None
    representative: str | None
    merged_away: list
    decided_by: str
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Supersession:
    newer: str
    older: str
    decided_by: str
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Plan:
    run_id: str
    created_at: str
    groups: list = field(default_factory=list)
    supersessions: list = field(default_factory=list)
    targets: dict = field(default_factory=dict)      # claim_id -> {target, op, subject}
    merged_into: dict = field(default_factory=dict)  # claim_id -> representative
    stats: dict = field(default_factory=dict)

    # -- what the shadow asks it -------------------------------------------

    def route(self, claim: dict) -> tuple[str, str] | None:
        """(target, op) for a claim, or None when it has no usable target. The
        seam `shadow.build_changeset` calls instead of its own `route`."""
        entry = self.targets.get(str(claim.get("claim_id")))
        if entry is None:
            return None
        return entry["target"], entry["op"]

    def representative_of(self, claim_id: str) -> str | None:
        """The claim that stands for this one, when it was merged away."""
        return self.merged_into.get(str(claim_id))

    def subject_for(self, claim_id: str) -> str | None:
        """The subject a page created for this claim is TITLED after.

        The title has to come from the same decision the path came from.
        Measured 2026-08-08: while `_make_hunk` fell back to the provisional
        `subject_key`, a page correctly routed to `10-global/dream/aes.md` was
        titled `20260729-185314` - the file name of the worker result. The
        title is not covered by `added_text`, which strips frontmatter, and it
        is what `brain search` and the resolver key on.
        """
        entry = self.targets.get(str(claim_id))
        return entry.get("subject") if entry else None

    def supersedes_for(self, claim_id: str) -> str | None:
        for s in self.supersessions:
            newer = s["newer"] if isinstance(s, dict) else s.newer
            older = s["older"] if isinstance(s, dict) else s.older
            if newer == claim_id:
                return older
        return None

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id, "created_at": self.created_at,
            "groups": [g.to_dict() if isinstance(g, Group) else g
                       for g in self.groups],
            "supersessions": [s.to_dict() if isinstance(s, Supersession) else s
                              for s in self.supersessions],
            "targets": self.targets, "merged_into": self.merged_into,
            "stats": self.stats,
        }


def load_plan(path: Path) -> Plan:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return Plan(run_id=str(data.get("run_id") or ""),
                created_at=str(data.get("created_at") or ""),
                groups=list(data.get("groups") or []),
                supersessions=list(data.get("supersessions") or []),
                targets=dict(data.get("targets") or {}),
                merged_into=dict(data.get("merged_into") or {}),
                stats=dict(data.get("stats") or {}))


def write_plan(plan: Plan, vault: Path) -> Path:
    """Into the versioned audit path next to the changeset - what an autonomous
    run decided has to stay diffable (DREAM-PLAN.md Abschnitt 3)."""
    path = shadow_mod.audit_dir(vault, plan.run_id) / dcfg.PLAN_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2,
                               sort_keys=True) + "\n", encoding="utf-8")
    return path


def compute_group_id(members: list[str]) -> str:
    return hashlib.sha256("\x1f".join(sorted(members)).encode()).hexdigest()[:16]


def group_pairs(members: list[str], by_id: dict[str, dict],
                vocabulary: frozenset[str]) -> list[tuple[str, str, bool]]:
    """The pairs of a group to decide, as (a, b, safe).

    `safe` is DREAM-PLAN.md Abschnitt 5's "sicherer Fall": the two name the SAME
    subject - an actual one, not both of them naming none - AND carry an
    identical value signature, so no number, date, path, identifier or model
    name can be lost by letting one stand for the other. Everything else is the
    case the plan sends to a judge, because that is exactly where a small model
    drops digits.

    A group past RECONCILE_MAX_PAIRWISE_GROUP is compared against its oldest
    member only: pairwise is quadratic, and a group that big is a threshold
    artefact rather than a pile of duplicates.
    """
    ordered = sorted(members, key=lambda c: (by_id[c]["recorded_at"], c))
    if len(ordered) > dcfg.RECONCILE_MAX_PAIRWISE_GROUP:
        combos = [(ordered[0], other) for other in ordered[1:]]
    else:
        combos = [(a, b) for i, a in enumerate(ordered) for b in ordered[i + 1:]]
    out = []
    for a, b in combos:
        subjekt_a = claim_subject(by_id[a], vocabulary)
        subjekt_b = claim_subject(by_id[b], vocabulary)
        # `is not None` ist der Kern dieser Zeile. Ohne ihn ist `None == None`
        # wahr, und zwei Aussagen, die BEIDE gar kein Subjekt haben, gelten als
        # "sicher derselbe Fall" - obwohl nichts sie verbindet ausser der
        # Naehe ihrer Vektoren. Gemessen am echten Bestand (16.08.2026): von
        # 3.791 so eingestuften Paaren beruhten 1.801 auf genau diesem
        # None-gleich-None, und bei 2.931 war zusaetzlich die Wertesignatur
        # leer, die zweite Pruefung also ebenfalls gegenstandslos. Im
        # schlimmsten Fall wird eine Aussage verworfen, weil ZWEI leere
        # Vergleiche zufaellig uebereinstimmen.
        #
        # Ein sicherer Fall braucht einen BELEG, nicht das Ausbleiben eines
        # Widerspruchs. Was hier herausfaellt, ist nicht verloren: es geht den
        # normalen Weg ueber ein Urteil, und ohne Urteil bleibt es
        # unzusammengefuehrt - beide Aussagen stehen weiter.
        safe = (subjekt_a is not None and subjekt_a == subjekt_b
                and value_signature(by_id[a]) == value_signature(by_id[b]))
        out.append((a, b, safe))
    return out


def build_plan(vault: Path, rows: list[dict], *, run_id: str,
               vectors: dict[str, list[float]],
               store: ReconcileStore,
               call=None,
               notes: list[Note] | None = None,
               max_cloud_calls: int | None = None,
               min_sim: float = dcfg.RECONCILE_GROUP_MIN_SIMILARITY,
               budget=None) -> Plan:
    """Groups, merge decisions, supersessions and a target per claim.

    `max_cloud_calls=None` nimmt den Deckel, der zum Richter passt: gegen die
    Rechnung, wenn er in der Wolke sitzt, sonst nur gegen den entgleisten Lauf
    (`config.reconcile_hard_cap`).

    Deterministic end to end given the same vectors and the same cached
    verdicts: groups come from a fixed traversal order, representatives from
    `recorded_at` then claim id, subjects from counts with fixed tie-breaks.
    That is what makes a second run over an unchanged corpus produce an
    identical plan, which is in turn what makes the changeset empty.
    """
    vault = Path(vault)
    rows = [r for r in rows if not r.get("valid_to")]
    by_id = {r["claim_id"]: r for r in rows}
    notes = load_notes(vault) if notes is None else notes
    resolver = build_resolver([n for n in notes
                               if not shadow_mod.is_dream_output(n)])
    vocabulary = marked_vocabulary(rows)
    shared_subjects = subject_frequency(rows, vocabulary)

    if budget is not None and call is not None:
        call = budget.guard(call, "reconcile", dcfg.RECONCILE_MODEL)

    plan = Plan(run_id=run_id, created_at=_now_iso())
    budget_stopped = None
    if max_cloud_calls is None:
        max_cloud_calls = dcfg.reconcile_hard_cap()
    cloud_calls = 0
    cloud_cost = 0.0
    cloud_capped = 0
    time_capped = 0
    transport_left = 0
    transport_stopped: str | None = None
    fehlserie = 0
    mechanical_merges = 0
    refused_supersessions = 0
    # Die Stueckzahl deckelt einen Amoklauf, nicht die Nacht. Gemessen am
    # 16.08.2026: 4.169 offene Paare, 14 s je Urteil im eingeschwungenen
    # Zustand - 16,2 Stunden, waehrend der Deckel bei 4.000 Urteilen liegt und
    # damit groesser ist als der Rueckstand. Ein unbeaufsichtigter Lauf braucht
    # eine Schranke in der Einheit, die ihm ausgeht, und das ist Zeit.
    # Nebenlaeufig ginge es nicht: die Verbindung des Zwischenspeichers ist an
    # ihren Thread gebunden ("SQLite objects created in a thread can only be
    # used in that same thread", gemessen mit vier Spuren).
    #
    # Was nach Ablauf liegen bleibt, bleibt UNGEURTEILT - also nicht
    # zusammengefuehrt, beide Aussagen bleiben stehen. Das kostet Redundanz,
    # nie Inhalt, und die Urteile sind zwischengespeichert: der naechste Lauf
    # macht dort weiter, statt von vorn zu beginnen.
    # Die Uhr laeuft ab dem ERSTEN Urteil, nicht ab dem Start des Schritts.
    # Ab Schrittbeginn gerechnet zaehlte die Gruppierung gegen die Frist - im
    # Rueckfallweg ohne numpy sind das Stunden, und der Lauf haette keine
    # Sekunde mehr fuers Urteilen. Gefunden von
    # `test_die_frist_wird_nicht_von_der_gruppierung_aufgebraucht`.
    frist = dcfg.RECONCILE_JUDGE_TIME_BUDGET_SECONDS
    begonnen_urteile: float | None = None

    # Zweite stille Phase des Abgleichs, und die laengere: jede Gruppe wird
    # geroutet, und Paare mit abweichenden Werten gehen einzeln an ein Modell.
    # Ohne Lebenszeichen ist ein Lauf, der 21.648 Gruppen durcharbeitet, von
    # einem haengenden nicht zu unterscheiden - die Wache meldet nach 25
    # stillen Minuten einen Stillstand, den es nicht gibt (16.08.2026).
    #
    # Gemeldet wird nach Gruppen ODER nach Zeit, und die Zeit ist der
    # eigentliche Punkt: Gruppen mit zu beurteilenden Paaren sind selten (2.816
    # von 21.669), aber jede kostet Minuten. Eine Zaehlung allein nach Gruppen
    # kann also stundenlang schweigen, waehrend der Lauf voll arbeitet - genau
    # die Stille, gegen die diese Zeile geschrieben ist.
    gruppen_gesamt = 0
    begonnen_gruppen = time.monotonic()
    zuletzt_gemeldet = begonnen_gruppen
    for members in group_claims(rows, vectors, min_sim):
        gruppen_gesamt += 1
        jetzt = time.monotonic()
        if (gruppen_gesamt % dcfg.RECONCILE_GROUP_LOG_EVERY == 0
                or jetzt - zuletzt_gemeldet >= dcfg.RECONCILE_GROUP_LOG_SECONDS):
            zuletzt_gemeldet = jetzt
            log.info("dream reconcile: %d Gruppen entschieden, %d Urteile, "
                     "%d mechanisch, %.0f s", gruppen_gesamt, cloud_calls,
                     mechanical_merges, jetzt - begonnen_gruppen)
        member_rows = [by_id[c] for c in members]
        subject, target, op = route_group(member_rows, vocabulary,
                                          shared_subjects, resolver, vault)
        group_id = compute_group_id(members)

        merged_into: dict[str, str] = {}
        decided_by = DECIDED_SINGLE
        reason = ""

        for a, b, safe in group_pairs(members, by_id, vocabulary):
            if safe:
                loser, winner = _older_first(by_id[a], by_id[b])
                merged_into.setdefault(loser, winner)
                mechanical_merges += 1
                decided_by = DECIDED_MECHANICAL
                reason = "gleicher Subjektschluessel, identische Wertemenge"
                continue
            if call is None:
                if decided_by == DECIDED_SINGLE:
                    decided_by = DECIDED_UNJUDGED
                    reason = "Werte weichen ab - kein Cloud-Urteil angefordert"
                continue
            if transport_stopped:
                transport_left += 1
                continue
            if cloud_calls >= max_cloud_calls:
                cloud_capped += 1
                continue
            if begonnen_urteile is None:
                begonnen_urteile = time.monotonic()
            if frist and time.monotonic() - begonnen_urteile >= frist:
                if not time_capped:
                    log.warning(
                        "dream reconcile: Urteilsfrist von %.0f s erreicht "
                        "nach %d Urteilen - der Rest bleibt ungeurteilt und "
                        "damit unzusammengefuehrt; die Urteile sind "
                        "zwischengespeichert, der naechste Lauf macht weiter",
                        frist, cloud_calls)
                time_capped += 1
                continue
            try:
                verdict = judge_pair(by_id[a], by_id[b], call, store)
            except BudgetExhausted as e:
                # Angehalten, nicht entschieden: die Gruppe behaelt, was bis
                # hierher feststeht, und der naechste Lauf rechnet sie neu -
                # zum Nulltarif, weil die Urteile zwischengespeichert sind.
                budget_stopped = str(e)
                log.warning("dream reconcile: %s", e)
                break
            if not verdict.get("cached"):
                cloud_calls += 1
                cloud_cost += float(verdict.get("cost_usd") or 0.0)
            if verdict.get("transport_error"):
                # Ein Transportfehler ist KEIN Urteil. Er kommt als "distinct"
                # zurueck, weil das die Entscheidung ist, die nichts aendert -
                # aber eine Serie davon heisst, dass der Richter gar nicht
                # erreichbar ist, und dann sind die naechsten tausend
                # "distinct" keine Erkenntnis, sondern dasselbe Schweigen.
                fehlserie += 1
                if fehlserie >= dcfg.RECONCILE_MAX_CONSECUTIVE_FAILURES:
                    transport_stopped = str(verdict.get("reason")
                                            or "der Richter antwortet nicht")
                    log.error(
                        "dream reconcile: %d Urteile in Folge sind am "
                        "Transport gescheitert (%s) - es wird nicht weiter "
                        "gefragt. Der Rest bleibt UNGEURTEILT und damit "
                        "unzusammengefuehrt; nichts davon ist "
                        "zwischengespeichert, ein spaeterer Lauf holt es nach",
                        fehlserie, transport_stopped)
                # Der Fehlschlag selbst zaehlt nicht als Entscheidung: `reason`
                # und `decided_by` bleiben, wie sie waren.
                continue
            fehlserie = 0
            decided_by = DECIDED_CLOUD
            reason = str(verdict.get("reason") or "")
            if verdict["relation"] == RELATION_SAME:
                loser = b if verdict["keep"] == a else a
                merged_into.setdefault(loser, verdict["keep"])
            elif verdict["relation"] == RELATION_SUPERSEDES:
                plan.supersessions.append(Supersession(
                    newer=verdict["keep"], older=verdict["older"],
                    decided_by=DECIDED_CLOUD, reason=reason))
            elif REFUSAL_MARKER in reason:
                refused_supersessions += 1

        merged_into = _resolve_chains(merged_into)
        representative = _representative(members, merged_into, by_id)

        plan.groups.append(Group(
            group_id=group_id, members=sorted(members), subject=subject,
            target=target, op=op, representative=representative,
            merged_away=sorted(merged_into), decided_by=decided_by,
            reason=reason))
        plan.merged_into.update(merged_into)
        if budget_stopped:
            # Diese Gruppe bekommt KEIN Ziel mehr. Ihre Zusammenfuehrungen sind
            # unvollstaendig geurteilt, und zwei Aussagen, deren Paar nie
            # beurteilt wurde, wuerden sonst beide eine Zeile bekommen. Ein
            # Ziel weniger kostet einen Lauf, eine doppelte Zeile kostet eine
            # Notiz - unter Qualitaet vor Kosten ist das die einfache Wahl.
            break
        if target is not None:
            for cid in members:
                if cid in merged_into:
                    continue     # stands for nothing of its own any more
                plan.targets[cid] = {"target": target, "op": op,
                                     "subject": subject}

    plan.stats = {
        "budget_stopped": budget_stopped,
        "claims": len(rows),
        "claims_with_vector": sum(1 for r in rows if r["claim_id"] in vectors),
        "groups": len(plan.groups),
        "groups_multi": sum(1 for g in plan.groups if len(g.members) > 1),
        "claims_with_target": len(plan.targets),
        "claims_without_subject": len(rows) - len(plan.targets)
                                  - len(plan.merged_into),
        "merged_away": len(plan.merged_into),
        "mechanical_merges": mechanical_merges,
        "supersessions": len(plan.supersessions),
        "refused_supersessions": refused_supersessions,
        "cloud_calls": cloud_calls,
        "cloud_cost_usd": round(cloud_cost, 6),
        "cloud_capped_pairs": cloud_capped,
        # Getrennt gezaehlt, nicht zu cloud_capped_pairs geschlagen: beides
        # heisst 'ungeurteilt', aber der Grund entscheidet, was zu tun ist -
        # die Stueckzahl anheben oder dem Lauf mehr Zeit geben.
        "time_capped_pairs": time_capped,
        "transport_left_pairs": transport_left,
        "transport_stopped": transport_stopped,
        "distinct_targets": len({e["target"] for e in plan.targets.values()}),
    }
    return plan


def _older_first(a: dict, b: dict) -> tuple[str, str]:
    """(loser, winner) for a mechanical merge: the newest wording survives,
    claim id breaks a tie so the choice never depends on iteration order."""
    ordered = sorted([a, b], key=lambda r: (r["recorded_at"], r["claim_id"]))
    return ordered[0]["claim_id"], ordered[1]["claim_id"]


def _resolve_chains(merged_into: dict[str, str]) -> dict[str, str]:
    """A merged into B and B merged into C must leave A pointing at C, not at a
    claim that is itself gone."""
    out: dict[str, str] = {}
    for start in merged_into:
        seen = {start}
        current = merged_into[start]
        while current in merged_into and current not in seen:
            seen.add(current)
            current = merged_into[current]
        out[start] = current
    return out


def _representative(members: list[str], merged_into: dict[str, str],
                    by_id: dict[str, dict]) -> str | None:
    survivors = [c for c in members if c not in merged_into]
    if not survivors:
        return None
    return sorted(survivors, key=lambda c: (by_id[c]["recorded_at"], c))[-1]


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def format_reconcile_report(plan: Plan, dry_run: bool = False) -> str:
    s = plan.stats
    lines = [f"dream reconcile{' (dry-run)' if dry_run else ''} "
             f"(Lauf {plan.run_id})", "",
             f"Aussagen betrachtet: {s.get('claims', 0)}",
             f"  davon eingebettet: {s.get('claims_with_vector', 0)}",
             f"Gruppen: {s.get('groups', 0)} "
             f"(mehr als eine Aussage: {s.get('groups_multi', 0)})",
             f"Zusammengefuehrt, mechanisch: {s.get('mechanical_merges', 0)}",
             f"Aussagen, die eine andere vertritt: {s.get('merged_away', 0)}",
             f"Ablösungen: {s.get('supersessions', 0)} "
             f"(vom Code abgelehnt, weil nicht juenger: "
             f"{s.get('refused_supersessions', 0)})",
             f"Cloud-Aufrufe: {s.get('cloud_calls', 0)} "
             f"(Kosten {s.get('cloud_cost_usd', 0.0)} USD"
             + (f", {s['cloud_capped_pairs']} Paare wegen Obergrenze offen"
                if s.get("cloud_capped_pairs") else "")
             + (f", {s['time_capped_pairs']} Paare wegen Zeitfrist offen"
                if s.get("time_capped_pairs") else "") + ")"]
    if s.get("transport_stopped"):
        lines += ["",
                  f"ABGEBROCHEN, der Richter antwortete nicht mehr: "
                  f"{s['transport_stopped']}",
                  f"  {s.get('transport_left_pairs', 0)} Paare blieben "
                  f"ungeurteilt und damit unzusammengefuehrt."]
    lines += ["",
             f"Aussagen mit Ziel: {s.get('claims_with_target', 0)} "
             f"auf {s.get('distinct_targets', 0)} Dateien",
             f"Aussagen ohne brauchbares Subjekt: "
             f"{s.get('claims_without_subject', 0)}"]
    targets: dict[str, int] = {}
    for entry in plan.targets.values():
        targets[entry["target"]] = targets.get(entry["target"], 0) + 1
    if targets:
        lines += ["", "Je Zieldatei:"]
        lines += [f"  {n:3d}  {rel}" for rel, n in
                  sorted(targets.items(), key=lambda kv: (-kv[1], kv[0]))]
    return "\n".join(lines)
