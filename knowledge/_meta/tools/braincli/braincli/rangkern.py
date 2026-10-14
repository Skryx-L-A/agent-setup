"""Gemeinsamer Rangkern von `brain search` (Mac-CLI, `braincli.search`) und
Brain-Dienst (peer-App, `braindienst.search_service`).

Bis 2026-09-28 hatten beide eigene Rangwege: der Dienst fusionierte mit
RRF k=60 statt 15, ohne Navigationsbonus, ohne Gueltigkeitsabwertung und mit
Skalarprodukt statt Kosinus, sodass dieselbe Frage in CLI und App
verschiedene Antworten gab (ana-retrieval, Empfehlung 3). Hier liegt jetzt
alles, was die Rangfolge bestimmt: Tokenizer, BM25 mit Titelbonus und
derived-Behandlung, Kosinusliste, RRF, Navigationsbonus, derived-Abwertung,
Gueltigkeitsabwertung, Auszug mit Zeilenbereich. Dienstspezifisch bleiben nur
die Korpusquelle (Vereinigung der Space-Spiegel) und der Rechtefilter, der
festlegt, welche Spiegel ueberhaupt hereinkommen.

Treffer werden ueber (space, rel) identifiziert: in der CLI ist `space` bis
zur Beschriftung leer und `rel` vault-relativ; im Dienst ist `space` die
Space-Kennung und `rel` spiegelrelativ (zwei Spaces koennen beide `MOC.md`
haben)."""
from __future__ import annotations

import json
import math
import os
import re
import threading
from contextvars import ContextVar
from dataclasses import dataclass, field
from operator import mul
from pathlib import Path

# ---------------------------------------------------------------------------
# Tokenizer

