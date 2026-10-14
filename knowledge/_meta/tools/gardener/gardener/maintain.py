"""Maintenance run: orphan healing, MOC updates, HOT.md regeneration (read-heat
aware, with a resurfacing section), missing recency markers (Stand: YYYY-MM),
plus the generated DECISIONS.md / OPEN-QUESTIONS.md indexes."""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config, frontmatter, heat as heat_mod, orphans as orphans_mod
from .ollama import OllamaError
from .queue import ReviewQueue
from .vault import Note, VaultWriter, STAND_RE, read_text

log = logging.getLogger("gardener")

MOC_START = "<!-- gardener:moc:start -->"
MOC_END = "<!-- gardener:moc:end -->"

# [[Target|alias]] / [[Target]] -> the visible text, for hook lines
WIKILINK_INLINE_RE = re.compile(r"\[\[([^\]|#\n]+)(?:\|[^\]\n]*)?\]\]")

HOT_SYSTEM = (
    "You maintain a personal markdown knowledge vault. Write a dense recent-"
    "context summary (about 300 words, plain markdown, no emoji, German or "
    "English matching the input) of what happened recently, from the git log "
    "and the most recently changed notes. Facts only, no filler."
)


@dataclass
class MaintainResult:
    orphans_queued: list[str] = field(default_factory=list)
    mocs_updated: list[str] = field(default_factory=list)
    hot_updated: bool = False
    hot_degraded: bool = False   # HOT.md written without the local model - see regenerate_hot
    markers_added: list[str] = field(default_factory=list)
    resurfaced: list[str] = field(default_factory=list)
    cold_queued: list[str] = field(default_factory=list)
    decisions_written: list[str] = field(default_factory=list)
    open_questions: int = 0


def _git(vault: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(vault), *args],
                              capture_output=True, text=True, timeout=60).stdout
    except Exception as e:
        log.warning("git %s failed: %s", args, e)
        return ""


def find_orphans(notes: list[Note], vault: Path | None = None) -> list[Note]:
    """Notes that neither point anywhere nor are pointed at.

    `vault` lets the shared definition also read the pointer files that are not
    part of this corpus - INDEX.md, and the `MOC.md` hubs, which gardener
    excludes from its own linking corpus on purpose. Without it, a note that a
    hub page names looked like an orphan and was queued for review on every run
    (measured 2026-07-29 on macos-steam-civ6-damaged-fix.md).
    """
    incoming = orphans_mod.incoming_keys(notes, vault)
    return [n for n in notes
            if not n.links
            and not orphans_mod.is_source_layer(n)
            and n.title_key not in incoming and n.stem_key not in incoming]


def heal_orphans(notes: list[Note], writer: VaultWriter,
                 queue: ReviewQueue | None = None) -> list[str]:
    """Linking already tried to connect everything; leftover orphans go to review."""
    queue = queue or ReviewQueue(writer)
    queued = []
    for n in find_orphans(notes, writer.vault):
        queued.append(n.rel)
        queue.add(f"orphan [[{n.title}]] - keine Links ein/aus, Linking fand "
                  f"keinen Partner", key=f"orphan [[{n.title}]]")
    return queued


def first_hook_line(n: Note) -> str:
    """First real prose line of a note - the hook shown in MOC/DECISIONS lists.

    All frontmatter blocks are stripped, not just the first: Basic-Memory's sync
    prepends its own `permalink:` block, and stripping one block left the hook as
    literally `title: <x>` in every synced note.
    Wikilinks are flattened, so a hook cannot silently link notes the MOC does
    not actually list (which would also mask real moc-gap findings).
    """
    _fm, body = frontmatter.parse(n.text)
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line and not line.startswith(("<!--", "-", "[", "---")):
            return WIKILINK_INLINE_RE.sub(r"\1", line)[:100]
    return ""


