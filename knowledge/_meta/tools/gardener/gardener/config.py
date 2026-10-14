"""Central configuration and hard safety rules for the gardener."""
from __future__ import annotations

import json
import os
from pathlib import Path

# BRAIN_VAULT is the one path anchor for a non-Mac-der Nutzer machine (peer,
# ein Mitnutzer's account, a test harness): everything else derives the vault from
# a CLI --vault flag or from this default, never from a hardcoded
# `$HOME/Knowledge` (brain5-architektur-entwurf.md Abschnitt 4.3).
DEFAULT_VAULT = Path(os.environ["BRAIN_VAULT"]).expanduser() \
    if os.environ.get("BRAIN_VAULT") else Path.home() / "Knowledge"
TOOL_DIR = Path(__file__).resolve().parent.parent  # _meta/tools/gardener/
STATE_DIR = TOOL_DIR / "state"
LOG_DIR = TOOL_DIR / "logs"

# Der maschinenlokale Zustand gehoert zu DEM Vault, gegen den gearbeitet wird -
# nicht zu dem, in dem der Code zufaellig liegt. Bis zum 2026-08-10 war das
# nicht so, und der Unterschied hat den semantischen Index des echten Vaults
# geloescht: `brain --vault /tmp/wegwerf contradict --write` verschob den
# Korpus, nicht aber STATE_DIR, und `linking.embed_notes` beendet jeden Lauf mit
# `store.prune_embeddings({rel der bearbeiteten Notizen})`. Ergebnis am
# 2026-08-04 um 03:21 Uhr: 249 Vektoren des echten Vaults geloescht, uebrig
# blieben die zwei Notizen eines Wegwerf-Vaults aus einem Testlauf. Sechs Tage
# unbemerkt, weil eine Suche mit kaputtem Index weiter Ergebnisse liefert.
# Deshalb bindet jeder Einstiegspunkt mit --vault den Zustand einmal an den
# Vault (`bind_vault`), bevor irgendein Store geoeffnet wird.


def tool_dir_for(vault, tool: str = "gardener") -> Path:
    """Werkzeugverzeichnis INNERHALB des angegebenen Vaults."""
    return Path(vault).expanduser().resolve() / "_meta" / "tools" / tool


def bind_vault(vault) -> Path:
    """Bindet STATE_DIR/LOG_DIR (und damit DREAM_STATE_DIR) an `vault`.

    Einmal am Anfang von main() aufzurufen, vor jedem Store und jedem Logfile.
    Fuer den echten Vault ist das ein No-Op im Ergebnis, weil die Werkzeuge
    ohnehin unter `~/Knowledge/_meta/tools/` liegen; fuer jeden anderen Vault
    (Test, Klon, Zweitmaschine) landet der Zustand bei diesem Vault statt im
    Zustand des echten.
    """
    global STATE_DIR, LOG_DIR, DREAM_STATE_DIR
    tool_dir = tool_dir_for(vault)
    STATE_DIR = tool_dir / "state"
    LOG_DIR = tool_dir / "logs"
    DREAM_STATE_DIR = STATE_DIR / "dream"
    return STATE_DIR

