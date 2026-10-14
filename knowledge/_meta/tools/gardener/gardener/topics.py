"""Topic hubs (30-topics/<t>/MOC.md).

A topic hub links notes that live in OTHER branches, so "membership" cannot come
from the folder. It comes from embeddings: notes close to the hub's own text are
listed in the gardener block. The curated part above the block stays human.

Second job: notes that cluster tightly together but have no hub yet. Seit
2026-07-29 werden sie NICHT mehr als Vorschlag in die Review-Queue gelegt -
Themenbereiche wachsen automatisch (der Nutzer), die Synthese-Phase legt die
Seite selbst an. Ein Cluster braucht `config.CLUSTER_MIN_SIZE` Notizen, was zu
`config.SYNTH_MIN_SOURCES` passen muss, sonst wird gefunden, was nie gebaut
werden darf.

MOC.md is excluded from the linking corpus, so hubs are loaded (and embedded)
separately via load_hubs().
"""
from __future__ import annotations

import datetime as dt
import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config
from .linking import cosine
from .maintain import MOC_END, MOC_START, first_hook_line
from .queue import ReviewQueue
from .vault import Note, VaultWriter, parse_note

log = logging.getLogger("gardener")

AUTO_HEADING = "## Weitere Notes zum Thema (gardener)"

# Anteil eines Clusters, den ein bestehender Hub schon verlinken muss,
# damit der Cluster als abgedeckt gilt (siehe _covered).
COVERED_SHARE = 0.6

# Share of the cluster's titles the naming word must appear in (see suggest_name).
NAME_MIN_SHARE = 0.3

# words that never make a topic name (note-type words, dates, vault jargon).
# `kern`/`handoff`: file-type names (every project has a `KERN.md`, handoffs are
# `HANDOFF-*.md`) - the run of 24.09.2026 built `30-topics/kern/` out of 56
# KERN files, because the all-caps title counts as "capitalised".
STOPWORDS = {
    "session", "sessions", "note", "notes", "moc", "index", "overview",
    "plan", "brief", "state", "report", "readme", "setup", "brain", "vault",
    "todo", "draft", "info", "check", "checklist", "update", "final",
    "kern", "handoff", "fallen", "entscheidungen", "entscheidungen-und-fallen",
    # Allerweltswoerter, die als Themenname nichts benennen (b6-struktur, 2026-09-28): `status` und
    # `sitzung` stehen in jedem zweiten Titel, `news` und `konto` sind Fachwoerter EINES Projekts
    # (Nachrichtenlage, Konto B/C), kein Querthema. Personennamen kommen aus 40-people
    # (`existing_branch_names`), nicht aus einer Liste.
    "status", "sitzung", "sitzungen", "news", "konto",
}