def update_mocs(notes: list[Note], writer: VaultWriter) -> list[str]:
    projects: dict[str, list[Note]] = {}
    for n in notes:
        parts = Path(n.rel).parts
        if len(parts) >= 2 and parts[0] == "20-projects":
            projects.setdefault(parts[1], []).append(n)
    updated = []
    for proj, proj_notes in sorted(projects.items()):
        moc_path = writer.vault / "20-projects" / proj / "MOC.md"
        listing = "\n".join(
            f"- [[{n.title}]] - {first_hook_line(n)}"
            for n in sorted(proj_notes, key=lambda x: x.title.lower())
            if n.path != moc_path)
        block = f"{MOC_START}\n{listing}\n{MOC_END}"
        old = None
        if moc_path.exists():
            old = read_text(moc_path)
            new, ok = blocks.replace_block(old, MOC_START, MOC_END, block)
            if not ok:
                # unbalanced markers (hand edit, merge conflict): a regex sub
                # would swallow everything between them. Leave the file alone.
                log.warning("malformed gardener block in 20-projects/%s/MOC.md - "
                            "not rewriting it", proj)
                continue
            if new == old:
                if MOC_START in old:
                    continue                     # block already current
                new = old.rstrip("\n") + f"\n\n## Notes\n{block}\n"
        else:
            new = (f"---\ntitle: {proj} MOC\ntype: note\nbranch: 20-projects/{proj}\n---\n\n"
                   f"# {proj} - Map of Content\n\nKuratierter Einstieg (gardener-gepflegt).\n\n"
                   f"## Notes\n{block}\n")
        if writer.write(moc_path, new, expect=old):
            updated.append(f"20-projects/{proj}/MOC.md")
    return updated


# --- read-heat from transcripts ---------------------------------------------
# A read is a Read tool call on a vault file, or a shell command that prints
# one (cat/sed/head/tail/less/bat/awk/rg over a named file), in a Claude Code
# transcript (config.TRANSCRIPT_DIR) or a Codex session (config.CODEX_SESSION_DIR).
# Same counting rule as _meta/tools/eval/v2-gaertner/nutzung_transkripte.py.
_READ_CMD_RE = re.compile(r"\b(cat|sed|head|tail|less|bat|awk|nl)\b")
_REL_IN_CMD_RE = re.compile(
    r"(?<![\w/.~])((?:00-sources|10-global|20-projects|30-topics|40-people)/[^\s'\"`|;&)]+\.md)")


def _vault_path_re(vault: Path) -> re.Pattern:
    root = vault.expanduser().resolve()
    forms = {str(root)}
    try:
        forms.add("~/" + root.relative_to(Path.home().resolve()).as_posix())
        forms.add("/home/" + Path.home().name + "/" + root.relative_to(Path.home().resolve()).as_posix())
    except ValueError:
        pass
    alt = "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True))
    return re.compile(r"(?:" + alt + r")/([^\s'\"`|;&)]+\.md)")


def _reads_in_call(name: str, arg: str, path_re: re.Pattern) -> list[str]:
    if name == "Read":
        m = path_re.search(arg)
        return [m.group(1)] if m else []
    if not _READ_CMD_RE.search(arg):
        return []
    found = path_re.findall(arg)
    if path_re.pattern and "Knowledge" in arg:
        found += _REL_IN_CMD_RE.findall(arg)
    return found


def _transcript_reads(path: Path, path_re: re.Pattern) -> list[tuple[str, str]]:
    """[(iso timestamp, vault-relative path)] of one transcript file."""
    out: list[tuple[str, str]] = []
    try:
        fh = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return out
    with fh:
        for line in fh:
            if '"tool_use"' not in line and '"CommandExecution"' not in line:
                continue
            if ".md" not in line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = str(obj.get("timestamp") or "")
            calls: list[tuple[str, str]] = []
            content = (obj.get("message") or {}).get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use":
                        inp = c.get("input") or {}
                        calls.append((str(c.get("name")),
                                      str(inp.get("file_path") or inp.get("command") or "")))
            item = (obj.get("payload") or {}).get("item") if isinstance(obj.get("payload"), dict) else None
            if isinstance(item, dict) and item.get("type") == "CommandExecution":
                cmd = item.get("command")
                calls.append(("Bash", " ".join(cmd) if isinstance(cmd, list) else str(cmd or "")))
            for name, arg in calls:
                for rel in dict.fromkeys(_reads_in_call(name, arg, path_re)):
                    if not rel.startswith("secrets/"):
                        out.append((ts, rel))
    return out