OLLAMA_URL = "http://localhost:11434"
# 120 s was too tight: with another model resident the judge shares the GPU and
# a single call ran into the timeout, which used to kill the whole run.
OLLAMA_TIMEOUT = 180
# embeddinggemma's context is 2048 tokens. Measured 2026-07-12 against the live
# model: appending text past ~8000-9000 chars of German prose does not change the
# vector at all - it is silently dropped. Notes are therefore embedded in chunks
# that safely fit (4000 chars is under 2048 tokens even for token-dense code/URLs)
# and mean-pooled, so a long note's tail still influences its links.
EMBED_MAX_CHARS = 8000        # hard backstop for a single embed call
EMBED_CHUNK_CHARS = 4000
EMBED_CHUNK_OVERLAP = 200     # so a fact on a chunk border is not cut in half
EMBED_MAX_CHUNKS = 8          # 8 x 4000 = 32k chars; beyond that a note is a book
# v3 (e28, 2026-09-27): embed_text no longer contains the gardener-managed
# `## Relations` section (the machine-appended link lines changed every touched
# note's vector; the leiteroptimierung note lost its replay warning over it).
# v2 kept the Relations in the embedded text.  One full re-embed follows the
# bump; `BRAIN_EMBED_RELATIONS=1` restores the v2 rule.
# v4 (b6-embedfm, 2026-09-28): embed_text drops the frontmatter (title and
# aliases stay as head) and the cache key hashes the embedded text instead of
# the whole file, so frontmatter upkeep no longer invalidates vectors.
EMBED_VERSION = 4             # bump to invalidate cached (truncated) vectors
EMBED_MODEL = "embeddinggemma:latest"
# Wie lange Ollama das Einbettungsmodell nach einer EINZELNEN Suchabfrage haelt (brain search,
# Auto-Recall). Begruendung und Messung: braincli/search.py, semantic_search.
SEARCH_KEEP_ALIVE = "30m"
# Das kleine Modell: fuer Aufgaben, die eine Zusammenfassung von bereits
# extrahiertem Text liefern statt ein Urteil ueber Struktur oder Wahrheit des
# Vaults (Sidecar-Dateibeschreibung, Ingest-Asset-Beschreibung - siehe
# sidecar.describe/extract.summarize). Alles, dessen Fehlurteil Unsinn in den
# Vault schreibt oder eine Struktur behauptet, die nicht da ist (linking,
# contradict, consolidate, HOT.md-Zusammenfassung, Transkript-Mining,
# Themensynthese), laeuft seit dem Auftrag "modellwege" (02.09.2026)
# stattdessen ueber `grug_client.GrugJudgeClient` (Qwen3.8-27B via MLX) -
# Ollama kennt Qwen3.8 gar nicht (`{"error": "invalid model name"}` auf Port
# 11434, geprueft 02.09.2026), sodass ein Umstieg dieser Stellen auf ein
# schlaueres Modell zwangslaeufig vom Ollama-Client weggefuehrt haette.
#
# BEWUSSTE FESTLEGUNG, kein vergessener Platzhalter (Auftrag "startklar",
# 03.09.2026, Entscheidung des Nutzers): ornith:9b bleibt der Wert. Welches der
# heute installierten kleinen Modelle (ornith:9b 5,6 GB, qwen3-vl:8b 6,1 GB,
# huihui_ai/qwen3-abliterated:4b 2,5 GB, qwen3:1.7b 1,4 GB) hier gewinnt, war
# am 02.09.2026 noch eine offene, PARALLEL laufende Recherche - die entfaellt
# jetzt, der Wert ist final. Gebraucht wird das kleine Modell nur noch fuer
# Sidecar-Dateibeschreibungen und Ingest-Asset-Zusammenfassungen (siehe
# Kommentar oben) - jede Urteils-/Schreib-Stelle ist seit "modellwege"
# (02.09.2026) laengst auf `smart` (Qwen3.8-27B via MLX) umgezogen.
SMALL_MODEL = "ornith:9b"
VISION_MODEL = "qwen3-vl:8b"   # local image description; skipped when not pulled
MAX_VISION_BYTES = 12 * 1024**2  # bigger images are left to a human

# Hard exclusions: never read, never embed, never write anything below these.
EXCLUDE_DIRS = {"secrets", ".obsidian", ".git", "_meta"}
# Managed / generated top-level files: never part of the linking corpus.
EXCLUDE_FILES = {"HOT.md", "INDEX.md", "CRITICAL-FACTS.md", "review-queue.md",
                 "OPEN-QUESTIONS.md", "LOG.md"}
# Generated files at any depth: never part of the linking corpus.
EXCLUDE_ANY_DEPTH = {"review-queue.md", "MOC.md", "DECISIONS.md"}
# `dream-report-` joins the two for the same reason they are here: a generated
# report about the vault is not material the vault should link, embed or read
# back in (see gardener/dream/apply.py write_report).
# brain-vorschlaege: ungepruefte Pipeline-Vorschlaege je Projekt (gardener/lauf/schreiben.py)
EXCLUDE_PREFIXES = ("gardener-report-", "brain-health-", "dream-report-", "brain-run-", "brain-vorschlaege")
# Non-Markdown files the write gate accepts (vault.check_writable): only the
# per-project trap book, written by `brain run` into its own section.
WRITABLE_DATA_FILES = frozenset({"FALLEN.yaml"})