# German and English function words (4+ letters, the only length TITLE_WORD_RE
# sees). Needed because rule b) of is_nameable accepts a word that is
# capitalised in a title, and a sentence title capitalises its FIRST word
# whatever it is: "Zwei Kurse in einer Rechnung", "Eine Sperre loescht ihren
# Gegenbeweis". Run of 24.09.2026: `30-topics/zwei/` (85 links) and
# `30-topics/eine/` came from exactly that, and `nicht` was proposed with 86
# notes. A closed word class, so a fixed list is complete enough; nouns never
# land here.
FUNCTION_WORDS = {
    # numerals
    "eins", "zwei", "drei", "vier", "fuenf", "fünf", "sechs", "sieben", "acht",
    "neun", "zehn", "zwoelf", "zwölf", "hundert", "erste", "ersten", "erster",
    "zweite", "zweiten", "dritte", "halb", "halbe", "beide", "beiden",
    # articles, pronouns, determiners
    "eine", "einer", "einem", "einen", "eines", "kein", "keine", "keiner",
    "keinem", "keinen", "keines", "dies", "diese", "dieser", "diesem", "diesen",
    "dieses", "jede", "jeder", "jedem", "jeden", "jedes", "alle", "allem",
    "allen", "aller", "alles", "sich", "selbst", "niemand", "nichts", "etwas",
    "welche", "welcher", "welches", "seine", "seinen", "seiner", "ihre",
    "ihren", "ihrer", "unser", "unsere", "euch", "deren", "dessen", "andere",
    "anderen", "anderer", "anderes", "eigene", "eigenen", "eigener", "manche",
    "viele", "vielen", "wenige", "mehr", "weniger", "meist", "meisten",
    # prepositions, conjunctions, adverbs, particles
    "nicht", "noch", "schon", "auch", "doch", "aber", "oder", "sondern",
    "wenn", "dann", "dass", "weil", "denn", "obwohl", "statt", "anstatt",
    "ohne", "über", "ueber", "unter", "nach", "durch", "gegen", "zwischen",
    "wegen", "trotz", "während", "waehrend", "seit", "bevor", "nachdem",
    "beim", "vom", "zum", "zur", "hinter", "neben", "vorher", "nachher",
    "immer", "wieder", "erst", "jetzt", "heute", "gestern", "morgen", "hier",
    "dort", "warum", "wieso", "weshalb", "wann", "wohin", "woher", "womit",
    "damit", "dabei", "dafür", "dafuer", "davon", "darum", "daher", "also",
    "ganz", "gleich", "genau", "eben", "kaum", "fast", "sehr", "viel", "wenig",
    "nur", "bloss", "bloß", "allein", "zuerst", "zuletzt", "endlich", "bereits",
    "trotzdem", "sonst", "etwa", "rund",
    # auxiliaries and modal verbs
    "sind", "wird", "werden", "wurde", "wurden", "worden", "sein", "gewesen",
    "haben", "hatte", "hatten", "kann", "können", "koennen", "konnte", "muss",
    "müssen", "muessen", "musste", "soll", "sollen", "sollte", "darf",
    "dürfen", "duerfen", "will", "wollen", "gibt", "geht", "macht", "bleibt",
    "steht", "heisst", "heißt",
    # English
    "with", "without", "from", "into", "onto", "about", "when", "what",
    "that", "this", "these", "those", "they", "them", "their", "there",
    "where", "which", "while", "over", "under", "after", "before", "between",
    "first", "second", "three", "four", "five", "only", "more", "most",
    "less", "never", "always", "still", "again", "does", "done", "have",
    "been", "being", "were", "would", "should", "could", "your", "just",
    "then", "than", "also", "some", "every", "none", "each", "other",
}

# Ein Titelwort. Bindestrich-Token bleiben ganz UND werden zerlegt - siehe
# suggest_name.
TITLE_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9-]{3,}")
# Was ein Mensch selbst als Begriff markiert hat: der Inhalt eines Wikilinks
# oder eines Backtick-Ausdrucks. Nur als Stichentscheid gebraucht, nie als
# Huerde - gemessen am 08.08.2026 ueber alle 247 Notizen wuerde dieses
# Vokabular als Pflicht fuenf echte Themen verwerfen (`feingeister`,
# `incident`, `minecraft`, `orchestrator`, `praktikumssuche`), weil ein
# gewoehnliches deutsches Substantiv nie in Backticks steht.
_WIKILINK_SPAN_RE = re.compile(r"\[\[([^\]|#\n]+)")
_BACKTICK_SPAN_RE = re.compile(r"`([^`]+)`")
_IDENTIFIER_SHAPE_RE = re.compile(r"[-./0-9]")


@dataclass
class TopicResult:
    mocs_updated: list[str] = field(default_factory=list)
    hubs_suggested: list[tuple[str, list[str]]] = field(default_factory=list)


def load_hubs(vault: Path) -> list[Note]:
    base = vault / "30-topics"
    if not base.is_dir():
        return []
    return [parse_note(vault, p / "MOC.md") for p in sorted(base.iterdir())
            if p.is_dir() and (p / "MOC.md").exists()]


def hub_members(hub: Note, notes: list[Note], vectors: dict[str, list[float]],
                min_sim: float = config.TOPIC_MEMBER_SIM,
                limit: int = config.TOPIC_MAX_AUTO_MEMBERS) -> list[Note]:
    """Notes semantically close to the hub, excluding the ones it already links."""
    if hub.rel not in vectors:
        return []
    scored = []
    for n in notes:
        if n.rel == hub.rel or n.rel not in vectors:
            continue
        if n.keys & hub.links:          # already curated by hand
            continue
        if n.ntype in ("report", "asset"):
            continue
        sim = cosine(vectors[hub.rel], vectors[n.rel])
        if sim >= min_sim:
            scored.append((sim, n))
    scored.sort(key=lambda t: -t[0])
    return [n for _s, n in scored[:limit]]


def render_block(members: list[Note]) -> str:
    listing = "\n".join(f"- [[{n.title}]] - {first_hook_line(n)}"
                        for n in members) or "- keine"
    return f"{MOC_START}\n{listing}\n{MOC_END}"