def transcript_heat(vault: Path, roots: list[Path] | None = None,
                    days: int | None = None, cache_path: Path | None = None,
                    now: dt.datetime | None = None) -> dict[str, list[dt.datetime]]:
    """{rel: [read timestamps]} from transcripts changed within `days`
    (default: the cold-note horizon). Parsed files are cached by mtime/size,
    so a run only reads transcripts that changed since the last one."""
    roots = roots if roots is not None else [config.TRANSCRIPT_DIR, config.CODEX_SESSION_DIR]
    days = days if days is not None else max(config.HOT_HEAT_DAYS, config.COLD_MONTHS * 31)
    now = now or dt.datetime.now()
    cutoff = (now - dt.timedelta(days=days)).timestamp()
    cache_path = cache_path or (config.STATE_DIR / config.HEAT_TRANSCRIPT_CACHE)
    try:
        cache = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    path_re = _vault_path_re(vault)
    fresh: dict = {}
    heat: dict[str, list[dt.datetime]] = {}
    for root in roots:
        if not root or not Path(root).is_dir():
            continue
        for dirpath, _dirs, files in os.walk(root, followlinks=False):
            for name in files:
                if not name.endswith(".jsonl"):
                    continue
                f = Path(dirpath) / name
                try:
                    st = f.stat()
                except OSError:
                    continue
                if st.st_mtime < cutoff:
                    continue
                key = str(f)
                hit = cache.get(key)
                if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
                    reads = hit[2]
                else:
                    reads = _transcript_reads(f, path_re)
                fresh[key] = [st.st_mtime, st.st_size, reads]
                for ts, rel in reads:
                    stamp = heat_mod._parse_ts(ts.replace("Z", "+00:00")) if ts else None
                    if stamp is not None:
                        heat.setdefault(rel, []).append(stamp)
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(fresh))
    except OSError as e:
        log.warning("transcript heat cache not written: %s", e)
    return heat


def load_read_heat(vault: Path) -> dict[str, list[dt.datetime]]:
    """Hook log plus transcripts (config.HEAT_FROM_TRANSCRIPTS). Both see the
    same reads when the hook fires, so per note and minute the larger of the
    two counts wins instead of their sum."""
    heat = heat_mod.load_heat(vault)
    if not config.HEAT_FROM_TRANSCRIPTS:
        return heat
    try:
        extra = transcript_heat(vault)
    except Exception as e:  # heat is a ranking hint, never worth a failed run
        log.warning("transcript heat unavailable: %s", e)
        return heat
    for rel, stamps in extra.items():
        logged: dict[dt.datetime, int] = {}
        for ts in heat.get(rel, []):
            m = ts.replace(second=0, microsecond=0)
            logged[m] = logged.get(m, 0) + 1
        for ts in stamps:
            m = ts.replace(second=0, microsecond=0)
            if logged.get(m, 0) > 0:
                logged[m] -= 1      # this read is already in the hook log
            else:
                heat.setdefault(rel, []).append(ts)
    return heat


# HOT input by origin (2026-10-10, agenten-kanaele measure 1): notes of world agents
# (`*/agenten/*`, written through a world's carrier that has mail, web and ssh access) and
# external sources (`00-sources/`) never reach HOT - neither the model input nor the lists.
# Origin beats wording: a text filter cannot reliably spot injected instructions, the path
# says who could write. `brain search` still finds these notes.
def hot_input_ok(rel: str) -> bool:
    parts = rel.split("/")
    return parts[0] != "00-sources" and "agenten" not in parts[:-1]


# Superseded notes never reach HOT either (13.10.2026, der Nutzer via the WorkbenchOrchestrator, when
# the chat style was replaced): HOT is loaded at every session start, and a replaced decision there
# only makes agents think about the change. `brain search` still finds them.
def hot_note_ok(n: Note) -> bool:
    return hot_input_ok(n.rel) and str((n.fm or {}).get("status", "")).strip().lower() != "superseded"


def origin(vault: Path, rel: str) -> str:
    """Origin label of a note from its commits, same rule as the recall hook
    (`hooks/auto-recall-format.py`): Weltagent (an `agents:` commit), Mensch (only authors
    other than `<your-github-user>`), else Agent (house agents commit as `<your-github-user>`)."""
    if not hot_input_ok(rel):
        return "Quelle" if rel.startswith("00-sources/") else "Weltagent"
    f = vault / rel
    lines = [z.partition("\t") for z in
             _git(f.parent, "log", "--format=%an%x09%s", "--", f.name).splitlines() if z.strip()]
    if any(subject.startswith("agents:") for _, _, subject in lines):
        return "Weltagent"
    authors = {a for a, _, _ in lines}
    if authors and "<your-github-user>" not in authors:
        return "Mensch (" + ", ".join(sorted(authors)) + ")"
    return "Agent"


