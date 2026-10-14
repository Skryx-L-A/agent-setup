"""Hybrid search over the vault: BM25 (lexical) + Gardener embeddings
(semantic), fused with Reciprocal Rank Fusion. Falls back to BM25-only
when Ollama is unreachable.

The ranking itself (tokenizer, BM25 with title bonus and derived handling,
RRF, nav bonus, derived and validity demotion, snippet with line range) lives
in `braincli.rangkern`, shared with the Brain-Dienst on peer; this module is
the Mac corpus side (vault walk, gardener index, claims.db, spaces) and keeps
the names callers and measurement scripts import from here."""
from __future__ import annotations

import json
import marshal
import os
import subprocess
from pathlib import Path

from gardener import config, spaces
from gardener.ollama import OllamaClient, OllamaError
from gardener.store import Store
from gardener.vault import parse_note

from . import einbettung, rangkern
from .rangkern import (  # noqa: F401  (re-exported: callers import these from here)
    CLAIM_SOURCE_PREFIX, DERIVED_FACTOR, DERIVED_FACTOR_ENV, DERIVED_POOL_EXTRA,
    HUB_BASENAMES, MAX_SNIPPET_CHARS, MAX_SNIPPET_SENTENCES, NAV_BOOST, NAV_TRIGGERS,
    RRF_K, SENTENCE_RE, SESSION_HOOK_RE_PREFIXES, STOPWORDS, TITLE_BOOST, TOKEN_RE,
    VALIDITY_DEMOTION, SearchHit, _clip, best_snippet, best_snippet_span, cosine,
    derived_factor, hook_snippet, index_tokens, is_derived, rrf_fuse, stem_tokens,
    tokenize,
)
from .vault import load_search_notes

VALIDITY_ENV = rangkern.VALIDITY_ENV

_body_blocks = rangkern.body_blocks
_max_normalize = rangkern.max_normalize
_pool_trim = rangkern.pool_trim
_is_navigational = rangkern.is_navigational
_apply_nav_boost = rangkern.apply_nav_boost
_demote_derived = rangkern.demote_derived


def hit_to_json(h: SearchHit) -> dict:
    """`SearchHit` as a dict for `--json`, with the always-false/always-zero
    optional fields (contradiction/retired/retired_claims/total_claims/
    retired_since) left out when they carry their default -- the common
    case, since most hits carry no contradiction and no retired claim. Every
    reader already treats these as optional (`h.get('retired', False)` etc.
    in auto-recall-format.py and the eval harnesses), so omitting a false/0/""
    default changes no behavior, only the token count: measured on
    queries-recall.yaml (60 queries, k=5), median `brain search --json`
    payload 714 tokens -> ~440 (suchqualitaet task, 2026-09-23; see
    _meta/tools/eval/results/suchqualitaet-token-efficiency.md).

    `lines` (since 2026-09-28): `[first, last]`, the 1-based file lines of the
    block the snippet was taken from (the snippet may show only its first
    sentences), so an agent can cite `rel:first` without rereading the note.
    Left out when the hit has no snippet from the note text (rg fallback)."""
    out = {"rel": h.rel, "score": h.score}
    if h.title:
        out["title"] = h.title
    if h.snippet:
        out["snippet"] = h.snippet
    if h.lines:
        out["lines"] = [h.lines[0], h.lines[1]]
    if h.match:
        out["match"] = h.match
    if h.cosine:
        out["cosine"] = h.cosine
    if h.bm25_rang:
        out["bm25_rang"] = h.bm25_rang
        out["bm25_norm"] = h.bm25_norm
    if h.vektor_rang:
        out["vektor_rang"] = h.vektor_rang
    if h.space and h.space != "kern":
        out["space"] = h.space
    if h.derived:
        out["derived"] = True
    if h.contradiction:
        out["contradiction"] = True
    if h.status:
        out["status"] = h.status
        if h.superseded_by:
            out["abgeloest_durch"] = list(h.superseded_by_rel or h.superseded_by)
    if h.retired:
        out["retired"] = True
        out["retired_claims"] = h.retired_claims
        out["total_claims"] = h.total_claims
        if h.retired_since:
            out["retired_since"] = h.retired_since
    return out