def update_topic_mocs(hubs: list[Note], notes: list[Note],
                      vectors: dict[str, list[float]],
                      writer: VaultWriter) -> list[str]:
    updated = []
    for hub in hubs:
        if hub.rel not in vectors:
            continue
        block = render_block(hub_members(hub, notes, vectors))
        old = hub.text
        new, ok = blocks.replace_block(old, MOC_START, MOC_END, block)
        if not ok:
            log.warning("malformed gardener block in %s - not rewriting it", hub.rel)
            continue
        if new == old:
            if MOC_START in old:
                continue                        # block already current
            new = old.rstrip("\n") + f"\n\n{AUTO_HEADING}\n{block}\n"
        if not writer.write(hub.path, new, expect=old):
            continue
        hub.text = new
        updated.append(hub.rel)
    return updated


def _covered(cluster: list[Note], hubs: list[Note]) -> bool:
    """True if an existing hub already links a clear majority of the cluster.

    Frueher: "fast alle" (len-1). Zu streng, um Synonym-Themen zu verhindern -
    am 2026-07-29 entstand `30-topics/another service/` neben dem bestehenden
    `30-topics/a project/`, obwohl drei der fuenf Quellnotizen dieselben waren:
    die App heisst another service, der Projektordner a project, und der Namensvorschlag
    kannte den zweiten Namen nicht. Ein Cluster, dessen Mehrheit schon unter
    einem Hub haengt, ist kein neues Thema.
    """
    for hub in hubs:
        hit = sum(1 for n in cluster if n.keys & hub.links)
        if hit >= max(2, math.ceil(len(cluster) * COVERED_SHARE)):
            return True
    return False


def marked_vocabulary(notes: list[Note]) -> set[str]:
    """Every term a HUMAN put in backticks or a wikilink, as the whole span.

    Not a curated list: it is read out of the vault, so it grows with it. Used
    only where two words are otherwise equal - see suggest_name.
    """
    out: set[str] = set()
    for n in notes:
        if n.rel.startswith("30-topics/"):
            continue            # derived pages are not evidence of anything
        for pattern in (_WIKILINK_SPAN_RE, _BACKTICK_SPAN_RE):
            for m in pattern.finditer(n.text):
                span = m.group(1).strip().lower().strip(".,;:!?\"'*_()")
                if 3 < len(span) <= 40:
                    out.add(span)
    return out


def title_words(title: str) -> list[str]:
    """The words of a title, hyphenated tokens counted whole AND in parts.

    `claude-model-routing` is one token to the regex, so before 2026-08-08 a
    slug title contributed nothing to the word that actually carries it. That
    is how `30-topics/über/` came about: four notes about the Claude CLI, two
    of them slug titles (`claude-model-routing`, `claude-setup-share-bundle`)
    and two sentence titles containing the preposition. `claude` therefore
    scored 2 - the same as `über` - and the tie went to the SHORTER word.
    German function words are short, so that tiebreak preferred exactly the
    words that mean nothing. Counting the parts makes it 4 against 2 and there
    is no tie left to break.
    """
    out: list[str] = []
    for word in TITLE_WORD_RE.findall(title.lower()):
        out.append(word)
        if "-" in word:
            out += [p for p in word.split("-") if len(p) >= 4]
    return out


def is_nameable(word: str, titles: list[str],
                vocabulary: set[str] | None = None) -> bool:
    """Whether `word` may name a topic at all - a term, not a filler word.

    Four ways to qualify, none of them a curated list. Three read the cluster's
    own titles, the fourth reads the vault:

    a) identifier shape - a hyphen, a dot or a digit in the word itself;
    b) capitalised in one of the titles: German capitalises nouns everywhere in
       a sentence and function words nowhere, so this separates `Minecraft` and
       `Orchestrator` from `über` and `ohne` for free;
    c) a component of a hyphenated token in one of the titles - whoever named
       `claude-model-routing` chose those three parts deliberately;
    d) marked by a human somewhere in the vault, in backticks or a wikilink
       (marked_vocabulary).

    Measured against the real vault on 08.08.2026: of the 24 folders under
    `30-topics/`, ten are project branches that never pass through here, and of
    the remaining fourteen this predicate accepts all fourteen and rejects
    exactly one name that exists today - `über`. A single criterion does not
    manage that: requiring the marked vocabulary alone would throw out
    `incident`, `minecraft` and `orchestrator`, because an ordinary German noun
    is never written in backticks.
    """
    if _IDENTIFIER_SHAPE_RE.search(word):
        return True
    if vocabulary and word in vocabulary:
        return True
    for title in titles:
        # The first word of a SENTENCE title is capitalised whatever it is
        # (`Zwei Kurse in einer Rechnung`) - no noun signal there. A short
        # label title (`Minecraft Server`, at most three words) keeps it.
        anfang = len(title) - len(title.lstrip(" \t\"'\u201e*#_([-"))
        satz = len(title.split()) > 3
        for m in TITLE_WORD_RE.finditer(title):
            token = m.group(0)
            if (token.lower() == word and token[0].isupper()
                    and not (satz and m.start() == anfang)):
                return True
            if "-" not in token:
                continue
            for part in token.split("-"):
                if part.lower() == word and len(part) >= 4:
                    return True
    return False