def regenerate_hot(notes: list[Note], writer: VaultWriter, client,
                   heat: dict | None = None) -> tuple[bool, list[str], bool]:
    """HOT.md = LLM recent-context summary + read-heat top list + resurfacing.
    Returns (written, resurfaced rels, degraded).

    `degraded` is True when HOT.md was written WITHOUT the local model - either
    because none was passed in, or because Ollama failed while asked for the
    summary. Point 1, 2026-09-02: an Ollama outage used to reach this call as
    an unguarded `client.judge()`, so a judge that stopped answering mid-run
    took down maintain (and, via the same bug, every phase after it) even
    though every other thing maintain does - orphan healing, MOC updates,
    recency markers, the decision/open-question indexes - needs no model at
    all. The LLM summary is a nice-to-have; the plain listing below already
    existed as the fallback for "no client given", it just was not also the
    fallback for "client given but not answering"."""
    vault = writer.vault
    heat = heat if heat is not None else heat_mod.load_heat(vault)
    notes = [n for n in notes if hot_note_ok(n)]
    git_log = "\n".join(
        z for z in _git(vault, "log", "--since=14.days", "--oneline", "--no-merges", "--", ".",
                        ":(exclude)00-sources", ":(glob,exclude)**/agenten/**").splitlines()
        if not z.partition(" ")[2].startswith("agents:"))[:4000]
    recent = sorted(notes, key=heat_mod.mtime_of, reverse=True)[:10]
    hot_read = heat_mod.hottest(notes, heat, k=5)
    recent_txt = "\n\n".join(f"## {n.title} ({n.rel})\n{n.text[:800]}" for n in recent)
    summary = ""
    degraded = client is None
    if client is not None:
        try:
            verdict = client.judge(
                HOT_SYSTEM,
                f"Git log (14 days):\n{git_log or '(empty)'}\n\nRecent notes:\n{recent_txt}\n\n"
                'Answer as JSON: {"summary": "<~300 words markdown>"}')
        except OllamaError as e:
            log.warning("HOT.md summary via judge failed: %s - falling back "
                        "to a plain listing, no model needed", e)
            verdict = {}
            degraded = True
        summary = (verdict.get("summary") or "").strip()
        if not summary:
            degraded = True
    if not summary:
        summary = ("Recent notes:\n" +
                   "\n".join(f"- [[{n.title}]]" for n in recent) +
                   ("\n\nGit (14 days):\n```\n" + git_log.strip() + "\n```" if git_log.strip() else ""))

    parts = [f"---\ntitle: HOT\ntype: note\n---\n\n# HOT - Recent Context\n",
             f"Generated by gardener {dt.date.today().isoformat()}. "
             f"Do not edit by hand.\n",
             summary]
    if hot_read:
        parts.append(f"\n## Meistgelesen ({config.HOT_HEAT_DAYS} Tage)\n" +
                     "\n".join(f"- [[{n.title}]] ({c}x) [Herkunft: {origin(vault, n.rel)}]"
                               for n, c in hot_read))
    resurfaced = heat_mod.resurface(notes, heat)
    if resurfaced:
        parts.append("\n## Vergessene Schaetze\n" +
                     "Lange nicht gelesen, aber substanziell - lohnt einen Blick:\n" +
                     "\n".join(f"- [[{n.title}]] [Herkunft: {origin(vault, n.rel)}] - {first_hook_line(n)}"
                               for n in resurfaced))
    writer.write(vault / "HOT.md", "\n".join(parts) + "\n")
    return True, [n.rel for n in resurfaced], degraded


# Recency marker rule (Auftrag g4, 24.09.2026): `Stand: JJJJ-MM` is the month of
# the last CONTENT change - the newest commit whose diff touches more than
# markers, the gardener's `## Relations` lines and machine-stamped frontmatter.
# `10-global/shared-brain.md` was rewritten on 23./24.09. and still said
# `Stand: 2026-07`, because the marker was only ever ADDED, never moved.
MARKER_LINE_RE = re.compile(r"^Stand:\s*(\d{4}-\d{2})\s*$", re.MULTILINE)
FM_STAND_RE = re.compile(r"^stand:\s*[\"']?(\d{4}-\d{2})[\"']?\s*$", re.MULTILINE)
_TRIVIAL_LINE_RE = re.compile(
    r"^\s*$"                                   # blank
    r"|^---\s*$"                               # frontmatter fence
    r"|^Stand:\s*\d{4}-\d{2}\s*$"              # the marker itself
    r"|^## Relations\s*$"
    r"|^\s*(?:- )?(?:relates-to|depends-on|supersedes|part-of|contradicts) \[\["
    r"|^(?:id|schema|permalink|stand|owner):")  # stamped by gate/sync/owner