def rank(query_vector: list[float], entries: list[tuple[str, list[float]]],
         k: int) -> list[SearchHit]:
    """Pure ranking: cosine-similarity top-k over (rel, vector) entries."""
    scored = [SearchHit(rel=rel, score=cosine(query_vector, vec))
              for rel, vec in entries]
    scored.sort(key=lambda h: h.score, reverse=True)
    return scored[:k]


def load_all_embeddings(store: Store) -> list[tuple[str, list[float]]]:
    rows = store.conn.execute("SELECT rel, vector FROM embeddings").fetchall()
    return [(rel, json.loads(vec)) for rel, vec in rows]


def load_merged_embeddings(store: Store, vault: Path | None = None
                           ) -> list[tuple[str, list[float]]]:
    """Gardener's own embeddings, topped up with braincli's supplementary
    MOC.md cache (see extra_embed.py) so project MOC.md notes -- which
    gardener never embeds -- get a semantic signal too. On a rel present in
    both (the 4 30-topics hubs gardener embeds for its own hub-membership
    logic), the supplementary store wins: it is guaranteed freshly recomputed
    against the current file content, gardener's may be stale."""
    from .extra_embed import EXTRA_DB_PATH, extra_db_path

    extra_db = EXTRA_DB_PATH if vault is None else extra_db_path(vault)
    merged: dict[str, list[float]] = dict(load_all_embeddings(store))
    if extra_db.exists():
        extra_store = Store(extra_db, read_only=True)
        try:
            merged.update(dict(load_all_embeddings(extra_store)))
        finally:
            extra_store.close()
    return list(merged.items())


def _title_boosted_scores(notes: list, query_tokens: set[str], scores) -> list[float]:
    """Compatibility wrapper for measurement scripts: TITLE_BOOST per
    query/title STEM overlap (`query_tokens` is stemmed here, so raw words or
    stems both work)."""
    qs = set(stem_tokens(" ".join(query_tokens)))
    return rangkern.title_boosted_scores([set(stem_tokens(n.title)) for n in notes], qs, scores)


_stem_cache_loaded: set[str] = set()


def _stem_cache(vault: Path) -> Path | None:
    """The stems of the vault's words are kept in `state/search-stems.json`
    between processes (rangkern); loaded once per process, before the first
    stemmed token (snippets of semantic hits come before BM25)."""
    cache = rangkern.stem_cache_path(vault)
    if cache is not None and str(cache) not in _stem_cache_loaded:
        rangkern.load_stem_cache(cache)
        _stem_cache_loaded.add(str(cache))
    return cache


LEX_CACHE_NAME = "search-lex.marshal"
LEX_CACHE_VERSION = 1