# Sidecar layer (Brain 3.x): every non-.md file gets a `<name>.<ext>.md`
# sibling note describing it, so an agent can skip opening the real file
# unless it actually needs to.
SIDECAR_EXTRA_EXCLUDE_DIRS = {"__pycache__"}
SIDECAR_EXCLUDE_FILE_NAMES = {".DS_Store"}
SIDECAR_EXCLUDE_FILE_GLOBS = ("*.lock", "*.pyc", "*.pyo", "*.cache", "*.tmp",
                             "*.swp", "*.swo", "*~")
# Structured config/data files in the knowledge branches are read by tools, not
# by people: FALLEN.yaml (tripwire), .space.yml (spaces), tables and JSON.
# They are plain text a model reads directly; a sidecar would only repeat them
# and go stale with every pipeline write. A file of these types a human files
# deliberately as an asset (below `_assets/`) keeps its sidecar, and so does
# anything outside the knowledge branches (e.g. raw material in 00-sources).
SIDECAR_KNOWLEDGE_DIRS = ("10-global", "20-projects", "30-topics", "40-people")
SIDECAR_DATA_SUFFIXES = frozenset({".yaml", ".yml", ".json", ".tsv"})
BRAINIGNORE_FILE = ".brainignore"
SIDECAR_EXTRACT_MAX_CHARS = 6000   # first slice handed to the local judge
SIDECAR_EXTERNAL_MB = 50           # matches the git-lfs commit cap (INDEX.md)

ASSET_DIR = "_assets"
# Raw, unreviewed material. Nothing in here may claim a structural relation to
# the canonical vault: a human still has to promote it (see linking.is_staging).
STAGING_DIR = "00-sources"
DROP_DIR = "00-sources/drop"
# Written by the B4 read-tracking hook; may not exist. Vault-relative.
HEAT_LOG = "_meta/tools/state/read-heat.log"
TRANSCRIPT_DIR = Path.home() / ".claude" / "projects"
MINED_DIR = "00-sources/mined"

MAX_NEW_LINKS_PER_NOTE = 5
NEIGHBOR_TOP_K = 5
LINK_MIN_SIMILARITY = 0.55
LINK_MIN_CONFIDENCE = 0.70   # an unsure "yes" from the judge is not a link
# Auftrag g6 (24.09.2026): "batch" judges up to 5 candidates of one source note
# per call (linking.judge_batches), "pair" is the old one-call-per-pair path
# and the way back. Run of 24.09.: pair mode took 44 of 48 minutes.
LINK_JUDGE_MODE = os.environ.get("GARDENER_LINK_JUDGE_MODE", "batch")
# Hubs never become link candidates (either side): all 14 hub links in the
# 24.09. sample were trivial. Vault-root files count as hubs too.
LINK_HUB_NAMES = frozenset({"KERN.md", "STATUS.md", "ENTSCHEIDUNGEN-UND-FALLEN.md",
                            "LOG.md", "overview.md"})
LINK_HUB_SUFFIXES = ("-overview.md",)
MERGE_MIN_SIMILARITY = 0.90
MERGE_MIN_CONFIDENCE = 0.85
STALE_MARKER_MONTHS = 6
# Projekt- und Systemseiten aendern sich in Wochen, nicht in Halbjahren: KERN, STATUS und
# `type: system` gelten schon nach 2 Monaten als veraltet (ana-struktur Empfehlung 12, 2026-09-28).
STALE_MARKER_MONTHS_FAST = 2
STALE_FAST_NAMES = frozenset({"KERN.md", "STATUS.md"})
STALE_FAST_TYPES = frozenset({"system"})