def is_taken(word: str, taken: set[str]) -> bool:
    """`word` names an existing branch or person - itself, in the genitive
    (`des nutzers`), or as a part of a hyphenated branch name. `claude` is not
    a folder, but `claude-setup`, `claude-workbench` and `claude-orchestration`
    are; run of 24.09.2026 built `30-topics/claude/` next to them out of seven
    loosely related notes, and the g4 measurement then proposed `workbench`
    (next to `claude-workbench`) and `des nutzers` (`40-people/person-1.md`).
    A cluster whose best word already names such a thing belongs there."""
    if word in taken or (word.endswith("s") and word[:-1] in taken):
        return True
    return any(word in t.split("-") for t in taken if "-" in t)


def suggest_name(cluster: list[Note], taken: set[str],
                 vocabulary: set[str] | None = None) -> str | None:
    """Most common meaningful word across the titles. None when the cluster has
    no name worth proposing (only generic words, an existing branch name, no
    word that qualifies as a term, or a tie this code will not decide) - an
    unnameable cluster is not actionable, so it is not suggested at all.

    A tie is no longer broken by length. Until 08.08.2026 it was, and the
    shorter word won: German function words are short, so the tiebreak
    preferred exactly the words that mean nothing. `30-topics/über/` is what
    came of it.

    A page that is never created costs a topic nobody had yet. A page named
    after a filler word costs every search it then answers first, because
    CLAUDE.md sends every agent to the topic pages before the notes.
    """
    titles = [n.title for n in cluster]
    words: dict[str, int] = {}
    for title in titles:
        for w in set(title_words(title)):
            if w in STOPWORDS or w in FUNCTION_WORDS:
                continue        # note-type noise / filler: would drown every title
            words[w] = words.get(w, 0) + 1
    if not words:
        return None

    # A branch name among the MOST COMMON words means this cluster belongs to a
    # topic that already exists - so there is no new one to name. Removing such
    # words from the count instead, as this did until 08.08.2026, makes the
    # naming fall through to the next-best word, and the next-best word is
    # usually a filler. Measured the same day over the real vault: fourteen
    # notes about workbench incidents, `worker` five times and `incident` three
    # - both existing topics - would have produced `30-topics/laufende/`, named
    # after an adjective out of a file name.
    top = max(words.values())
    already = sorted(w for w, c in words.items()
                     if c == top and is_taken(w, taken))
    if already:
        log.info("topics: cluster belongs to the existing topic(s) %s - "
                 "no new page", already)
        return None

    candidates = {w: c for w, c in words.items()
                  if c >= 2 and not is_taken(w, taken)
                  and is_nameable(w, titles, vocabulary)}
    if not candidates:
        if words:
            log.info("topics: cluster left unnamed - no word qualifies as a "
                     "term among %s", sorted(words, key=words.get,
                                             reverse=True)[:5])
        return None
    best = max(candidates.values())
    if best < NAME_MIN_SHARE * len(titles):
        # A word in five of 69 titles does not name those 69 notes - it names
        # five of them. Measured 24.09.2026 on the pre-run vault: `konto`
        # 5/69, `workbench` 5/34, `test` 2/11 against `etoro` 3/7, `short`
        # 2/6 and `fehlerform` 5/16 (the old `zwei` was 8/84, `kern` 6/56).
        log.info("topics: cluster left unnamed - best word covers %d of %d "
                 "titles", best, len(titles))
        return None
    front = sorted(w for w, c in candidates.items() if c == best)
    if len(front) > 1:
        log.info("topics: cluster left unnamed - %s are equally common", front)
        return None
    return front[0]