def _load_lex_cache(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        data = marshal.loads(path.read_bytes())
    except (OSError, ValueError, EOFError, TypeError):
        return {}
    ok = (isinstance(data, dict) and data.get("v") == LEX_CACHE_VERSION
          and data.get("form") == rangkern.token_form())
    return data if ok else {}


def _save_lex_cache(path: Path | None, data: dict) -> None:
    if path is None or not path.parent.is_dir():
        return
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(marshal.dumps(data))
        os.replace(tmp, path)
    except (OSError, ValueError):
        try:
            tmp.unlink()
        except OSError:
            pass


def _lex_korpus(vault: Path) -> rangkern.LexKorpus:
    """BM25 corpus of the whole vault, rebuilt from the files at every query
    (no index to go stale). What is expensive with the stemmed tokens -
    counting the stems and n-grams of every note (0.5 s at the Mac) and the
    IDF tables (0.25 s) - is kept next to the stem cache in
    `state/search-lex.marshal`, per note keyed by (mtime_ns, size); a note
    whose file changed is counted afresh, and any change recomputes the IDF.
    The cache is a copy of what the files say, never a source: deleting it
    only costs time."""
    cache = _stem_cache(vault)
    lex_path = cache.with_name(LEX_CACHE_NAME) if cache is not None else None
    notes = load_search_notes(vault)
    LAST_NOTES[:] = notes  # dieselbe Liste prueft danach index_health (ein Parse statt zwei)
    data = _load_lex_cache(lex_path)
    old = data.get("notes", {})
    entries: dict[str, list] = {}
    counts = []
    changed = len(old) != len(notes)
    for n in notes:
        try:
            st = n.path.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = (-1, -1)
        e = old.get(n.rel)
        if e is not None and e[0] == key[0] and e[1] == key[1]:
            c = e[2]
        else:
            c = dict(rangkern.index_counts(n.text))
            changed = True
        entries[n.rel] = [key[0], key[1], c]
        counts.append(c)
    state = None if changed else data.get("state")
    korpus = rangkern.LexKorpus(notes, counts=counts, state=state)
    rangkern.save_stem_cache(cache)
    if changed or state is None:
        _save_lex_cache(lex_path, {"v": LEX_CACHE_VERSION, "form": rangkern.token_form(),
                                   "notes": entries, "state": korpus.state()})
    return korpus


def bm25_rank(vault: Path, query: str, k: int, snippets: bool = True,
              korpus: rangkern.LexKorpus | None = None) -> list[SearchHit]:
    """Lexical top-k over the whole corpus (stemmed tokens plus n-grams of
    long stems, see rangkern). Title/query stem overlap gets a fixed bonus on
    top of the raw BM25 score (TITLE_BOOST)."""
    return (korpus or _lex_korpus(vault)).hits(query, k, snippets=snippets)


# Der BM25-Korpus der laufenden `search()`-Anfrage, damit der Rueckweg ohne
# Ollama ihn nicht ein zweites Mal baut.
_THIS_CALL: dict = {}


def _keep_alive() -> str:
    # keep_alive: bis 2026-09-23 stand hier "0s" (nichts auf der Karte lassen). Gemessen am
    # 23.09.: jede Abfrage lud das Modell dann neu, 1,85 s statt 0,2 s, und der Auto-Recall-Hook
    # (1,5 s Frist) blieb seit dem 17.08. bei JEDER Eingabe stumm. Das Modell belegt 641 MiB;
    # BRAIN_SEARCH_KEEP_ALIVE ueberschreibt die Vorgabe (z.B. "0s" fuer eine Belegungsmessung).
    return os.environ.get("BRAIN_SEARCH_KEEP_ALIVE", config.SEARCH_KEEP_ALIVE)


def _semantic_entries(vault: Path, query: str, modell: einbettung.Modell
                      ) -> tuple[list[float], list[tuple[str, list[float]]]]:
    """(Anfragevektor, Notizvektoren) aus GENAU einem Modell. Ein Modell mit
    eigenem Index liest nur diesen; `embeddinggemma` den Gaertner-Index plus
    MOC-Nebenspeicher wie bisher."""
    if modell.eigener_index:
        entries = einbettung.lade_vektoren(vault, modell)  # raises IndexFehlt
        client = OllamaClient(embed_model=modell.ollama)
        return einbettung.anfrage_vektor(client, modell, query, _keep_alive()), entries
    store = Store(config.STATE_DIR / "gardener.db", read_only=True)
    try:
        entries = load_merged_embeddings(store, vault)
    finally:
        store.close()
    if not entries:
        return [], []
    client = OllamaClient()
    return client.embed(query, keep_alive=_keep_alive()), entries  # raises OllamaError if down


# Welches Modell die letzte semantic_search tatsaechlich benutzt hat, und warum
# nicht das gewaehlte (fuer `--json` und den Recall-Hook, dessen cosine-Schwelle
# je Modell gilt). Prozesslokal; `brain search` ist ein Prozess je Anfrage.
LAST_EMBED = {"modell": "", "grund": ""}
LAST_NOTES: list = []


def semantic_search(vault: Path, query: str, k: int,
                    modell: einbettung.Modell | None = None,
                    notes: dict | None = None, snippets: bool = True) -> list[SearchHit]:
    """Cosine top-k. `notes` (rel -> parsed note, the BM25 corpus) saves
    parsing each hit again; `snippets=False` leaves the snippet to the caller
    (hybrid_search fills it only for the final list)."""
    _stem_cache(vault)
    modell = modell or einbettung.aktives_modell()
    grund = ""
    try:
        qvec, entries = _semantic_entries(vault, query, modell)
    except einbettung.IndexFehlt as e:
        # Nie Vektoren zweier Modelle mischen: ohne passenden eigenen Index
        # laeuft die ganze semantische Seite (Anfrage UND Notizen) ueber
        # embeddinggemma, und die Ausgabe sagt es.
        grund = str(e)
        modell = einbettung.MODELLE["embeddinggemma"]
        qvec, entries = _semantic_entries(vault, query, modell)
    LAST_EMBED.update(modell=modell.name, grund=grund)
    if not entries:
        return []
    hits = rangkern.semantic_ranking(qvec, [("", rel, vec) for rel, vec in entries], k)
    for h in hits:
        note = _note_for(vault, h.rel, notes)
        if note is not None:
            h.title = note.title
            if snippets:
                rangkern.fill_snippet(h, note.text, query)
            h.derived = is_derived(note.fm)
    return _pool_trim(hits, k)


def _note_for(vault: Path, rel: str, notes: dict | None):
    note = notes.get(rel) if notes else None
    if note is None:
        note_path = vault / rel
        if note_path.exists():
            note = parse_note(vault, note_path)
    return note


def _git_dates(repo: Path) -> dict[str, int]:
    """Letzter Commit je .md-Datei von `repo` ohne Massencommits (rangkern);
    {} ohne Git. Rund 30 ms je Repo, nur bei Anfragen mit Zeitsignal."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "log", "--format=@%ct", "--name-only", "--no-renames"],
            capture_output=True, text=True, timeout=10,
            env=os.environ | {"GIT_TERMINAL_PROMPT": "0"})
    except (OSError, subprocess.SubprocessError):
        return {}
    return rangkern.parse_git_dates(proc.stdout) if proc.returncode == 0 else {}


def _zeit_date_of(vault: Path, notes: dict | None):
    """`date_of(hit)` fuer den Zeitbonus: Epoche des juengsten Datums aus
    Frontmatter/Dateiname (Tag, 12 Uhr) und/oder letztem Commit, je nach
    Quelle (rangkern.zeit_params). Git wird erst beim ersten Kandidaten und
    nur fuer dessen Repo gelesen (Space mit eigenem `.git` oder der Kern)."""
    import datetime as _dt

    quelle = rangkern.zeit_params()[3]
    repos: dict[Path, dict[str, int]] = {}

    def git_time(rel: str) -> int | None:
        parts = rel.split("/")
        repo, sub = vault, rel
        if len(parts) > 2 and parts[0] == "20-projects" and (vault / parts[0] / parts[1] / ".git").exists():
            repo, sub = vault / parts[0] / parts[1], "/".join(parts[2:])
        if repo not in repos:
            repos[repo] = _git_dates(repo)
        return repos[repo].get(sub)

    def date_of(hit: SearchHit) -> float | None:
        times: list[float] = []
        if quelle in ("fm", "max"):
            note = _note_for(vault, hit.rel, notes)
            day = rangkern.frontmatter_day(getattr(note, "fm", None), Path(hit.rel).name)
            if day:
                try:
                    times.append(_dt.datetime.fromisoformat(day + "T12:00:00").timestamp())
                except ValueError:
                    pass
        if quelle in ("git", "max"):
            t = git_time(hit.rel)
            if t is not None:
                times.append(float(t))
        return max(times) if times else None
    return date_of


def hybrid_search(vault: Path, query: str, k: int) -> list[SearchHit]:
    """BM25 + embedding search, fused with RRF, then a small structural boost
    for MOC.md/STATUS.md hits on navigational-looking queries. Raises
    OllamaError if Ollama is unreachable - callers fall back to bm25_rank alone."""
    pool = rangkern.hybrid_pool(k)
    korpus = _lex_korpus(vault)
    _THIS_CALL["korpus"] = korpus
    notes = {n.rel: n for n in korpus.notes}
    text_hits = bm25_rank(vault, query, pool, snippets=False, korpus=korpus)
    semantic_hits = semantic_search(vault, query, pool, notes=notes, snippets=False)
    hits = rangkern.fuse_hybrid(semantic_hits, text_hits, query, k,
                                date_of=_zeit_date_of(vault, notes))
    for h in hits:  # Auszug nur fuer die Endliste; er haengt nur an Text und Anfrage
        note = _note_for(vault, h.rel, notes)
        if note is not None:
            rangkern.fill_snippet(h, note.text, query)
    return hits


def fulltext_fallback(vault: Path, query: str, k: int) -> list[str]:
    """rg full-text fallback, used only if BM25 itself can't run (e.g. the
    vault can't be walked at all)."""
    try:
        proc = subprocess.run(
            # `-e` und `--`: eine Anfrage mit fuehrendem Strich ist Text, keine rg-Option (14.10.2026).
            ["rg", "-i", "-l", "--glob", "!secrets/**", "--glob", "*.md",
             "-e", query, "--", str(vault)],
            capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    return lines[:k]


def load_contradicted_rels(vault: Path) -> set[str]:
    """Notes carrying an open (or escalated) `brain contradict` finding.

    Best-effort: a missing/corrupt/absent-tool findings file just means "no
    known contradictions" - search must never fail because this file doesn't
    exist yet on a vault where the contradict tool hasn't run.
    """
    path = vault / config.CONTRADICTIONS_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    findings = raw.get("findings", {}) if isinstance(raw, dict) else {}
    rels: set[str] = set()
    for f in findings.values():
        if not isinstance(f, dict) or f.get("status") not in ("open", "escalated"):
            continue
        for side in ("note_a", "note_b"):
            rel = (f.get(side) or {}).get("rel")
            if rel:
                rels.add(rel)
    return rels


def _flag_contradictions(hits: list[SearchHit], vault: Path) -> list[SearchHit]:
    flagged = load_contradicted_rels(vault)
    if not flagged:
        return hits
    for h in hits:
        if h.rel in flagged:
            h.contradiction = True
    return hits


def claims_db_path(vault: Path) -> Path:
    """The dream's claim store for THIS vault. Derived from the vault the same
    way `config.bind_vault` derives the rest of the machine-local state, so a
    search against a test or throwaway vault never reads the real one's claims
    (see the bind_vault comment in gardener/config.py for what that mix-up
    cost once)."""
    return config.tool_dir_for(vault) / "state" / "dream" / "claims.db"


def load_retired_notes(vault: Path) -> dict[str, tuple[int, int, str]]:
    """Per vault note: (retired claims, claims in total, newest valid_to) from
    THIS vault's claims.db; see `rangkern.load_retired_notes_from`. A vault
    that never ran the dream yields {} - search must not fail over it."""
    return rangkern.load_retired_notes_from(claims_db_path(vault))


def validity_enabled(explicit: bool | None = None) -> bool:
    """Whether validity marks and demotes (frontmatter `status`/`superseded-by`/
    `valid-until`, else claims.db). `explicit` (the CLI flag) wins; otherwise
    BRAIN_VALIDITY=0/off/false switches it off. The switch touches only this
    pass - the ranking, the embeddings and the BM25 corpus are the same either
    way, so turning it off needs no reindexing and turning it back on needs no
    rebuild."""
    return rangkern.validity_enabled(explicit)


def _resolver(vault: Path):
    """`superseded-by`-Ziel -> (space "", rel, note) ueber Titel, Dateiname und
    Aliase des Suchkorpus (wie die Wikilink-Aufloesung des Gaertners)."""
    from gardener.vault import build_resolver, key_of
    korpus = _THIS_CALL.get("korpus")
    notes = korpus.notes if korpus is not None else load_search_notes(vault)
    index = build_resolver(notes)

    def resolve(target: str, _hit: SearchHit):
        note = index.get(key_of(target))
        return None if note is None else ("", note.rel, note)
    return resolve


def _flag_retired(hits: list[SearchHit], vault: Path,
                  enabled: bool = True, query: str = "") -> list[SearchHit]:
    """Gueltigkeit (`rangkern.apply_validity`, Endliste, nichts entfernt):
    Frontmatter `status: superseded|archived`, `superseded-by`, abgelaufenes
    `valid-until` werten voll ab und markieren; ohne diese Felder zaehlt der
    Anteil abgeloester Aussagen in claims.db. Ein fehlender Nachfolger wird
    eingereiht (BRAIN_VALIDITY_NACHFOLGER=0 schaltet nur das ab); die Liste
    kann dadurch laenger werden, `search` kuerzt auf k."""
    if not enabled:
        return hits
    korpus = _THIS_CALL.get("korpus")
    notes = {n.rel: n for n in korpus.notes} if korpus is not None else None
    resolver: list = []

    def resolve(target: str, hit: SearchHit):
        if not resolver:
            resolver.append(_resolver(vault))
        return resolver[0](target, hit)

    hits = rangkern.apply_validity(hits, load_retired_notes(vault),
                                   note_of=lambda h: _note_for(vault, h.rel, notes),
                                   resolve=resolve)
    for h in hits:
        if h.match == "nachfolger" and not h.snippet:
            note = _note_for(vault, h.rel, notes)
            if note is not None:
                rangkern.fill_snippet(h, note.text, query)
    return hits


def _label_spaces(hits: list[SearchHit], vault: Path) -> list[SearchHit]:
    manifest = spaces.load_manifest(vault)
    for h in hits:
        h.space = spaces.space_for_path(h.rel, manifest)
    return hits


def search(vault: Path, query: str, k: int = 5,
           validity: bool | None = None,
           space: str | None = None) -> tuple[list[SearchHit], bool]:
    """Returns (hits, used_fallback). used_fallback means Ollama was down and
    results are BM25-only (no semantic signal). `validity` overrides the
    BRAIN_VALIDITY switch for the retired-claim marking. `space` restricts
    the result to one space's notes (`--space kern` for just the root),
    applied after ranking - a filtered call can return fewer than `k` hits."""
    enabled = validity_enabled(validity)
    LAST_EMBED.update(modell="", grund="")
    LAST_NOTES.clear()
    _THIS_CALL.clear()
    # Mit Space-Filter mehr Kandidaten ranken und erst nach dem Filtern auf k kuerzen,
    # sonst bleiben vom Top-k eines ganzen Vaults oft kaum Treffer uebrig (26.09.2026).
    kk = max(k * 8, 40) if space else k
    try:
        hits = hybrid_search(vault, query, kk)
        hits = _label_spaces(_flag_contradictions(
            _flag_retired(hits, vault, enabled, query), vault), vault)
        return _filter_space(hits, space)[:k], False
    except OllamaError:
        pass
    korpus = _THIS_CALL.get("korpus")
    hits = rangkern.apply_stand_bonus(
        _demote_derived(bm25_rank(vault, query, max(kk * 4, 20), korpus=korpus)), query)
    hits = rangkern.apply_zeit_bonus(
        hits, query, _zeit_date_of(vault, {n.rel: n for n in korpus.notes} if korpus else None))[:kk]
    if not hits:
        paths = fulltext_fallback(vault, query, k)
        hits = [SearchHit(rel=str(Path(p).relative_to(vault)), score=0.0, match="text")
                for p in paths]
    hits = _label_spaces(_flag_contradictions(
        _flag_retired(hits, vault, enabled, query), vault), vault)
    return _filter_space(hits, space)[:k], True


def _filter_space(hits: list[SearchHit], space: str | None) -> list[SearchHit]:
    """`space` ist ein Space oder eine Komma-Liste (`a machine-bound project,a project`)."""
    if not space:
        return hits
    erlaubt = {x.strip() for x in space.split(",") if x.strip()}
    return [h for h in hits if h.space in erlaubt]