# Topic hubs
TOPIC_MEMBER_SIM = 0.60      # note counts as hub member from this similarity
TOPIC_MAX_AUTO_MEMBERS = 12
CLUSTER_MIN_SIM = 0.70       # pairwise similarity inside a hub-suggestion cluster
# Ein Cluster, dessen Notizen zu mindestens diesem Anteil in EINEM Projektordner liegen, ist ein
# Projekt-Doppel: das Projekt hat seine eigene Themenseite (Projektzweig der Synthese), ein zweites
# Thema ueber dieselben Notizen liefert nur Rauschen (ana-struktur Nr. 7, 2026-09-28).
TOPIC_PROJECT_DOUBLE_SHARE = 0.8
CLUSTER_MIN_SIZE = 4         # muss zu SYNTH_MIN_SOURCES passen: ein Cluster,
                             # aus dem keine Seite entstehen darf, wurde bei 3
                             # gefunden und bei 4 verworfen - Lauf fuer Lauf
MAX_HUB_SUGGESTIONS = 3      # per run; clusters are disjoint and biggest-first

# Read-heat / resurfacing
COLD_MONTHS = 6              # no read in this many months -> review-queue hint
COLD_QUEUE_MAX = 5           # at most this many cold-note hints per run
RESURFACE_COUNT = 2          # "Vergessene Schaetze" per HOT.md run
HOT_HEAT_DAYS = 30
# Read-heat from the agents' own transcripts (Auftrag g5, 24.09.2026). The hook
# log above had 239 lines since July against 1281 vault reads in the Claude
# transcripts since 01.08. (v2-gaertner, nutzung-20260801.json), so
# "Meistgelesen" and "Vergessene Schaetze" in HOT.md ranked noise. Both sources
# are merged; False falls back to the hook log alone.
HEAT_FROM_TRANSCRIPTS = os.environ.get("GARDENER_HEAT_TRANSCRIPTS", "1") != "0"
CODEX_SESSION_DIR = Path.home() / ".codex" / "sessions"
HEAT_TRANSCRIPT_CACHE = "transcript-heat.json"   # in STATE_DIR, per file mtime/size

# Note size lint: rough token estimate = words * TOKENS_PER_WORD
NOTE_MAX_TOKENS = 800
TOKENS_PER_WORD = 1.3

# Transcript mining (local only, nothing ever leaves the machine)
TRANSCRIPT_DAYS = 7
TRANSCRIPT_MAX_FILES = 15
TRANSCRIPT_MAX_CHARS = 12000     # per transcript, handed to the local judge
MINE_MAX_PER_TRANSCRIPT = 3      # a transcript rarely holds more durable facts
MINE_MAX_PER_RUN = 8             # 00-sources is a queue for a human, not a dump

RUN_BUDGET_SECONDS = 45 * 60
# Share of the remaining budget linking may use (Auftrag g4, 24.09.2026) - the
# first pass over a vault has thousands of candidates; what is left over is
# picked up by the next run, the blocklist remembers every "no".
LINKING_BUDGET_SHARE = 0.5
LINKING_BUDGET_MAX_SECONDS = 15 * 60
# Denkstufe der schreibenden Richter-Stellen (consolidate, HOT.md, synth, mine)
# auf Splash; linking urteilt ohne Denken. Siehe cli.py bei `smart`.
SMART_REASONING_EFFORT = os.environ.get("GARDENER_JUDGE_EFFORT", "low")
LOCK_STALE_SECONDS = 15 * 60
# 48-GB rule: abort if a big model is already loaded in Ollama.
MAX_LOADED_MODEL_BYTES = 15 * 1024**3

# Wer die Gaertner-Commits schreibt und wessen Notizen als "eigen" gelten (protect.py). Auf einem
# anderen Rechner (ein Mitnutzer, BRAIN5-PLAN Nr. 38) per GARDENER_GIT_AUTHOR setzen, sonst schriebe der
# Gaertner dort unter Namen des Nutzers und hielte die Notizen des Besitzers fuer fremd.
_STANDARD_AUTOR = "<your-github-user>"
GIT_AUTHOR = os.environ.get("GARDENER_GIT_AUTHOR", "").strip() or _STANDARD_AUTOR + " <you@example.com>"
# GitHub-Konto, unter dem die Haus-Repos liegen (`<konto>/<repo>` in Texten routet auf ein Projekt,
# lauf/quellen.py). Eigener Wert, nicht aus GIT_AUTHOR: auf eines Mitnutzers Rechner aendert sich der Autor,
# die Repos bleiben dieselben. Steht hier statt als Regex im Quelltext (oeffentlicher Export, 14.10.2026).
GITHUB_HANDLE = os.environ.get("GARDENER_GITHUB_HANDLE", "").strip() or _STANDARD_AUTOR