def suggest_hubs(hubs: list[Note], notes: list[Note],
                 vectors: dict[str, list[float]],
                 min_sim: float = config.CLUSTER_MIN_SIM,
                 min_size: int = config.CLUSTER_MIN_SIZE,
                 limit: int = config.MAX_HUB_SUGGESTIONS,
                 taken: set[str] | None = None,
                 ) -> list[tuple[str, list[Note]]]:
    """Disjoint clusters of >= min_size mutually close notes that no hub covers.

    Greedy: biggest cluster first, its members are then off the table, so one
    theme cannot produce a dozen overlapping suggestions. Session notes and
    reports are archives, not themes, and stay out of the pool.
    """
    taken = taken or set()
    vocabulary = marked_vocabulary(notes)
    pool = [n for n in notes
            if n.rel in vectors and n.ntype not in ("report", "asset", "session")]
    clusters = []
    for seed in pool:
        members = [seed] + [n for n in pool
                            if n.rel != seed.rel
                            and cosine(vectors[seed.rel], vectors[n.rel]) >= min_sim]
        if len(members) >= min_size:
            clusters.append(members)
    clusters.sort(key=len, reverse=True)

    assigned: set[str] = set()
    out: list[tuple[str, list[Note]]] = []
    for members in clusters:
        if len(out) >= limit:
            break
        fresh = [n for n in members if n.rel not in assigned]
        if len(fresh) < min_size or _covered(fresh, hubs):
            continue
        double = project_double(fresh)
        if double is not None:
            log.info("topics: cluster of %d notes lies in project %s - it has its own page, "
                     "no second topic", len(fresh), double)
            continue
        name = suggest_name(fresh, taken, vocabulary)
        if name is None:
            continue
        assigned |= {n.rel for n in fresh}
        taken.add(name)
        out.append((name, fresh))
    return out


_TITLE_LINE_RE = re.compile(r"^title:\s*[\"']?(.+?)[\"']?\s*$", re.MULTILINE)


def person_names(vault: Path) -> set[str]:
    """Stems and every word (4+ letters) of the titles of `40-people/*.md`: `person-1` AND
    `the user` (title `the user`). Run of 24.09.2026 proposed `30-topics/the user/`
    because only the stem was known. A hub named after a person is noise."""
    names: set[str] = set()
    people = vault / "40-people"
    if not people.is_dir():
        return names
    for p in people.glob("*.md"):
        names.add(p.stem.lower())
        try:
            head = p.read_text(encoding="utf-8", errors="replace")[:1500]
        except OSError:
            continue
        m = _TITLE_LINE_RE.search(head)
        if m:
            names |= {w for w in (t.lower() for t in TITLE_WORD_RE.findall(m.group(1)))}
    return names


def existing_branch_names(vault: Path) -> set[str]:
    """Project and topic folder names and person names (`40-people`): a hub named
    after one of them is noise."""
    names = set()
    for top in ("20-projects", "30-topics"):
        base = vault / top
        if base.is_dir():
            names |= {d.name.lower() for d in base.iterdir() if d.is_dir()}
    return names | person_names(vault)


def project_double(cluster: list[Note], share: float = config.TOPIC_PROJECT_DOUBLE_SHARE) -> str | None:
    """The project whose folder holds at least `share` of the cluster's notes, or None. Such a
    cluster only doubles that project's own topic page."""
    counts: dict[str, int] = {}
    for n in cluster:
        parts = Path(n.rel).parts
        if len(parts) >= 3 and parts[0] == "20-projects":
            counts[parts[1]] = counts.get(parts[1], 0) + 1
    if not counts or not cluster:
        return None
    proj, hit = max(counts.items(), key=lambda kv: kv[1])
    return proj if hit >= share * len(cluster) else None


def run_topics(hubs: list[Note], notes: list[Note],
               vectors: dict[str, list[float]], writer: VaultWriter,
               queue: ReviewQueue, today: dt.date | None = None) -> TopicResult:
    result = TopicResult()
    result.mocs_updated = update_topic_mocs(hubs, notes, vectors, writer)
    taken = existing_branch_names(writer.vault)
    # Gefundene Cluster werden NICHT mehr als Vorschlag in die Review-Queue
    # gelegt (der Nutzer, 2026-07-29): Themenbereiche sollen automatisch wachsen,
    # nicht auf eine Freigabe warten. Die Synthese-Phase legt die Seite selbst
    # an - `discover_candidates` sieht dieselben Cluster, seit sie ueber den
    # ganzen Vault gebildet werden. Hier bleibt nur die Meldung fuer den Bericht,
    # damit im Report steht, was in diesem Lauf neu entstanden ist.
    for name, cluster in suggest_hubs(hubs, notes, vectors, taken=taken):
        result.hubs_suggested.append((name, [n.rel for n in cluster]))
    return result