def content_month(repo_file: Path) -> str | None:
    """`JJJJ-MM` of the newest commit that changed `repo_file` substantively
    (see _TRIVIAL_LINE_RE), asked in the repo that holds the file - vault
    root or a mounted space. None when git knows no such commit."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_file.parent), "log", "--format=%x01%as",
             "-p", "--no-color", "--unified=0", "--no-ext-diff", "--",
             repo_file.name],
            capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("git log for %s failed: %s", repo_file, e)
        return None
    for chunk in out.split("\x01")[1:]:
        date, _, diff = chunk.partition("\n")
        for line in diff.splitlines():
            if not line or line[0] not in "+-":
                continue
            if line.startswith(("+++ ", "--- ")):
                continue                        # file header, not content
            if not _TRIVIAL_LINE_RE.match(line[1:]):
                return date.strip()[:7] or None
    return None


def _last_commit_month(repo_file: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_file.parent), "log", "-1", "--format=%as",
             "--", repo_file.name],
            capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out[:7] or None


def refresh_marker_text(text: str, month: str) -> str:
    """Move every OWN marker that is older than `month` forward: the
    frontmatter field `stand:` and standalone `Stand: JJJJ-MM` lines. Never
    backwards, never a second marker, prose like "(Stand: 2026-07)" untouched."""
    fm_end = -1
    if text.startswith("---\n"):
        fm_end = text.find("\n---", 4)

    def bump(m: re.Match) -> str:
        return m.group(0).replace(m.group(1), month) if m.group(1) < month else m.group(0)

    if fm_end > 0:
        head, tail = text[:fm_end], text[fm_end:]
        head = FM_STAND_RE.sub(bump, head)
        tail = MARKER_LINE_RE.sub(bump, tail)
        return head + tail
    return MARKER_LINE_RE.sub(bump, text)


def _own_markers(text: str) -> list[str]:
    fm_end = text.find("\n---", 4) if text.startswith("---\n") else -1
    found = MARKER_LINE_RE.findall(text[max(fm_end, 0):])
    if fm_end > 0:
        found += FM_STAND_RE.findall(text[:fm_end])
    return found


def add_recency_markers(notes: list[Note], writer: VaultWriter) -> list[str]:
    """Adds a missing marker and moves an outdated one (see MARKER_LINE_RE).
    Returns the rels that changed."""
    added = []
    for n in notes:
        # session notes are an immutable archive (INDEX.md); reports are transient
        if n.ntype in ("session", "report"):
            continue
        # KERN.md is injected into every session start and kept under ~3 000
        # characters; its dated `## Stand` section already says how current it is
        if n.path.name == "KERN.md":
            continue
        own = _own_markers(n.text)
        if own:
            oldest_ok = min(own)
            last = _last_commit_month(n.path)
            # cheap filter first: without any commit newer than the marker
            # there is nothing to move
            if last is None or last <= oldest_ok:
                continue
            month = content_month(n.path)
            if month is None or month <= oldest_ok:
                continue
            new_text = refresh_marker_text(n.text, month)
            if new_text == n.text:
                continue
        elif STAND_RE.search(n.text):
            continue                # a marker in prose only: a human's, leave it
        else:
            month = (content_month(n.path) or _last_commit_month(n.path)
                     or dt.date.today().strftime("%Y-%m"))
            new_text = n.text.rstrip("\n") + f"\n\nStand: {month}\n"
        if not writer.write(n.path, new_text, expect=n.text):
            continue
        n.text = new_text
        added.append(n.rel)
    return added


def run_maintenance(notes: list[Note], writer: VaultWriter, client,
                    queue: ReviewQueue | None = None,
                    heat: dict | None = None,
                    today: dt.date | None = None) -> MaintainResult:
    from . import indexes  # local import: indexes builds on this module

    today = today or dt.date.today()
    queue = queue or ReviewQueue(writer)
    heat = heat if heat is not None else heat_mod.load_heat(writer.vault)
    r = MaintainResult()
    # before any write: add_recency_markers rewrites files and would reset the
    # mtime that cold_notes falls back on for never-read notes
    cold = heat_mod.cold_notes(notes, heat)
    r.orphans_queued = heal_orphans(notes, writer, queue)
    r.mocs_updated = update_mocs(notes, writer)
    r.hot_updated, r.resurfaced, r.hot_degraded = regenerate_hot(notes, writer, client, heat)
    r.markers_added = add_recency_markers(notes, writer)
    r.decisions_written = indexes.update_decisions(notes, writer, today)
    _changed, r.open_questions = indexes.update_open_questions(notes, writer, today)
    # capped: the health report lists all cold notes, the queue only the top few
    for n in cold[:config.COLD_QUEUE_MAX]:
        if queue.add(f"lange nicht gelesen: [[{n.title}]] - seit >"
                     f"{config.COLD_MONTHS} Monaten kein Zugriff, noch relevant?",
                     key=f"lange nicht gelesen: [[{n.title}]]", today=today):
            r.cold_queued.append(n.rel)
    return r