RELATION_TYPES = ("relates-to", "depends-on", "supersedes", "part-of", "contradicts")
# Types that assert more than "these two are related". Only accepted when one
# note demonstrably references the other (see linking.validate_verdict).
STRUCTURAL_TYPES = ("depends-on", "supersedes", "part-of", "contradicts")

PHASES = ("embed", "linking", "consolidate", "maintain", "ingest", "sidecar",
          "mine", "lint", "synth", "owner", "all")

# Project ownership (`owner:` in a project MOC, see gardener/owner.py). The map
# is keyed on the FULL git identity, never on the mail alone: per 40-people the
# account mail is shared between both people and no proof of identity. An author
# missing here leaves the project's owner empty, which is the intended outcome.
#
# The map lives in an EXTERNAL file this module may never ship and may not find
# (absent is not an error - "nobody configured"). Same rule as
# SECRET_EXTRA_PATTERNS_FILE, and for the same reason: a table of real names,
# mail addresses and account ids is person data, and person data does not
# belong in a file that gets published.
#
# The occasion was 17.08.2026. A public repo was built from this tree, and the
# anonymiser that ran over it replaced the surnames but left a numeric GitHub
# id standing - the `<id>+<account>@users.noreply.github.com` form, which
# resolves over the public API back to the very account the line was meant to
# hide. Patching the anonymiser would have fixed that one line. Moving the
# table out fixes the whole class: there is no identity in the source any more,
# neither as a name nor as a number. (The id itself is deliberately not written
# down here - a report never repeats the value it is about.)
#
# JSON: {"authors": {"<Name> <mail>": "<40-people slug>", ...}}
PERSON_BY_GIT_AUTHOR_FILE = (Path.home() / ".config" / "gardener"
                             / "person-by-git-author.json")


def _load_person_by_git_author() -> dict[str, str]:
    try:
        data = json.loads(PERSON_BY_GIT_AUTHOR_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}          # absent or unreadable - "nobody configured"
    authors = data.get("authors") if isinstance(data, dict) else None
    if not isinstance(authors, dict):
        return {}
    return {k: v for k, v in authors.items()
            if isinstance(k, str) and isinstance(v, str)}


PERSON_BY_GIT_AUTHOR = _load_person_by_git_author()
# Share of a branch's notes one person must have created to count as its owner.
OWNER_MIN_SHARE = 2 / 3

# Contradiction detection (`brain contradict`). Reuses the 48-GB rule and the
# gardener.db embedding cache - see gardener/contradict.py.
#
# MODELLWEGE (02.09.2026): contradict.judge_pair's task - deciding whether
# two notes really contradict each other, from a 9B model that "happily
# invents a plausible-sounding quote" (see contradict.py's module docstring)
# - belongs in the SMART class, same reasoning as linking/consolidate.
#
# UMGESTELLT (Auftrag "startklar", 03.09.2026): der Client fuer `brain
# contradict` wird in `_meta/tools/braincli/braincli/cli.py`s `cmd_contradict`
# konstruiert - dort heisst er `smart` (`grug_client.GrugJudgeClient`,
# Qwen3.8-27B via MLX), `client` (Ollama) bleibt dort nur fuer Embeddings und
# die 48-GB-Vorpruefung. `cmd_contradict` provisioniert den MLX-Server dafuer
# selbst (`gardener.mlx_server.ensure`/`.release`, dieselbe
# Eigentuemerschafts-Buchfuehrung wie `gardener/cli.py`s fuenf schlaue Phasen).
CONTRADICT_TOP_K = 5             # semantic neighbors checked per note, not O(n^2)
CONTRADICT_MIN_CONFIDENCE = 0.75  # a missed contradiction is cheaper than a false alarm
# Vault-relative. Distinct from the tool-local, gitignored `_meta/tools/*/state/`
# caches: these three are shared/git-tracked knowledge, like the root review-queue.md.
CONTRADICT_LAST_RUN_FILE = "_meta/tools/state/contradict.json"
CONTRADICTIONS_FILE = "_meta/state/contradictions.json"
CONTRADICT_REVIEW_QUEUE = "review-queue.md"   # Wurzel, siehe queue.py
# Sammelstelle fuer `brain contradict --queue-add` (Session-Ende haengt hier nur noch
# Pfade an, Millisekunden statt ~100s/Notiz). Abgearbeitet durch `brain contradict
# --queue --write`, von Hand angestossen (seit 2026-08-22 laeuft auf dem Mac kein
# zeitgesteuerter LaunchAgent mehr, auch der Gaertner selbst nur noch manuell -
# siehe gardener/cli.py).
CONTRADICT_QUEUE_FILE = "_meta/state/contradiction-queue.txt"