TOKEN_RE = re.compile(r"[\w']+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    """Rohe Woerter (klein), der Tokenizer bis 2026-09-28. Bleibt fuer
    Stoppwortfilter und Messskripte, die rohe Woerter brauchen."""
    return TOKEN_RE.findall(text.lower())


# BM25 mit deutschem Stemmer und Zeichen-4-Grammen fuer Staemme ab 6 Zeichen (b6-suche,
# 28.09.). `[\w']+` allein findet "Einbettungen" nicht unter "Einbettung" und
# "Suchindex" nicht unter "Index"; Snowball-German fasst Flexionsformen
# zusammen, die N-Gramme langer Staemme sind ein billiger Ersatz fuer eine
# Kompositazerlegung. Nur fuer den Index/Anfrage-Abgleich; Titelbonus und
# Auszugswahl vergleichen Staemme ohne Gramme (Gramme wuerden dort jede
# Teilwortgleichheit mehrfach zaehlen). Parameter auf der Dev-Haelfte des
# blinden 200er-Satzes gewaehlt (Raster n 4/5/6 x Mindestlaenge 6/8/10, Regel:
# bestes BM25-MRR@10 gradiert; 4/6: 0,340 -> 0,482, Hybrid 0,457 -> 0,516),
# einmal auf Test geprueft:
# `~/.pi-workers/results/b6-suche/ergebnis.md`.
# BRAIN_SEARCH_STEM=0 ist der Rueckweg auf die rohen Woerter, ohne Neubau.
STEM_ENV = "BRAIN_SEARCH_STEM"
STEM_CACHE_ENV = "BRAIN_SEARCH_STEM_CACHE"
NGRAM_N = 4
NGRAM_MIN = 6
# BRAIN_SEARCH_NGRAM="n,min" setzt die Parameter fuer Messlaeufe ("0" = nur Staemme).
NGRAM_ENV = "BRAIN_SEARCH_NGRAM"


def _ngram_from_env() -> None:
    global NGRAM_N, NGRAM_MIN
    raw = os.environ.get(NGRAM_ENV, "").strip()
    if not raw:
        return
    try:
        parts = [int(x) for x in raw.split(",")]
    except ValueError:
        return
    if parts == [0]:
        NGRAM_N = 0
    elif len(parts) == 2 and parts[0] > 0 and parts[1] >= parts[0]:
        NGRAM_N, NGRAM_MIN = parts


_ngram_from_env()
NGRAM_MARK = "#"   # Gramme duerfen nie mit einem echten Wort zusammenfallen

_stem_lock = threading.Lock()
_stemmer = None
_stems: dict[str, str] = {}
_stems_new = 0
_index_forms: dict[str, tuple[str, ...]] = {}
_index_params: tuple[int, int] = (NGRAM_N, NGRAM_MIN)


def stem_enabled() -> bool:
    raw = os.environ.get(STEM_ENV)
    return raw is None or raw.strip().lower() not in ("0", "off", "false", "no", "nein")


def _stem_word(word: str) -> str:
    """Snowball-German-Stamm, prozessweit zwischengespeichert. Woerter mit
    Ziffern, Unterstrich oder Apostroph (Versionen, Bezeichner, Hashes)
    bleiben wie sie sind: der Stemmer wuerde sie nur verbiegen, und sie
    blaehen den Zwischenspeicher auf."""
    s = _stems.get(word)
    if s is not None:
        return s
    if not word.isalpha():
        return word
    global _stemmer, _stems_new
    with _stem_lock:  # Snowball-Stemmer sind nicht threadsicher (Dienst)
        if _stemmer is None:
            import snowballstemmer
            _stemmer = snowballstemmer.stemmer("german")
        s = _stemmer.stemWord(word)
        _stems[word] = s
        _stems_new += 1
    return s


def stem_tokens(text: str) -> list[str]:
    """Staemme ohne Gramme: Titelbonus und Auszugswahl."""
    words = tokenize(text)
    if not stem_enabled():
        return words
    return [_stem_word(w) for w in words]


def _index_form(word: str) -> tuple[str, ...]:
    global _index_params
    params = (NGRAM_N, NGRAM_MIN)
    if params != _index_params:  # Messskripte setzen die Parameter um
        _index_forms.clear()
        _index_params = params
    forms = _index_forms.get(word)
    if forms is None:
        s = _stem_word(word)
        n, lo = params
        if n > 0 and len(s) >= lo:
            forms = (s,) + tuple(NGRAM_MARK + s[i:i + n] for i in range(len(s) - n + 1))
        else:
            forms = (s,)
        _index_forms[word] = forms
    return forms


def index_tokens(text: str) -> list[str]:
    """BM25-Token fuer Notiz und Anfrage: Stamm je Wort plus N-Gramme langer
    Staemme. Mit BRAIN_SEARCH_STEM=0 die rohen Woerter."""
    words = tokenize(text)
    if not stem_enabled():
        return words
    out: list[str] = []
    for w in words:
        out.extend(_index_form(w))
    return out


def index_counts(text: str) -> "Counter[str]":
    """`Counter(index_tokens(text))`, aber je verschiedenem Wort nur einmal
    gestemmt und zerlegt (ein Viertel der Arbeit)."""
    from collections import Counter

    raw = Counter(tokenize(text))
    if not stem_enabled():
        return raw
    _index_form("")  # Parameterwechsel pruefen, einmal je Aufruf
    forms_of = _index_forms
    flat: list[str] = []
    for w, c in raw.items():
        forms = forms_of.get(w) or _index_form(w)
        flat.extend(forms * c if c > 1 else forms)
    return Counter(flat)


def stem_cache_path(vault: Path) -> Path | None:
    """Datei des Stammspeichers fuer `vault`: BRAIN_SEARCH_STEM_CACHE (Pfad,
    oder 0/off zum Abschalten), sonst `state/search-stems.json` im
    Werkzeugverzeichnis DIESES Vaults. Die CLI ist ein Prozess je Anfrage;
    ohne Speicher kostet das Stemmen der rund 35.000 Vault-Woerter 1,2 s je
    Aufruf, mit ihm rund 30 ms Laden."""
    raw = os.environ.get(STEM_CACHE_ENV, "").strip()
    if raw.lower() in ("0", "off", "false", "no", "nein"):
        return None
    if raw:
        return Path(raw).expanduser()
    from gardener import config
    return config.tool_dir_for(vault) / "state" / "search-stems.json"


def token_form() -> list:
    """Woran zwischengespeicherte Token haengen: Stemmer an/aus, Version,
    N-Gramm-Parameter."""
    return [stem_enabled(), _stemmer_version() if stem_enabled() else "", NGRAM_N, NGRAM_MIN]


def _stemmer_version() -> str:
    try:
        from importlib.metadata import version
        return "snowball-german-" + version("snowballstemmer")
    except Exception:
        return "snowball-german"


def load_stem_cache(path: Path | None) -> None:
    """Bestaende aus `path` in den Prozessspeicher laden. Fehlt die Datei,
    ist sie kaputt oder von einer anderen Stemmer-Version, wird sie ignoriert
    (die Staemme entstehen dann neu)."""
    if path is None or not stem_enabled():
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(raw, dict) or raw.get("stemmer") != _stemmer_version():
        return
    stems = raw.get("stems")
    if isinstance(stems, dict):
        for w, s in stems.items():
            if isinstance(w, str) and isinstance(s, str):
                _stems.setdefault(w, s)


def save_stem_cache(path: Path | None) -> None:
    """Schreibt den Prozessspeicher zurueck, wenn neue Staemme entstanden
    sind. Nur in ein vorhandenes Verzeichnis (ein Wegwerf-Vault ohne
    `state/` bekommt keine Datei), atomar ueber eine Nachbardatei, still bei
    jedem Fehler: die Suche darf nie am Speicher scheitern."""
    global _stems_new
    if path is None or not _stems_new or not path.parent.is_dir():
        return
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with _stem_lock:
            data = {"stemmer": _stemmer_version(), "stems": dict(_stems)}
            _stems_new = 0
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                       encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Treffer und Konstanten

# Reciprocal Rank Fusion constant. The RRF paper's k=60 targets web-scale
# result lists (thousands of candidates); this vault's candidate pool per
# ranker is `pool = max(k*4, 20)` (hybrid pipeline below), one to two orders
# of magnitude smaller, so a fixed k=60 barely differentiates i=0..20 and RRF
# collapses toward "which ranker returned more of the same notes" -- a note
# that is the single strongest semantic match but appears only in one list
# gets buried under mediocre hybrid hits (suchqualitaet task, 2026-09-23).
#
# Regridded on this vault (~500 notes, embeddinggemma) with paired same-
# process runs (dev half of queries-recall.yaml + queries.yaml, both
# rrf_k values measured back-to-back against the SAME loaded corpus/
# embeddings, since ~/Knowledge is a live shared vault and gets edited by
# other sessions mid-measurement -- separate subprocess runs minutes apart
# were not comparable). k=6-10 won clearly on one snapshot (dev hit@1
# 0.633->0.667, queries.yaml recall@5 0.892->0.946) but on a later paired
# check REGRESSED queries.yaml recall@1 (0.676->0.649: q07 and the newly-
# renamed-path q26 dropped out of rank 1, both MOC/STATUS-navigational
# queries where NAV_BOOST's fixed +0.15 no longer reliably outweighs a low
# RRF_K's steeper score falloff). k=12..25 never regressed recall@1 in any
# snapshot checked (always equal or better than k=60) while still capturing
# part of the dev/hit@5 gain seen on the first snapshot; k=15 is the
# midpoint. Rejected: k<12 (regression risk above), k>25 (no longer
# measurably different from the old k=60 default). See
# _meta/tools/eval/results/suchqualitaet-rrf-k.md.
RRF_K = 15

# MOC.md/STATUS.md retrieval fix (2026-07-28), measured in
# _meta/tools/eval/results/moc-root-cause.md + moc-fix-comparison.md. Root cause was
# structural: gardener excludes MOC.md from its own linking corpus
# (gardener/topics.py), and braincli's search reused that same walk, so MOC.md
# got zero BM25 signal and (except the 4 30-topics hubs gardener embeds for
# its own hub logic) zero embedding signal either -- see .vault.load_search_notes
# and .extra_embed for the corpus/embedding side of the fix. These two
# constants are the second half: even after MOC.md re-enters both rankers,
# Reciprocal Rank Fusion still structurally favors a mediocre hit-in-both-lists
# over a note that is the single strongest semantic match but appears in only
# one list. Tuned via a small grid (title 1-4, nav 0.10-0.30) on 28 real
# queries: TITLE_BOOST=2.0 (title/query token-overlap bonus, any note) and
# NAV_BOOST=0.15 (MOC.md/STATUS.md bonus, navigational-looking queries only)
# together took overall recall@1 0.571->0.750 and MRR 0.707->0.839 with no
# regression, and the MOC/STATUS query subset to recall@1/3/5/MRR=1.0. A third
# option (append linked-note titles to a hub's indexed text) measured
# flat-to-negative on its own and was dropped from the combination -- the
# vault's own MOC.md files already carry real prose, not just link lists.
TITLE_BOOST = 2.0
NAV_BOOST = 0.15
HUB_BASENAMES = {"MOC.md", "STATUS.md"}
NAV_TRIGGERS = (
    "wo ", "wo faengt", "wo fängt", "themen-hub", "themenhub", "stand von",
    "stand vom", "stand beim", "aktueller stand", "übersicht", "uebersicht",
    "einstieg", "welche entscheidungen", "entscheidungen zu", "entscheidungen gibt",
    " moc", "status von", "status vom",
)

# Validity (2026-08-10). The dream retires a superseded claim by setting
# `valid_to` in state/dream/claims.db and leaves its text byte for byte in
# place (gardener/dream/apply.py, D2). Search never knew about it, so a note
# whose statements have been superseded ranked exactly like a fresh one.
# TEPA (arXiv 2608.07429) measures what that costs: under a full reversal of
# the facts an appending memory scores 0.210 and no memory at all 0.309, while
# a memory with an explicit retraction reaches 0.950 - delivering stale
# knowledge is worse than delivering none. So a hit gets marked and demoted,
# following the marker `brain contradict` already uses. It is never hidden and
# never dropped: `apply_validity` runs on the FINAL top-k list, after
# truncation, so demotion can only reorder what search was already going to
# show. Retirement itself stays reversible in claims.db (`valid_to` back to
# NULL) and this layer follows that value, it never stores a judgement of its
# own. Since 2026-09-28 the frontmatter (`status`, `superseded-by`,
# `valid-until`) is the first source and claims.db only speaks for notes
# without these fields; a successor may join or be lifted to the superseded
# hit's rank, so the weakest hit can fall off the end (see apply_validity).
#
# VALIDITY_DEMOTION is the demotion at full supersession; it scales with the
# share of a note's claims that are retired, so one wrongly retired claim in a
# note of sixteen costs 1/16 of it. Derived from the score distribution of the
# real vault ($HOME/Knowledge, 330 notes) on 2026-08-10: 30 German
# questions, hybrid search with Ollama up, no fallback run. Scores are
# max-normalized, so the top hit is 1.0 and the demotion has to carry a fully
# retired top hit below the weakest hit still in the list. Lowest last-rank
# score measured was 0.5037 at k=5 and 0.4921 at k=10, so the factor must
# exceed 1 - 0.4921 = 0.5079; 0.51 clears both (1 - 0.51 = 0.49 < 0.4921) and
# a fully retired top hit therefore sorts last in all 60 measured lists. It
# keeps 49% of its score, which is a demotion, not a removal.
VALIDITY_DEMOTION = 0.51

# Derived pages (`class: derived`: the gardener's topic syntheses in
# 30-topics/*/MOC.md and the pipeline's brain-vorschlaege.md) stay in the index
# but rank below the source notes they condense. Measured 24.09.2026 (v2-gaertner,
# 329 questions): taking the 30 topic pages out of the index moved 23 ranks up and
# 6 down (p 0.0023) - a page that keeps 5.3 % of its sources' facts crowds out the
# sources themselves. der Nutzer, 24.09.: adapt, do not remove. So their fused
# pages take no rank slot from source notes in fusion (see rrf_fuse) and their
# score is multiplied by DERIVED_FACTOR after fusion and nav boost; they remain
# findable (a query that only they answer still returns them) and readable by
# path. Value tuned on the dev halves, checked on the held-out halves:
# _meta/tools/eval/v2-gaertner/BEFUNDE.md, "Themenseiten abwerten".
# 1.0 switches the demotion off (rollback), via env without a code change.
DERIVED_FACTOR = 0.5
DERIVED_FACTOR_ENV = "BRAIN_SEARCH_DERIVED_FACTOR"
# Extra semantic candidates read so that derived pages among them do not
# shrink the source-note pool (vault 24.09.: 30 topic pages, 13 proposal pages).
DERIVED_POOL_EXTRA = 50


@dataclass
class SearchHit:
    rel: str
    score: float
    title: str = ""
    snippet: str = ""
    match: str = ""  # "semantic" | "text" | "hybrid"
    cosine: float = 0.0  # raw cosine similarity, 0.0 if never seen by semantic ranking
    bm25_rang: int = 0  # 1-based position in the lexical candidate list; 0 = absent
    bm25_norm: float = 0.0  # lexical score divided by the lexical top score
    vektor_rang: int = 0  # 1-based position in the semantic candidate list; 0 = absent
    contradiction: bool = False  # True if `brain contradict` has an open finding on this note
    retired: bool = False  # True if the dream has retired at least one claim from this note
    retired_claims: int = 0  # how many of the note's claims carry a valid_to
    total_claims: int = 0  # how many claims the dream drew from this note at all
    retired_since: str = ""  # newest valid_to among them, ISO date, "" if none
    space: str = ""  # CLI: space label (set after ranking); Dienst: Space-Kennung
    derived: bool = False  # `class: derived` page (topic synthesis, pipeline proposals)
    lines: tuple[int, int] | None = None  # 1-based first/last file line of the snippet block
    status: str = ""  # Frontmatter-Gueltigkeit, nur wenn abgewertet: superseded|archived|expired
    superseded_by: list = field(default_factory=list)  # `superseded-by`-Ziele wie geschrieben
    superseded_by_rel: list = field(default_factory=list)  # aufgeloeste Pfade der Nachfolger

    @property
    def key(self) -> tuple[str, str]:
        return (self.space, self.rel)


def is_derived(fm: dict) -> bool:
    return str((fm or {}).get("class") or "").strip() == "derived"


def derived_factor() -> float:
    raw = os.environ.get(DERIVED_FACTOR_ENV, "").strip()
    try:
        return max(0.0, min(1.0, float(raw))) if raw else DERIVED_FACTOR
    except ValueError:
        return DERIVED_FACTOR


def cosine(a: list[float], b: list[float]) -> float:
    # map(mul) statt Generator: gleiche Summationsreihenfolge, gleiche Werte,
    # rund dreimal schneller (1024 Dimensionen x 550 Notizen je Anfrage).
    dot = sum(map(mul, a, b))
    na = math.sqrt(sum(map(mul, a, a)))
    nb = math.sqrt(sum(map(mul, b, b)))
    return dot / (na * nb) if na and nb else 0.0


def max_normalize(hits: list[SearchHit]) -> list[SearchHit]:
    """Rescale scores to [0, 1] by dividing by the top hit's score, so callers
    (the auto-recall hook's score threshold) see a comparable range regardless
    of which ranker - or fusion - produced the list."""
    if not hits:
        return hits
    top = hits[0].score
    if top > 0:
        for h in hits:
            h.score = h.score / top
    return hits


# ---------------------------------------------------------------------------
# Auszug mit Zeilenbereich

SESSION_HOOK_RE_PREFIXES = ("Für künftige Sessions", "Fuer kuenftige Sessions")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
MAX_SNIPPET_SENTENCES = 3
# Measured uncapped (suchqualitaet task, 2026-09-23): picking the best-
# overlap block instead of always the first line raised the median snippet
# from 90 to 204 chars and the p90 from ~150 to 496 (up to 1610 for a
# sentence-poor block), which ate the JSON-shrink savings from hit_to_json/
# compact output and then some. Capped back to the old order of magnitude at
# a word boundary -- long enough for 1-3 real sentences, short enough that
# the token bill for `brain search -k5 --json` still went down overall.
MAX_SNIPPET_CHARS = 220

# Content-word filter for best_snippet's overlap scoring only (never for what
# gets displayed): without it, high-frequency function words ("und", "nicht",
# "ich", "the", "and", ...) dominate the overlap count and the highest-
# scoring block is essentially random. Short (~200-word) closed-class list,
# German + English since both occur in this vault.
STOPWORDS = frozenset("""
der die das den dem des ein eine einer eines einem einen und oder aber doch
auch noch nur schon nicht kein keine nie immer sehr mehr viel viele wenig
ich du er sie es wir ihr man mich dich sich uns euch mir dir ihm ihr ihnen
mein dein sein ihr unser euer diese dieser dieses jener jene jenes welche
welcher welches wer was wie wo wann warum wieso weshalb wozu wobei womit
ist sind war waren wird werden wurde wurden bin bist seid habe hast hat
haben hatte hatten kann kannst koennen konnte koennte muss musst muessen
musste sollte sollten will willst wollen wollte darf duerfen durfte
in im an am auf aus bei mit nach seit von vor zu zur zum ueber unter
zwischen durch fuer gegen ohne um als wenn weil dass ob damit sodass
so dann daher deshalb also hier da dort dabei dazu davon dafuer dagegen
einem einer eines
the a an and or but not no yes is are was were be been being do does did
have has had will would shall should can could may might must this that
these those i you he she it we they me him her us them my your his its
our their to of in on at by for with from as about into over under
between through if then so because than too very just also only
""".split())


def _clip(text: str, limit: int = MAX_SNIPPET_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "..."


def _file_lines(text: str) -> list[str]:
    """Zeilen wie im Editor: nur an `\\n` getrennt (`splitlines` trennt auch
    an Formfeed, U+2028 usw. und verschoebe damit die Zeilennummern)."""
    return [line.rstrip("\r") for line in text.split("\n")]


def _body_start(lines: list[str]) -> int:
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return i + 1
    return 0


def _body_blocks_lines(text: str) -> list[tuple[str, str, int, int]]:
    """(heading, paragraph, first line, last line) per blank-line-separated
    body block, lines 1-based in the file, frontmatter skipped."""
    lines = _file_lines(text)
    blocks: list[tuple[str, str, int, int]] = []
    heading = ""
    buf: list[tuple[int, str]] = []

    def flush():
        para = " ".join(s for _i, s in buf if s)
        if para:
            blocks.append((heading, para, buf[0][0] + 1, buf[-1][0] + 1))
        buf.clear()

    for i in range(_body_start(lines), len(lines)):
        s = lines[i].strip()
        if s.startswith("#"):
            flush()
            heading = s.lstrip("#").strip()
            continue
        if not s:
            flush()
            continue
        buf.append((i, s))
    flush()
    return blocks


def body_blocks(text: str) -> list[tuple[str, str]]:
    """(heading, paragraph) pairs from the body (frontmatter stripped), one
    per blank-line-separated block, tagged with the nearest preceding
    Markdown heading ("" if none yet)."""
    return [(h, p) for h, p, _a, _b in _body_blocks_lines(text)]


def hook_snippet_span(text: str) -> tuple[str, tuple[int, int] | None]:
    """First line matching the vault's 'Für künftige Sessions' recall convention,
    else the first non-empty, non-heading body line; with its file line."""
    lines = _file_lines(text)
    start = _body_start(lines)
    for i in range(start, len(lines)):
        s = lines[i].strip()
        if s.startswith(SESSION_HOOK_RE_PREFIXES):
            return s, (i + 1, i + 1)
    for i in range(start, len(lines)):
        s = lines[i].strip()
        if s and not s.startswith("#"):
            return s, (i + 1, i + 1)
    return "", None


def hook_snippet(text: str) -> str:
    return hook_snippet_span(text)[0]


def best_snippet_span(text: str, query: str) -> tuple[str, tuple[int, int] | None]:
    """The block (heading + up to 3 sentences) with the most query/text stem
    overlap, so a hit's snippet shows why it matched -- not always the same
    fixed opening line regardless of which part of the note the query is
    actually about -- together with the block's first and last file line
    (1-based; the snippet may show only the first sentences of that block).
    Falls back to `hook_snippet_span` whenever no block shares a query stem
    with the query, which keeps the old behavior for purely semantic matches
    and for queries that are themselves near-empty of content words."""
    words = [w for w in tokenize(query) if w not in STOPWORDS]
    if not words:
        return hook_snippet_span(text)
    query_stems = set(stem_tokens(" ".join(words)))
    best_score = 0
    best = None
    for heading, para, first, last in _body_blocks_lines(text):
        overlap = len(query_stems & set(stem_tokens(para)))
        if overlap > best_score:
            best_score = overlap
            best = (heading, para, first, last)
    if best is None:
        return hook_snippet_span(text)
    heading, para, first, last = best
    sentences = [s for s in SENTENCE_RE.split(para) if s]
    excerpt = _clip(" ".join(sentences[:MAX_SNIPPET_SENTENCES]).strip())
    return (f"{heading}: {excerpt}" if heading else excerpt), (first, last)


def best_snippet(text: str, query: str) -> str:
    return best_snippet_span(text, query)[0]


def fill_snippet(hit: SearchHit, text: str, query: str) -> SearchHit:
    hit.snippet, hit.lines = best_snippet_span(text, query)
    return hit


# ---------------------------------------------------------------------------
# Passage fuer den Umsortierer (Passagen-Reranker, b6-reranker/b6-rerank-dienst)

# Gewaehlt auf Dev (eval/reranker-passagen/BEFUNDE.md, 28.09.): Titel + bester
# Block + Folgebloecke bis 2000 Zeichen; kurze Passagen (500) brachten fast nichts.
PASSAGE_CHARS = 2000
PASSAGE_MAX_BLOCKS = 12


def passage_window(text: str, lines: tuple[int, int] | list[int] | None, title: str,
                   limit: int = PASSAGE_CHARS) -> str:
    """Titel, dann der Block, der in Zeile `lines[0]` beginnt (der beste Block
    aus `best_snippet_span`), und die folgenden Bloecke, bis `limit` Zeichen
    erreicht sind; an einer Wortgrenze gekuerzt. Ohne passenden Block (keine
    Zeilen, Hook-Zeile mitten im Block) ab dem Anfang des Koerpers. Dieselbe
    Logik wie `eval/reranker-passagen` (kandidaten.py + umsortieren.py,
    `fenster2000`), damit CLI und Dienst die gemessene Passage schicken."""
    all_blocks = _body_blocks_lines(text)
    blocks: list[str] = []
    if lines:
        started = False
        for heading, para, first, _last in all_blocks:
            if first == lines[0]:
                started = True
            if started:
                blocks.append(f"{heading}: {para}" if heading else para)
    if not blocks:
        blocks = [f"{h}: {p}" if h else p for h, p, _a, _b in all_blocks]
    body = ""
    for b in blocks[:PASSAGE_MAX_BLOCKS] or [""]:
        body = (body + "\n" + b) if body else b
        if len(body) >= limit:
            break
    if len(body) > limit:
        body = body[:limit].rsplit(" ", 1)[0]
    return f"{title}\n{body}"


# ---------------------------------------------------------------------------
# BM25

def title_boosted_scores(title_stems: list[set[str]], query_stems: set[str],
                         scores) -> list[float]:
    """Adds TITLE_BOOST per query/title stem overlap -- a note whose title
    literally names what's asked for should not have to out-lexical a longer,
    more verbose note on raw term frequency alone. Stems, never n-grams."""
    boosted = [float(s) for s in scores]
    if not query_stems:
        return boosted
    for i, ts in enumerate(title_stems):
        overlap = len(query_stems & ts)
        if overlap:
            boosted[i] += TITLE_BOOST * overlap
    return boosted


class Okapi:
    """BM25 Okapi, rechengleich zu `rank_bm25.BM25Okapi` (k1 1,5, b 0,75,
    epsilon 0,25, gleiche Formeln; IDF vektorisiert, die Werte koennen daher in
    der letzten Binaerstelle abweichen), aber
    auf vorab gezaehlten Termhaeufigkeiten: der Korpus ohne abgeleitete Seiten
    teilt sie mit dem ganzen Korpus, statt ein zweites Mal zu zaehlen. Mit
    den N-Grammen hat der Vault rund eine Million Token; zweimal
    `BM25Okapi` kostete am Mac 0,5 s je CLI-Aufruf."""

    k1 = 1.5
    b = 0.75
    epsilon = 0.25

    def __init__(self, doc_freqs: list, doc_len: list[int], state: tuple | None = None):
        from collections import Counter

        self.doc_freqs = doc_freqs
        self.doc_len = doc_len
        self.corpus_size = len(doc_freqs)
        self.avgdl = sum(doc_len) / self.corpus_size
        if state is not None:  # (idf, average_idf) aus dem CLI-Zwischenspeicher
            self.idf, self.average_idf = state
            return
        nd: Counter[str] = Counter()
        for f in doc_freqs:
            nd.update(f.keys())
        import numpy as np

        words = list(nd)
        freq = np.fromiter(nd.values(), dtype=float, count=len(words))
        idf = np.log(self.corpus_size - freq + 0.5) - np.log(freq + 0.5)
        self.average_idf = float(idf.sum()) / len(words) if words else 0.0
        idf[idf < 0] = self.epsilon * self.average_idf
        self.idf: dict[str, float] = dict(zip(words, idf.tolist()))

    def get_scores(self, query: list[str]):
        import numpy as np

        score = np.zeros(self.corpus_size)
        doc_len = np.array(self.doc_len)
        for q in query:
            q_freq = np.array([(doc.get(q) or 0) for doc in self.doc_freqs])
            score += (self.idf.get(q) or 0) * (q_freq * (self.k1 + 1) /
                                               (q_freq + self.k1 * (1 - self.b + self.b * doc_len / self.avgdl)))
        return score


class LexKorpus:
    """BM25 ueber eine feste Notizliste. `owners` ist der Space je Notiz
    (Dienst) oder leer (CLI). `counts` (Termhaeufigkeiten je Notiz, wie
    `index_counts`) darf vorab gebaut hereinkommen (der Dienst speichert sie
    je Space und HEAD zwischen).

    Mit derived-Abwertung rechnen Quellnotizen gegen einen Korpus OHNE die
    abgeleiteten Seiten: eine Themenseite wiederholt die Woerter ihrer
    Quellen und senkte sonst deren IDF (Entfernen war auf Dev 24.09. besser
    als nur Abwerten). Abgeleitete Seiten behalten ihren Score gegen den
    ganzen Korpus."""

    def __init__(self, notes: list, owners: list[str] | None = None,
                 counts: list | None = None, state: dict | None = None):
        self.notes = notes
        self.owners = owners or [""] * len(notes)
        freqs = counts if counts is not None else [index_counts(n.text) for n in notes]
        self.derived = [is_derived(n.fm) for n in notes]
        lens = [sum(f.values()) for f in freqs]
        state = state or {}
        self.bm25 = Okapi(freqs, lens, state.get("full")) if notes else None
        src = [i for i, d in enumerate(self.derived) if not d]
        self.src_bm25 = (Okapi([freqs[i] for i in src], [lens[i] for i in src], state.get("src"))
                         if src and any(self.derived) else None)
        self._title_stems: list[set[str]] | None = None
        self._stem_state = stem_enabled()
        self._pos = {(o, n.rel): i for i, (o, n) in enumerate(zip(self.owners, notes))}

    def state(self) -> dict:
        """IDF-Stand beider BM25-Teile, zum Zwischenspeichern (CLI)."""
        out = {}
        if self.bm25 is not None:
            out["full"] = (self.bm25.idf, self.bm25.average_idf)
        if self.src_bm25 is not None:
            out["src"] = (self.src_bm25.idf, self.src_bm25.average_idf)
        return out

    def title_stems(self) -> list[set[str]]:
        if self._title_stems is None:
            self._title_stems = [set(stem_tokens(n.title)) for n in self.notes]
        return self._title_stems

    def note_for(self, space: str, rel: str):
        i = self._pos.get((space, rel))
        return None if i is None else self.notes[i]

    def scores(self, query: str) -> list[float]:
        if self.bm25 is None:
            return []
        q = index_tokens(query)
        qs = set(stem_tokens(query))
        titles = self.title_stems()
        scores = title_boosted_scores(titles, qs, self.bm25.get_scores(q))
        if self.src_bm25 is not None and derived_factor() < 1.0:
            src_titles = [t for t, d in zip(titles, self.derived) if not d]
            src_scores = iter(title_boosted_scores(src_titles, qs, self.src_bm25.get_scores(q)))
            scores = [s if d else next(src_scores) for s, d in zip(scores, self.derived)]
        return scores

    def hits(self, query: str, k: int, snippets: bool = True) -> list[SearchHit]:
        """BM25-Liste: k Quelltreffer plus die abgeleiteten Seiten dazwischen,
        auf den Spitzentreffer normiert."""
        scores = self.scores(query)
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        hits = [SearchHit(rel=self.notes[i].rel, score=float(scores[i]),
                          title=self.notes[i].title, match="text",
                          space=self.owners[i], derived=self.derived[i])
                for i in order if scores[i] > 0]
        hits = pool_trim(hits, k)
        for i, h in enumerate(hits, 1):
            h.bm25_rang = i
        if snippets:
            for h in hits:
                fill_snippet(h, self.notes[self._pos[h.key]].text, query)
        hits = max_normalize(hits)
        for h in hits:
            h.bm25_norm = h.score
        return hits


def pool_trim(hits: list[SearchHit], k: int) -> list[SearchHit]:
    """Top k hits - with the derived demotion on, k SOURCE hits plus the
    derived pages ranked among them, so derived pages take no candidate slot
    from the source notes before fusion."""
    if derived_factor() >= 1.0:
        return hits[:k]
    out, src = [], 0
    for h in hits:
        if src >= k:
            break
        out.append(h)
        src += not h.derived
    return out


# ---------------------------------------------------------------------------
# Vektorliste, Fusion, Boni, Abwertungen

def unit(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(map(mul, vec, vec)))
    return [x / n for x in vec] if n else list(vec)


def semantic_ranking(query_vector: list[float], entries, k: int,
                     unit_entries: bool = False) -> list[SearchHit]:
    """Kosinus-Top-k ueber `entries` = (space, rel, vector). Mit derived-
    Abwertung werden DERIVED_POOL_EXTRA Kandidaten mehr gelesen; `pool_trim`
    kuerzt erst, wenn `derived` gesetzt ist (Aufrufer tragen es nach).
    `unit_entries`: die Notizvektoren sind schon auf Laenge 1 gebracht (der
    Dienst haelt sie so im Speicher); dann reicht ein Skalarprodukt je Notiz.
    Gemittelte Abschnittsvektoren (Gaertner) haben Laenge < 1, deshalb nie
    ein nacktes Skalarprodukt auf rohe Vektoren."""
    extra = DERIVED_POOL_EXTRA if derived_factor() < 1.0 else 0
    if unit_entries:
        q = unit(query_vector)
        scored = [SearchHit(rel=rel, score=sum(map(mul, q, vec)), space=space,
                            match="semantic")
                  for space, rel, vec in entries]
    else:
        scored = [SearchHit(rel=rel, score=cosine(query_vector, vec), space=space,
                            match="semantic")
                  for space, rel, vec in entries]
    scored.sort(key=lambda h: h.score, reverse=True)
    scored = scored[:k + extra]
    for h in scored:
        h.cosine = h.score  # score gets rescaled downstream (RRF/normalize); cosine stays raw
    for i, h in enumerate(scored, 1):
        h.vektor_rang = i
    return scored


def rrf_fuse(rankings: list[tuple[str, list[SearchHit]]], k: int,
             rrf_k: int = RRF_K) -> list[SearchHit]:
    """Reciprocal Rank Fusion: combine several ranked hit lists (each tagged
    with a source label, e.g. "semantic"/"text") into one ranking. A note that
    scores well in *both* rankers - a hybrid match - naturally floats up
    without any hand-tuned weight between BM25 and cosine scores, which live
    on incomparable scales."""
    rrf_scores: dict[tuple[str, str], float] = {}
    best_hit: dict[tuple[str, str], SearchHit] = {}
    sources: dict[tuple[str, str], set[str]] = {}
    cosines: dict[tuple[str, str], float] = {}
    derived: set[tuple[str, str]] = set()
    bm25_signals: dict[tuple[str, str], tuple[int, float]] = {}
    vector_ranks: dict[tuple[str, str], int] = {}
    # With the derived demotion on, a derived page does not take a rank slot
    # from the source notes in either list: a topic page at semantic rank 1
    # would otherwise push every source note one RRF step down, which the
    # post-fusion factor alone cannot undo (dev half 24.09.: 1 better / 0
    # worse against 7 / 3 for removal). The page itself keeps its own rank.
    skip_derived = derived_factor() < 1.0
    for label, hits in rankings:
        j = 0
        for i, h in enumerate(hits):
            pos = i if (h.derived and skip_derived) else j
            if not (h.derived and skip_derived):
                j += 1
            key = h.key
            rrf_scores[key] = rrf_scores.get(key, 0.0) + 1.0 / (rrf_k + pos + 1)
            sources.setdefault(key, set()).add(label)
            cosines[key] = max(cosines.get(key, 0.0), h.cosine)
            if label == "text":
                bm25_signals[key] = (h.bm25_rang or i + 1, h.bm25_norm)
            elif label == "semantic":
                vector_ranks[key] = h.vektor_rang or i + 1
            if h.derived:
                derived.add(key)
            if key not in best_hit or (h.title and not best_hit[key].title):
                best_hit[key] = h

    fused = []
    for key, score in rrf_scores.items():
        h = best_hit[key]
        labels = sources[key]
        match = "hybrid" if len(labels) > 1 else next(iter(labels))
        fused.append(SearchHit(rel=h.rel, score=score, title=h.title, snippet=h.snippet,
                               match=match, cosine=cosines[key], space=h.space,
                               derived=key in derived, lines=h.lines,
                               bm25_rang=bm25_signals.get(key, (0, 0.0))[0],
                               bm25_norm=bm25_signals.get(key, (0, 0.0))[1],
                               vektor_rang=vector_ranks.get(key, 0)))
    fused.sort(key=lambda h: h.score, reverse=True)
    return max_normalize(fused[:k])


def is_navigational(query: str) -> bool:
    q = query.lower()
    return any(t in q for t in NAV_TRIGGERS)


def apply_nav_boost(hits: list[SearchHit], query: str) -> list[SearchHit]:
    """Fixed post-fusion bonus for MOC.md/STATUS.md hits, only on
    navigational-looking queries ("Themen-Hub fuer X", "Stand von Y", ...).
    See the NAV_BOOST/TITLE_BOOST comment above for why RRF needs this."""
    if not is_navigational(query) or not hits:
        return hits
    for h in hits:
        if Path(h.rel).name in HUB_BASENAMES:
            h.score += NAV_BOOST
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits


def demote_derived(hits: list[SearchHit]) -> list[SearchHit]:
    """Multiply a derived page's score by `derived_factor()` and re-sort; see
    DERIVED_FACTOR. Rescaled so the top hit stays at 1.0 for the hook."""
    factor = derived_factor()
    if factor >= 1.0 or not any(h.derived for h in hits):
        return hits
    for h in hits:
        if h.derived:
            h.score *= factor
    hits.sort(key=lambda h: h.score, reverse=True)
    return max_normalize(hits)


def fuse_hybrid(semantic_hits: list[SearchHit], text_hits: list[SearchHit],
                query: str, k: int, date_of=None, rel_of=None) -> list[SearchHit]:
    """BM25 + Vektorliste (je mit `pool = max(k*4, 20)` Kandidaten) per RRF,
    dann Navigationsbonus und derived-Abwertung, dann der Standbonus (nur mit
    Stand-Absicht in der Anfrage), dann der Zeitbonus (nur mit `date_of` und
    Zeitsignal in der Anfrage), dann k. `rel_of(hit)` liefert den
    vault-relativen Pfad (Dienst: Space-Spiegel; Vorgabe `hit.rel`)."""
    fused = rrf_fuse([("semantic", semantic_hits), ("text", text_hits)], hybrid_pool(k))
    hits = demote_derived(apply_nav_boost(fused, query))
    hits = apply_stand_bonus(hits, query, rel_of)
    if date_of is not None:
        hits = apply_zeit_bonus(hits, query, date_of)
    return hits[:k]


def hybrid_pool(k: int) -> int:
    return max(k * 4, 20)  # wider candidate pool per ranker before fusion


# Zeitbezug (b6-zeit, 28.09., ana-retrieval Empfehlung 9). Fragen wie "Wie ist
# der aktuelle Stand bei X?" oder "Was ist derzeit noch offen?" wollen die
# juengste Notiz zum Thema, die Rangfolge kennt aber kein Datum. Nur wenn die
# Anfrage ein Zeitsignal traegt, bekommt die juengste Notiz aus dem Projekt
# bzw. Thema des Spitzentreffers, die schon unter den ersten ZEIT_TIEFE
# Kandidaten steht, einen festen Bonus auf den normierten Score. Nie ein
# genereller Abschlag fuer Sitzungsnotizen (zweimal verworfen), nie ein
# Bonus ohne Ausloeser, nie ein Kandidat von ausserhalb der Liste.
# Datum: juengstes aus Frontmatter (`created`, `decided`, `date`, `updated`,
# `stand` als Monatsmitte) und Dateiname, dazu der letzte Commit ohne
# Massencommits (Space-Umzug 24.09., Schema-Migration 28.09. beruehrten
# hunderte Notizen). Messung und Wahl der Werte: siehe
# `_meta/tools/eval/zeitbezug/BEFUNDE.md`. BRAIN_SEARCH_ZEIT=0 schaltet ab.
ZEIT_ENV = "BRAIN_SEARCH_ZEIT"
# BRAIN_SEARCH_ZEIT_PARAM="bonus,tiefe,ausloeser,quelle" setzt die Werte fuer Messlaeufe.
ZEIT_PARAM_ENV = "BRAIN_SEARCH_ZEIT_PARAM"
# Werte auf den Dev-Haelften von v1 und v2 gewaehlt (Raster Bonus 0,05-0,5 x Tiefe 5/10/20 x
# Quelle fm/git/max x Ausloeser eng/weit; Regel: bestes nDCG@10 auf der Zeit-Teilmenge beider
# Saetze ohne Verlust gesamt). Bonus 0,5 kippte auf v1 schon wieder ins Minus, 0,4 liegt nah daran.
ZEIT_DEFAULT = False  # 28.09.: Gewinn nur Punktwert, Verluste bei "noch"/"letzte"; einschalten mit BRAIN_SEARCH_ZEIT=1 nach neuem Messsatz
ZEIT_BONUS = 0.4
ZEIT_TIEFE = 20
ZEIT_AUSLOESER = "weit"     # eng | weit (weit: auch "noch", "stand", "gerade", "now", "still")
ZEIT_QUELLE = "git"         # fm | git | max
ZEIT_MASSENCOMMIT = 20      # Commits mit mehr geaenderten .md-Dateien zaehlen nicht als Datum
_ZEIT_ENG = (r"aktuell\w*|derzeit\w*|momentan\w*|im moment|zuletzt|letzte[nmrs]?|neueste[nmrs]?"
             r"|j(?:ü|ue)ngste[nmrs]?|inzwischen|mittlerweile|heute|jetzt|current\w*|latest"
             r"|recent\w*|as of|nowadays")
_ZEIT_WEIT = _ZEIT_ENG + r"|noch|stand|gerade|now|still"
ZEIT_RE = {"eng": re.compile(rf"\b(?:{_ZEIT_ENG})\b"),
           "weit": re.compile(rf"\b(?:{_ZEIT_WEIT})\b")}


def zeit_enabled() -> bool:
    raw = os.environ.get(ZEIT_ENV)
    if raw is None or not raw.strip():
        return ZEIT_DEFAULT
    return raw.strip().lower() not in _OFF


def zeit_params() -> tuple[float, int, str, str]:
    """(bonus, tiefe, ausloeser, quelle); BRAIN_SEARCH_ZEIT_PARAM ueberschreibt
    einzelne Stellen, unlesbare Stellen behalten die Vorgabe."""
    out = [ZEIT_BONUS, ZEIT_TIEFE, ZEIT_AUSLOESER, ZEIT_QUELLE]
    raw = os.environ.get(ZEIT_PARAM_ENV, "").strip()
    for i, part in enumerate(raw.split(",")[:4] if raw else []):
        part = part.strip()
        try:
            if i == 0:
                out[0] = max(0.0, float(part))
            elif i == 1:
                out[1] = max(1, int(part))
            elif i == 2 and part in ZEIT_RE:
                out[2] = part
            elif i == 3 and part in ("fm", "git", "max"):
                out[3] = part
        except ValueError:
            continue
    return out[0], out[1], out[2], out[3]


def has_zeit_signal(query: str, ausloeser: str | None = None) -> bool:
    return bool(ZEIT_RE[ausloeser or zeit_params()[2]].search(query.lower()))


def zeit_group(rel: str) -> str | None:
    """Projekt bzw. Thema einer Notiz: `20-projects/<p>`, `30-topics/<t>`,
    `10-global/<unterordner>`; lose Notizen in `10-global/` und Wurzeldateien
    haben kein Thema (dort gibt es keinen Zeitbonus)."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] in ("20-projects", "30-topics", "10-global"):
        return "/".join(parts[:2])
    return None


def apply_zeit_bonus(hits: list[SearchHit], query: str, date_of) -> list[SearchHit]:
    """Zeitbonus auf der fusionierten Liste (vor dem Kuerzen auf k). `date_of(hit)`
    liefert einen vergleichbaren Zeitwert (Epoche) oder None. Ohne Zeitsignal,
    ohne Thema des Spitzentreffers oder ohne datierten Kandidaten bleibt die
    Liste unveraendert. Bei gleichem Datum gewinnt der hoeher stehende Treffer.
    Abgeleitete Seiten nehmen nicht teil (ihr Datum ist der Erzeugungslauf)."""
    if not hits or not zeit_enabled():
        return hits
    bonus, tiefe, ausloeser, _quelle = zeit_params()
    if bonus <= 0 or not has_zeit_signal(query, ausloeser):
        return hits
    group = zeit_group(hits[0].rel)
    if group is None:
        return hits
    best, best_t = None, None
    for h in hits[:tiefe]:
        if h.derived or zeit_group(h.rel) != group:
            continue
        t = date_of(h)
        if t is not None and (best_t is None or t > best_t):
            best, best_t = h, t
    if best is None:
        return hits
    best.score += bonus
    hits.sort(key=lambda h: h.score, reverse=True)
    return max_normalize(hits)


_ISO_DAY = re.compile(r"(20\d\d-\d\d-\d\d)")
_ISO_MONTH = re.compile(r"(20\d\d-\d\d)$")


def frontmatter_day(fm: dict | None, name: str = "") -> str:
    """Juengster Tag (ISO) aus `created`, `decided`, `date`, `updated`, `stand`
    (JJJJ-MM als Monatsmitte) und dem Dateinamen; "" ohne Datum."""
    days: list[str] = []
    for key in ("created", "decided", "date", "updated"):
        m = _ISO_DAY.search(str((fm or {}).get(key) or ""))
        if m:
            days.append(m.group(1))
    stand = str((fm or {}).get("stand") or "").strip()
    m = _ISO_DAY.match(stand)
    if m:
        days.append(m.group(1))
    elif _ISO_MONTH.match(stand):
        days.append(stand + "-15")
    m = _ISO_DAY.search(name)
    if m:
        days.append(m.group(1))
    return max(days) if days else ""


def parse_git_dates(log: str, massencommit: int = ZEIT_MASSENCOMMIT) -> dict[str, int]:
    """Letzter Commit je .md-Datei aus `git log --format=@%ct --name-only`
    (neueste zuerst); Commits mit mehr als `massencommit` .md-Dateien zaehlen
    nicht (Migrationen, Umzuege)."""
    out: dict[str, int] = {}
    t: int | None = None
    files: list[str] = []

    def flush():
        md = [f for f in files if f.endswith(".md")]
        if t is not None and len(md) <= massencommit:
            for f in md:
                out.setdefault(f, t)

    for line in log.splitlines():
        if line.startswith("@"):
            flush()
            files = []
            try:
                t = int(line[1:])
            except ValueError:
                t = None
            continue
        if line.strip():
            files.append(line.strip())
    flush()
    return out


def lexical_only(korpus: LexKorpus, query: str, k: int, rel_of=None) -> list[SearchHit]:
    """Der Weg ohne Vektoren (Ollama aus, Dienst ohne Index): BM25 mit
    derived-Abwertung und Standbonus, ohne Fusion und ohne Navigationsbonus."""
    return apply_stand_bonus(demote_derived(korpus.hits(query, max(k * 4, 20))), query, rel_of)[:k]


# Stand-Absicht (b7-stand, 29.09.). Fragen wie "Wie weit ist X?", "Ist Y
# inzwischen gebaut?" oder "Was ist beim Z derzeit noch offen?" beantwortet
# meist die Standseite des Projekts (KERN.md, STATUS.md, overview.md,
# <projekt>-overview.md, *-STATE.md im Projektordner). Diagnose auf den
# Dev-Haelften v2/v3: bei 10 von 15 Stand-Fragen, die hit@1 verfehlten, war die
# beste Grad-2-Notiz eine solche Seite; sie stand im Median auf BM25-Rang 4,
# nach der Fusion aber hinter Sitzungs- und Analysenotizen desselben Projekts
# (lange Seiten mit vielen Themen haben schwache Vektorraenge).
# Nur mit Stand-Signal in der Anfrage bekommen die Standseiten des Projekts,
# das unter den ersten STAND_TIEFE Treffern die meiste Scoresumme hat, einen
# festen Bonus auf den normierten Score. Nur Kandidaten, die schon in der
# fusionierten Liste stehen; nie ein Abschlag fuer andere Notizen.
# Werte auf den Dev-Haelften v1/v2/v3 gewaehlt (Raster Bonus 0,05-1,0 x Tiefe 5/10 x
# Ausloeser eng/weit x Modus alle/beste/gestuft; Regel: bestes nDCG@10 der Stand-Fragen
# ohne Verlust gesamt, bei Gleichstand der kleinere Bonus). Gestuft: KERN.md und
# *-STATE.md voll, STATUS.md und overview.md halb (sie tragen oft aeltere Staende).
# Messung: `_meta/tools/eval/stand/BEFUNDE.md`. BRAIN_SEARCH_STAND=1 schaltet ein.
STAND_ENV = "BRAIN_SEARCH_STAND"
# BRAIN_SEARCH_STAND_PARAM="bonus,tiefe,ausloeser,modus,position" setzt die Werte fuer Messlaeufe.
STAND_PARAM_ENV = "BRAIN_SEARCH_STAND_PARAM"
STAND_DEFAULT = False  # bis zur gepaarten Messung auf v3-Test aus
STAND_BONUS = 0.8
STAND_TIEFE = 10
STAND_AUSLOESER = "eng"     # eng | weit
STAND_MODUS = "gestuft"     # alle: jede Standseite; beste: nur die hoechste; gestuft: STATUS/overview halb
# Nach dem Umsortierer (Passagen-Reranker, Standard in `brain search` seit 29.09.): er ordnet die
# ersten 20 allein nach Passagenscore und machte den Bonus wirkungslos (Dev: Stand hit@1 0,08
# mit und ohne Bonus). Deshalb rueckt `apply_stand_rang` danach die vollen Standseiten (KERN.md,
# *-STATE.md; im Modus alle jede Standseite) des Projekts auf diesen Platz; 0 = aus.
STAND_POSITION = 1
_STAND_ENG = (r"stand|wie weit|inzwischen|mittlerweile|derzeit|momentan|im moment|aktuell\w*"
              r"|noch offen|bis heute|neuigkeit\w*|(?<!-)status|fortschritt|current\w*"
              r"|progress|so far|latest|up to date")
_STAND_WEIT = _STAND_ENG + r"|gerade|bisher|zuletzt|letzte[nmrs]?|noch|offen|herausgekommen|ausgegangen|fehlt|yet|still|now"
STAND_RE = {"eng": re.compile(rf"\b(?:{_STAND_ENG})\b"),
            "weit": re.compile(rf"\b(?:{_STAND_WEIT})\b")}
STAND_SEITEN = ("KERN.md", "STATUS.md", "overview.md")
_STAND_SEITE_RE = re.compile(r"^(?:[\w.-]+-overview|[\w.-]+-STATE)\.md$")


# Die LLM-Listensortierung (llm_sort, b10) wurde samt Stand-Weiche gemessen: ist sie aktiv, gilt die Weiche
# auch ohne BRAIN_SEARCH_STAND (Suche setzt STAND_MIT_LLM je Aufruf); BRAIN_SEARCH_STAND=0 schaltet trotzdem ab.
STAND_MIT_LLM: ContextVar[bool] = ContextVar("stand_mit_llm", default=False)


def stand_enabled() -> bool:
    raw = os.environ.get(STAND_ENV)
    if raw is None or not raw.strip():
        return STAND_DEFAULT or STAND_MIT_LLM.get()
    return raw.strip().lower() not in _OFF


def stand_params() -> tuple[float, int, str, str, int]:
    """(bonus, tiefe, ausloeser, modus, position); BRAIN_SEARCH_STAND_PARAM
    ueberschreibt einzelne Stellen, unlesbare Stellen behalten die Vorgabe."""
    out = [STAND_BONUS, STAND_TIEFE, STAND_AUSLOESER, STAND_MODUS, STAND_POSITION]
    raw = os.environ.get(STAND_PARAM_ENV, "").strip()
    for i, part in enumerate(raw.split(",")[:5] if raw else []):
        part = part.strip()
        try:
            if i == 0:
                out[0] = max(0.0, float(part))
            elif i == 1:
                out[1] = max(1, int(part))
            elif i == 2 and part in STAND_RE:
                out[2] = part
            elif i == 3 and part in ("alle", "beste", "gestuft"):
                out[3] = part
            elif i == 4:
                out[4] = max(0, int(part))
        except ValueError:
            continue
    return out[0], out[1], out[2], out[3], out[4]


def has_stand_signal(query: str, ausloeser: str | None = None) -> bool:
    return bool(STAND_RE[ausloeser or stand_params()[2]].search(query.lower()))


def stand_project(rel: str) -> str | None:
    """`20-projects/<p>` einer Notiz, sonst None (nur Projekte haben Standseiten)."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "20-projects":
        return "/".join(parts[:2])
    return None


def is_stand_page(rel: str) -> bool:
    """Standseite: KERN.md, STATUS.md, overview.md, <x>-overview.md oder
    <x>-STATE.md direkt im Projektordner `20-projects/<p>/`."""
    parts = rel.split("/")
    if len(parts) != 3 or parts[0] != "20-projects":
        return False
    return parts[2] in STAND_SEITEN or bool(_STAND_SEITE_RE.match(parts[2]))


def apply_stand_bonus(hits: list[SearchHit], query: str, rel_of=None) -> list[SearchHit]:
    """Standbonus auf der fusionierten Liste (vor dem Kuerzen auf k). Ohne
    Stand-Signal, ohne Projekt unter den ersten Treffern oder ohne Standseite
    dieses Projekts in der Liste bleibt sie unveraendert. Abgeleitete Seiten
    stimmen nicht mit ab und bekommen keinen Bonus."""
    if not hits or not stand_enabled():
        return hits
    bonus, tiefe, ausloeser, modus, _position = stand_params()
    if bonus <= 0 or not has_stand_signal(query, ausloeser):
        return hits
    rel_of = rel_of or (lambda h: h.rel)
    project = _stand_vote(hits[:tiefe], rel_of)
    if project is None:
        return hits
    changed = False
    for h in hits:
        rel = rel_of(h)
        if h.derived or not rel or stand_project(rel) != project or not is_stand_page(rel):
            continue
        halb = modus == "gestuft" and is_half_stand_page(rel)
        h.score += bonus / 2 if halb else bonus
        changed = True
        if modus == "beste":
            break
    if not changed:
        return hits
    hits.sort(key=lambda h: h.score, reverse=True)
    return max_normalize(hits)


def is_half_stand_page(rel: str) -> bool:
    """STATUS.md und overview.md/<x>-overview.md: im Modus gestuft halber Bonus,
    nach dem Umsortierer keine Hebung (sie tragen oft aeltere Staende)."""
    name = rel.rsplit("/", 1)[-1]
    return name in ("STATUS.md", "overview.md") or name.endswith("-overview.md")


def _stand_vote(hits: list[SearchHit], rel_of) -> str | None:
    """Projekt mit der groessten Scoresumme unter `hits` (ohne abgeleitete
    Seiten); bei Gleichstand das zuerst genannte."""
    votes: dict[str, float] = {}
    for h in hits:
        if h.derived:
            continue
        rel = rel_of(h)
        p = stand_project(rel) if rel else None
        if p is not None:
            votes[p] = votes.get(p, 0.0) + h.score
    if not votes:
        return None
    top = max(votes.values())
    return next(p for p, v in votes.items() if v == top)


def apply_stand_rang(hits: list, query: str, rel_of=None, top_n: int = 20) -> list:
    """Nach dem Umsortierer: die vollen Standseiten (KERN.md, *-STATE.md; im
    Modus alle jede Standseite) des Projekts ruecken innerhalb der ersten
    `top_n` auf Platz STAND_POSITION, untereinander in der Reihenfolge des
    Umsortierers. Das Projekt waehlen die Rangkern-Scores (`hit.score`) der
    STAND_TIEFE bestbewerteten Treffer, wie beim Bonus. Ohne Schalter, ohne
    Stand-Signal oder ohne passende Seite bleibt die Liste, wie sie ist."""
    if not hits or not stand_enabled():
        return list(hits)
    _bonus, tiefe, ausloeser, modus, position = stand_params()
    if position <= 0 or not has_stand_signal(query, ausloeser):
        return list(hits)
    rel_of = rel_of or (lambda h: h.rel)
    project = _stand_vote(sorted(hits, key=lambda h: h.score, reverse=True)[:tiefe], rel_of)
    if project is None:
        return list(hits)
    head, tail = list(hits[:top_n]), list(hits[top_n:])

    def lifted(h) -> bool:
        rel = rel_of(h)
        if h.derived or not rel or stand_project(rel) != project or not is_stand_page(rel):
            return False
        # Abgewertete Standseiten (status archived/superseded/expired, z. B. BUILD-STATE.md) heben wir nicht:
        # die Weiche laeuft seit der LLM-Stufe mit und stand NACH der Gueltig-Ordnung (09.10.).
        if (getattr(h, "status", "") or "") in STATUS_DEMOTED:
            return False
        return modus == "alle" or not is_half_stand_page(rel)
    pages = [h for h in head if lifted(h)]
    if modus == "beste":
        pages = pages[:1]
    for i, h in enumerate(pages):
        cur = head.index(h)
        target = position - 1 + i
        if cur > target:
            head.pop(cur)
            head.insert(target, h)
    return head + tail


# Gueltigkeit aus dem Frontmatter (seit 2026-09-28, b6-gueltigkeit). claims.db
# steht seit 17.08. still (0 von 34.300 Aussagen abgeloest), die Abwertung ueber
# sie griff also nie. Notizen tragen jetzt selbst `status: active|superseded|
# archived`, `superseded-by: [[x]]` und optional `valid-until: JJJJ-MM[-TT]`.
# Traegt eine Notiz eines dieser Felder, gewinnt das Frontmatter; claims.db
# zaehlt nur noch fuer Notizen ohne sie. Abgeloest, archiviert oder abgelaufen
# heisst volle Abwertung (VALIDITY_DEMOTION wie eine ganz abgeloeste Notiz),
# nie Ausblenden. Messung: _meta/tools/eval/gueltigkeit/BEFUNDE.md.
VALIDITY_ENV = "BRAIN_VALIDITY"
# Nachfolger einreihen: die Abloesungsnotiz bekommt den Score, den der abgeloeste
# Treffer vor der Abwertung hatte (fehlt sie, kommt sie hinzu; steht sie tiefer,
# wird sie angehoben). Sie steht damit auf dem alten Rang, die alte Notiz darunter.
SUCCESSOR_ENV = "BRAIN_VALIDITY_NACHFOLGER"
SUCCESSOR_DEFAULT = True
SUCCESSOR_MAX_DEPTH = 4   # Ketten wie Login -> API-Schluessel -> Abo-Bruecke
STATUS_DEMOTED = ("superseded", "archived", "expired")
_OFF = ("0", "off", "false", "no", "nein")
_WIKILINK_TARGET = re.compile(r"\[\[([^\]|#\n]+)")


def validity_enabled(explicit: bool | None = None) -> bool:
    """`explicit` (CLI-Schalter) gewinnt, sonst schaltet BRAIN_VALIDITY=0 die
    ganze Gueltigkeit ab (Frontmatter, claims.db, Nachfolger)."""
    if explicit is not None:
        return explicit
    raw = os.environ.get(VALIDITY_ENV)
    return raw is None or raw.strip().lower() not in _OFF


def successor_enabled() -> bool:
    raw = os.environ.get(SUCCESSOR_ENV)
    if raw is None:
        return SUCCESSOR_DEFAULT
    return raw.strip().lower() not in _OFF


def link_targets(value) -> list[str]:
    """`superseded-by` als Liste von Linkzielen: `["[[x]]"]`, `"[[x]]"` oder
    `x` (ohne Klammern) ergeben `["x"]`."""
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    out: list[str] = []
    for item in items:
        text = str(item).strip()
        found = _WIKILINK_TARGET.findall(text)
        for t in found or ([text] if text else []):
            t = t.strip()
            if t and t not in out:
                out.append(t)
    return out


def _today() -> str:
    import datetime as _dt
    return _dt.date.today().isoformat()


def frontmatter_validity(fm: dict | None, today: str | None = None
                         ) -> tuple[str, list[str], str] | None:
    """(status, superseded-by-Ziele, valid-until) aus dem Frontmatter, oder None,
    wenn die Notiz keines der Felder traegt (dann darf claims.db sprechen).

    status: `superseded` (auch ohne Statusfeld, wenn `superseded-by` gesetzt
    ist), `archived`, `expired` (valid-until vorbei, verglichen in dessen
    Genauigkeit: `2026-09` ist erst ab Oktober abgelaufen) oder `active`."""
    if not fm:
        return None
    raw_status = fm.get("status")
    targets = link_targets(fm.get("superseded-by"))
    until = str(fm.get("valid-until") or "").strip()
    if raw_status is None and not targets and not until:
        return None
    status = str(raw_status or "").strip().lower() or "active"
    if status not in ("superseded", "archived"):
        if targets:
            status = "superseded"
        elif until and re.fullmatch(r"\d{4}(-\d{2}){0,2}", until) \
                and (today or _today())[:len(until)] > until:
            status = "expired"
    return status, targets, until


def apply_validity(hits: list[SearchHit], known: dict,
                   key=lambda h: h.rel, note_of=None, resolve=None,
                   successors: bool | None = None,
                   today: str | None = None) -> list[SearchHit]:
    """Gueltigkeit auf der Endliste: markieren, abwerten, neu sortieren.

    `known` ist die claims.db-Karte `key(hit)` -> (retired, total, valid_to).
    `note_of(hit)` liefert die Notiz (mit `.fm`) oder None; wer es weglaesst,
    bekommt nur den claims.db-Weg. Frontmatter gewinnt: eine Notiz mit
    `status`/`superseded-by`/`valid-until` wird nur danach beurteilt.
    `resolve(ziel, hit)` bildet ein `superseded-by`-Ziel auf `(space, rel,
    note)` ab; mit ihm reiht `successors` (Vorgabe: BRAIN_VALIDITY_NACHFOLGER)
    einen fehlenden Nachfolger mit dem Score vor der Abwertung ein und hebt
    einen vorhandenen, tiefer stehenden Nachfolger auf diesen Score.

    Kein Treffer wird entfernt; eine gueltige Notiz behaelt ihren Score bis
    auf die letzte Stelle, ausser sie ist Nachfolger eines abgeloesten
    Treffers. Die Liste kann durch Nachfolger laenger werden, der
    Aufrufer kuerzt danach auf k."""
    if successors is None:
        successors = successor_enabled()
    changed = False
    pending: list[tuple[SearchHit, float]] = []
    for h in hits:
        note = note_of(h) if note_of is not None else None
        fmv = frontmatter_validity(note.fm, today) if note is not None else None
        if fmv is not None:
            status, targets, _until = fmv
            if status not in STATUS_DEMOTED:
                continue
            before = h.score
            h.status = status
            h.superseded_by = targets
            h.score *= 1.0 - VALIDITY_DEMOTION
            changed = True
            if targets:
                pending.append((h, before))
            continue
        retired, total, since = known.get(key(h), (0, 0, "")) if known else (0, 0, "")
        if not retired or not total:
            continue
        h.retired = True
        h.retired_claims = retired
        h.total_claims = total
        h.retired_since = since
        h.score *= 1.0 - VALIDITY_DEMOTION * (retired / total)
        changed = True
    if pending and resolve is not None:
        present = {h.key: h for h in hits}
        for old, before in pending:
            for target in old.superseded_by:
                found = _final_successor(target, old, resolve, note_of, today)
                if found is None:
                    continue
                space, rel, note = found
                old.superseded_by_rel.append(rel)
                if not successors:
                    continue
                there = present.get((space, rel))
                if there is not None:
                    # vorhandener Nachfolger unter dem alten Rang: er erbt ihn
                    if there.score < before and not there.status:
                        there.score = before
                        changed = True
                    continue
                hits.append(SearchHit(rel=rel, score=before,
                                      title=getattr(note, "title", "") or "",
                                      match="nachfolger", space=space,
                                      derived=is_derived(getattr(note, "fm", {}) or {})))
                present[(space, rel)] = hits[-1]
                changed = True
    if changed:
        hits.sort(key=lambda h: h.score, reverse=True)
    return hits


def _final_successor(target: str, hit: SearchHit, resolve, note_of, today):
    """Folgt `superseded-by` bis zur ersten nicht abgeloesten Notiz (hoechstens
    SUCCESSOR_MAX_DEPTH Schritte, Zyklen brechen ab). None, wenn das Ziel sich
    nicht aufloesen laesst."""
    seen: set[tuple[str, str]] = set()
    found = resolve(target, hit)
    for _ in range(SUCCESSOR_MAX_DEPTH):
        if found is None:
            return None
        space, rel, note = found
        if (space, rel) in seen:
            return found
        seen.add((space, rel))
        fmv = frontmatter_validity(getattr(note, "fm", None), today)
        if fmv is None or fmv[0] != "superseded" or not fmv[1]:
            return found
        nxt = resolve(fmv[1][0], SearchHit(rel=rel, score=0.0, space=space))
        if nxt is None:
            return found
        found = nxt
    return found


CLAIM_SOURCE_PREFIX = "vault:"   # the only source kind that names a vault note


def load_retired_notes_from(path: Path) -> dict[str, tuple[int, int, str]]:
    """Per vault note: (retired claims, claims in total, newest valid_to), read
    from the dream's claim store at `path`.

    Only claims whose `source` names a vault note (`vault:<rel>#<segment>`)
    can say anything about a note; a retired claim drawn from a transcript,
    a worker result or project documentation has no note to mark and is
    ignored here. A note the dream never drew a claim from - the normal case
    by a wide margin - simply does not appear in the map and stays untouched.

    Best-effort: a missing, unreadable or pre-migration claims.db means
    "nothing is known to be retired". Search must not fail because a vault
    has never run the dream.
    """
    if not path.exists():
        return {}
    try:
        from gardener.dream.claims import ClaimStore
        store = ClaimStore(path, read_only=True)
    except Exception:
        return {}
    try:
        rows = store.list_claims()
    except Exception:
        return {}
    finally:
        store.close()

    out: dict[str, tuple[int, int, str]] = {}
    for row in rows:
        source = row.get("source") or ""
        if not source.startswith(CLAIM_SOURCE_PREFIX):
            continue
        rel = source[len(CLAIM_SOURCE_PREFIX):].rsplit("#", 1)[0]
        if not rel:
            continue
        retired, total, since = out.get(rel, (0, 0, ""))
        valid_to = row.get("valid_to")
        if valid_to:
            retired += 1
            since = max(since, str(valid_to))
        out[rel] = (retired, total + 1, since)
    return out