# Claude auto-memory files. A dead vault wikilink whose target is one of them
# is reported as `memory-ziel` (lint), not as a dead link: the knowledge exists,
# only outside the vault (v2-gaertner: 27 of 155 dead targets, 24.09.2026).
MEMORY_GLOB = os.environ.get("GARDENER_MEMORY_GLOB",
                             "~/.claude/projects/*/memory/*.md")

# Topic synthesis (Brain 4.x, `brain gardener run --phase synth`). Unlike
# topics.py's hand-curated hub + appended "further notes" block, a synth page
# (`30-topics/<t>/MOC.md`, `class: derived`) is written end to end by the
# gardener and treated as disposable/regenerable - see gardener/synth.py.
SYNTH_MIN_SOURCES = 4              # a page over fewer notes is noise
SYNTH_MAX_SOURCE_CHARS = 2000      # per-source excerpt handed to the judge
# V2 default since 27.09.2026 (v3-gaertner rounds 2-4): strict retention on two independent gold sets
# V1 10/30 -> V2 23/30, full-copy run 19.8 min within the 45-min budget, repeat run rewrites nothing.
# GARDENER_SYNTH_VERSION=1 restores the old synthesis.
SYNTH_VERSION = int(os.environ.get("GARDENER_SYNTH_VERSION", "2"))
SYNTH_PARALLEL = max(1, int(os.environ.get("GARDENER_SYNTH_PARALLEL", "1")))
SYNTH_MAX_SOURCES_IN_PROMPT = 20   # keep the prompt bounded on a big topic
SYNTH_MAX_CLUSTER_CANDIDATES = 5   # new wikilink/embedding-cluster pages per run

# Dream (`brain dream`, see DREAM-PLAN.md). A sibling run, not a gardener
# phase - it uses the gardener as a library (gardener.dream.*), never the
# other way round. Only the two ablage decisions from DREAM-PLAN.md
# Abschnitt 3 live here, so gardener.dream.config has exactly one place to
# import them from instead of re-deriving TOOL_DIR/STATE_DIR itself.
DREAM_STATE_DIR = STATE_DIR / "dream"   # machine-local, covered by state/ in .gitignore
DREAM_AUDIT_DIR = "_meta/state/dream"   # vault-relative, versioned (like contradictions.json)
# The dream's own marker block inside a note. Ownership of a hand-written note
# is BELEGT, never inferred: only `class: derived` or exactly this marker pair
# means "this text is ours". Defined here rather than in gardener.dream.config
# because gardener.synth must know it too - a phase that regenerates a derived
# page has to leave the dream's block alone, the same way it already leaves
# maintain's MOC block alone. Two copies of a marker are two markers that drift.
DREAM_BLOCK_START = "<!-- dream:block:start -->"
DREAM_BLOCK_END = "<!-- dream:block:end -->"
# The dream's own section of the shared review-queue.md, same mechanism the
# contradiction scanner uses for its section since 2026-07-29.
DREAM_QUEUE_SECTION_START = "<!-- dream:start -->"
DREAM_QUEUE_SECTION_END = "<!-- dream:end -->"
