"""`brain ingest`: pull material from OUTSIDE the vault in (file, URL, YouTube,
stdin) and turn it into a source note in `00-sources/`.

Local extraction for files is delegated to gardener's existing `extract`/
`sidecar` modules (PDF, image, Office doc, plain text/code) - this module only
adds the three paths those do not cover: web pages, YouTube subtitles, and
audio/video transcription (`stt`, offline). Everything runs locally; nothing
is ever uploaded. A type nobody can extract still gets a note - metadata plus
a placeholder, never nothing (mirrors gardener/sidecar.py's contract).

Agent-facing only: no progress bars, no interactivity. `--json` is the
contract other agents read.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from gardener import config, frontmatter, sidecar
from gardener import extract as extract_mod
from gardener import contradict as contradict_mod
from gardener.ingest import free_path
from gardener.linking import add_link, cache_key, embed_document
from gardener.ollama import OllamaClient, OllamaError
from gardener.runtime import Deadline
from gardener.store import Store
from gardener.vault import Note, VaultWriter, WIKILINK_RE, key_of, load_notes, parse_note

from . import search as search_mod

log = logging.getLogger("braincli.ingest")

INGEST_LOG_FILE = "_meta/state/ingest-log.jsonl"   # vault-relative, git-tracked
YOUTUBE_HOSTS = ("youtube.com", "youtu.be")
URL_RE = re.compile(r"^https?://", re.IGNORECASE)
URL_FETCH_TIMEOUT = 20
YT_DLP_TIMEOUT = 180
STT_TIMEOUT = 900
FFMPEG_TIMEOUT = 300
MIN_MEDIA_SECONDS = 3.0
RAW_TEXT_CAP_CHARS = 40000          # sanity bound on what we hold in memory
MAX_RELATED = 5
CONTRADICT_DEADLINE_SECONDS = 120


# ---------------------------------------------------------------------------
# ULID (self-contained; mirrors migrate/brain4.py's generator - kept local
# since migrate/ is a separate standalone tool, not an importable dependency)
# ---------------------------------------------------------------------------

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    ts = int(time.time() * 1000)
    value = (ts << 80) | secrets.randbits(80)
    out = [_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5)]
    return "".join(out)


def _slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return (s or "quelle")[:60]


# ---------------------------------------------------------------------------
# Source detection + identity (for dedup)
# ---------------------------------------------------------------------------

def detect_kind(source: str) -> str:
    if source == "-":
        return "stdin"
    if URL_RE.match(source):
        return "youtube" if any(h in source.lower() for h in YOUTUBE_HOSTS) else "url"
    return "file"


def source_identity(source_kind: str, source: str, stdin_text: str = "") -> str:
    """Stable identity string a second run of the SAME source reproduces."""
    if source_kind == "file":
        return str(Path(source).expanduser().resolve())
    if source_kind == "stdin":
        return hashlib.sha256(stdin_text.encode("utf-8")).hexdigest()
    return source.strip().rstrip("/")


def source_hash_of(identity: str) -> str:
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]


def find_duplicate(vault: Path, source_hash: str) -> tuple[str, str] | None:
    """(rel, title) of an existing 00-sources note carrying this source-hash."""
    src_dir = vault / "00-sources"
    if not src_dir.is_dir():
        return None
    for p in sorted(src_dir.glob("*.md")):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fields, _ = frontmatter.parse(text)
        if str(fields.get("source-hash") or "") == source_hash:
            return p.relative_to(vault).as_posix(), str(fields.get("title") or p.stem)
    return None


# ---------------------------------------------------------------------------
# Extraction result
# ---------------------------------------------------------------------------

@dataclass
class ExtractResult:
    content_kind: str            # pdf|image|doc|audio|video|text|unknown|url|youtube|stdin
    summary: str = ""
    extractor: str = ""
    error: str | None = None
    title: str = ""
    # Nicht leer, wenn das Material laenger war als das Verarbeitungsbudget. Steht
    # dann in der Notiz UND im JSON: eine halb eingelesene Quelle, die so aussieht
    # wie eine ganz eingelesene, ist schlimmer als eine, die gar nicht drin ist.
    truncation_note: str = ""


# -- local files (reuses gardener.extract / gardener.sidecar) ---------------

def extract_pdf(client, path: Path) -> ExtractResult:
    text = extract_mod.pdf_text(path)
    if not text:
        return ExtractResult("pdf", error="PDF-Text nicht extrahierbar "
                             "(kein pdftotext/pypdf, oder leeres/gescanntes PDF)")
    summary, trunc = extract_mod.summarize_long(client, text, hint=f"PDF: {path.name}")
    if not summary:
        return ExtractResult("pdf", extractor="pdftotext",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("pdf", summary=summary, truncation_note=trunc, extractor="pdftotext+ollama-judge")


def extract_image(client, path: Path) -> ExtractResult:
    summary = extract_mod.describe_image(client, path)
    if not summary:
        return ExtractResult("image", error="kein lokales Vision-Modell verfuegbar "
                             "oder Bild zu gross")
    return ExtractResult("image", summary=summary, extractor="ollama-vision")


def extract_doc(client, path: Path) -> ExtractResult:
    text = sidecar.doc_text(path)
    if not text:
        return ExtractResult("doc", error="textutil nicht verfuegbar oder Dokument leer")
    summary, trunc = extract_mod.summarize_long(client, text, hint=f"Dokument: {path.name}")
    if not summary:
        return ExtractResult("doc", extractor="textutil",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("doc", summary=summary, truncation_note=trunc, extractor="textutil+ollama-judge")


def extract_text(client, path: Path) -> ExtractResult:
    text = extract_mod.read_text_snippet(path, max_chars=RAW_TEXT_CAP_CHARS)
    if not text.strip():
        return ExtractResult("text", error="Datei leer oder nicht lesbar")
    summary, trunc = extract_mod.summarize_long(client, text, hint=f"Datei: {path.name}")
    if not summary:
        return ExtractResult("text", extractor="read",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("text", summary=summary, truncation_note=trunc, extractor="ollama-judge")


def _media_duration_seconds(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and r.stdout.strip():
            return float(r.stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def transcribe_audio(path: Path, timeout: int = STT_TIMEOUT) -> tuple[str, str | None]:
    if not shutil.which("stt"):
        return "", "stt nicht gefunden (~/.local/bin/stt)"
    duration = _media_duration_seconds(path)
    if duration is not None and duration < MIN_MEDIA_SECONDS:
        return "", f"Material zu kurz ({duration:.1f}s) fuer Transkription"
    try:
        r = subprocess.run(["stt", str(path)], capture_output=True, text=True,
                           timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return "", f"stt fehlgeschlagen: {e}"
    if r.returncode != 0:
        return "", f"stt fehlgeschlagen: {r.stderr.strip()[:300]}"
    return r.stdout.strip(), None


def extract_audio_track(video_path: Path, timeout: int = FFMPEG_TIMEOUT) -> tuple[Path | None, str | None]:
    if not shutil.which("ffmpeg"):
        return None, "ffmpeg nicht gefunden"
    fd, tmp_str = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    tmp = Path(tmp_str)
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", str(tmp)],
            capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        tmp.unlink(missing_ok=True)
        return None, f"ffmpeg fehlgeschlagen: {e}"
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return None, f"ffmpeg fehlgeschlagen: {r.stderr.strip()[:300]}"
    return tmp, None


def extract_audio(client, path: Path) -> ExtractResult:
    transcript, err = transcribe_audio(path)
    if not transcript:
        return ExtractResult("audio", error=err or "keine Transkription")
    summary, trunc = extract_mod.summarize_long(client, transcript, hint=f"Audio-Transkript: {path.name}")
    if not summary:
        return ExtractResult("audio", extractor="stt",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("audio", summary=summary, truncation_note=trunc, extractor="stt+ollama-judge")


def extract_video(client, path: Path) -> ExtractResult:
    audio_path, err = extract_audio_track(path)
    if audio_path is None:
        return ExtractResult("video", error=err or "Tonspur nicht extrahierbar")
    try:
        transcript, err2 = transcribe_audio(audio_path)
    finally:
        audio_path.unlink(missing_ok=True)
    if not transcript:
        return ExtractResult("video", error=err2 or "keine Transkription")
    summary, trunc = extract_mod.summarize_long(client, transcript, hint=f"Video-Transkript: {path.name}")
    if not summary:
        return ExtractResult("video", extractor="ffmpeg+stt",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("video", summary=summary, truncation_note=trunc, extractor="ffmpeg+stt+ollama-judge")


_FILE_DISPATCH = {
    "pdf": extract_pdf, "image": extract_image, "doc": extract_doc,
    "text": extract_text, "audio": extract_audio, "video": extract_video,
}


def extract_file_source(client, path: Path) -> ExtractResult:
    if not path.is_file():
        return ExtractResult("unknown", error=f"Datei nicht gefunden: {path}")
    kind = sidecar.classify(path)
    fn = _FILE_DISPATCH.get(kind)
    if fn is None:
        return ExtractResult("unknown", error="kein lokaler Extraktor fuer diesen Dateityp")
    return fn(client, path)


# -- web page -----------------------------------------------------------------

class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.chunks: list[str] = []
        self.title_chunks: list[str] = []
        self._skip = False
        self._in_title = False

    def handle_starttag(self, tag, attrs) -> None:
        if tag in ("script", "style"):
            self._skip = True
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag) -> None:
        if tag in ("script", "style"):
            self._skip = False
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data) -> None:
        if self._in_title:
            self.title_chunks.append(data)
        elif not self._skip:
            s = data.strip()
            if s:
                self.chunks.append(s)


def fetch_url(url: str, timeout: int = URL_FETCH_TIMEOUT) -> tuple[str, str, str | None]:
    """(text, title, error). Never raises - a fetch failure is a result field."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "brain-ingest/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(RAW_TEXT_CAP_CHARS * 4)
            charset = resp.headers.get_content_charset() or "utf-8"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return "", "", f"URL nicht erreichbar: {e}"
    try:
        html_text = raw.decode(charset, errors="replace")
    except LookupError:
        html_text = raw.decode("utf-8", errors="replace")
    parser = _TextExtractor()
    try:
        parser.feed(html_text)
    except Exception as e:  # malformed markup must not crash the ingest
        return "", "", f"HTML-Parsing fehlgeschlagen: {e}"
    text = "\n".join(parser.chunks)[:RAW_TEXT_CAP_CHARS]
    title = " ".join("".join(parser.title_chunks).split())
    return text, title, None


def extract_url(client, url: str) -> ExtractResult:
    text, title, err = fetch_url(url)
    if err:
        return ExtractResult("url", title=title, error=err)
    if not text.strip():
        return ExtractResult("url", title=title, error="Seite lieferte keinen Text")
    summary, trunc = extract_mod.summarize_long(client, text, hint=f"Webseite: {url}")
    if not summary:
        return ExtractResult("url", title=title, extractor="curl+html-parser",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("url", summary=summary, truncation_note=trunc, extractor="curl+html-parser+ollama-judge",
                         title=title)


# -- YouTube --------------------------------------------------------------------

_VTT_CUE_RE = re.compile(r"^\d+$")
_VTT_TAG_RE = re.compile(r"<[^>]+>")


def vtt_to_text(vtt: str) -> str:
    lines = []
    for raw in vtt.splitlines():
        s = raw.strip()
        if not s or s.upper() == "WEBVTT" or "-->" in s or _VTT_CUE_RE.match(s):
            continue
        if s.startswith(("Kind:", "Language:", "NOTE")):
            continue
        s = _VTT_TAG_RE.sub("", s).strip()
        if s:
            lines.append(s)
    return "\n".join(l for i, l in enumerate(lines) if i == 0 or l != lines[i - 1])


def fetch_youtube(url: str, timeout: int = YT_DLP_TIMEOUT) -> tuple[str, str, str | None]:
    """(text, title, error). Never raises."""
    if not shutil.which("yt-dlp"):
        return "", "", "yt-dlp nicht gefunden"
    with tempfile.TemporaryDirectory() as tmp:
        out_tmpl = str(Path(tmp) / "sub")
        try:
            r = subprocess.run(
                ["yt-dlp", "--skip-download", "--write-auto-subs", "--write-subs",
                 "--sub-langs", "de.*,en.*", "--sub-format", "vtt", "-o", out_tmpl, url],
                capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as e:
            return "", "", f"yt-dlp fehlgeschlagen: {e}"
        if r.returncode != 0:
            return "", "", f"yt-dlp fehlgeschlagen: {r.stderr.strip()[:300]}"
        vtt_files = sorted(Path(tmp).glob("sub*.vtt"))
        if not vtt_files:
            return "", "", "keine Untertitel verfuegbar (weder manuell noch automatisch)"
        text = vtt_to_text(vtt_files[0].read_text(encoding="utf-8", errors="replace"))
        return text[:RAW_TEXT_CAP_CHARS], "", None


def extract_youtube(client, url: str) -> ExtractResult:
    text, title, err = fetch_youtube(url)
    if err:
        return ExtractResult("youtube", title=title, error=err)
    if not text.strip():
        return ExtractResult("youtube", title=title, error="Untertitel waren leer")
    summary, trunc = extract_mod.summarize_long(client, text, hint=f"YouTube-Video: {url}")
    if not summary:
        return ExtractResult("youtube", title=title, extractor="yt-dlp",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("youtube", summary=summary, truncation_note=trunc, extractor="yt-dlp+ollama-judge", title=title)


# -- stdin ------------------------------------------------------------------

def extract_stdin(client, raw_text: str) -> ExtractResult:
    if not raw_text.strip():
        return ExtractResult("stdin", error="stdin war leer")
    summary, trunc = extract_mod.summarize_long(client, raw_text, hint="stdin")
    if not summary:
        return ExtractResult("stdin", extractor="stdin",
                             error="lokales Modell lieferte keine Zusammenfassung")
    return ExtractResult("stdin", summary=summary, truncation_note=trunc, extractor="stdin+ollama-judge")


# ---------------------------------------------------------------------------
# Note text
# ---------------------------------------------------------------------------

def default_title(source_kind: str, source: str, extracted_title: str, today: dt.date) -> str:
    if extracted_title:
        return extracted_title
    if source_kind == "file":
        return Path(source).expanduser().stem
    if source_kind in ("url", "youtube"):
        return source.rstrip("/").rsplit("/", 1)[-1] or source
    return f"Notiz vom {today.isoformat()}"


def free_source_path(vault: Path, title: str, today: dt.date) -> str:
    candidate = free_path(vault / "00-sources" / f"{_slug(title)}.md", set())
    return candidate.relative_to(vault).as_posix()


def build_note_text(*, title: str, source: str, source_kind: str, branch: str,
                    source_hash: str, result: ExtractResult, related: list[dict],
                    today: dt.date, ephemeral: bool = False) -> tuple[str, str]:
    """Returns (text, note_id).

    `ephemeral` marks a provenance that will not survive: the note still records
    where the material was read from, but says so plainly instead of pretending
    the path can be opened again.
    """
    note_id = ulid()
    fields: dict = {
        "id": note_id, "schema": 4, "title": title, "type": "source",
        "branch": branch, "created": today.isoformat(), "source": source,
        "source-kind": source_kind, "source-hash": source_hash, "class": "source",
    }
    if result.extractor:
        fields["extractor"] = result.extractor
    if result.truncation_note:
        fields["truncated"] = result.truncation_note
    if ephemeral:
        fields["source-ephemeral"] = True
    fm_text = frontmatter.render(fields)

    hint = (" — dieser Pfad war temporaer und existiert nicht mehr; die echte "
            "Herkunft steht nicht in der Notiz, weil sie beim Einlesen nicht "
            "mitgegeben wurde (`brain ingest --source`)") if ephemeral else ""
    body_lines = [
        f"Für künftige Sessions: Quelle `{source}` ({source_kind}), "
        f"von brain ingest eingelesen{hint}.",
        "",
    ]
    if result.summary:
        body_lines.append(result.summary.strip())
    else:
        reason = result.error or "kein lokaler Extraktor fuer diesen Typ verfuegbar"
        body_lines.append(
            f"Inhalt nicht automatisch lesbar/zusammenfassbar: {reason}. "
            f"Original bei Bedarf selbst oeffnen: `{source}`.")
    if result.truncation_note:
        body_lines += ["", f"> **Nur teilweise eingelesen** — {result.truncation_note}. "
                           f"Wer die vollstaendige Quelle braucht, oeffnet das Original."]
    if related:
        body_lines.append("")
        body_lines += [f"relates-to [[{r['title']}]]" for r in related]
    body_lines += ["", f"Quelle: `{source}`", "", f"Stand: {today.strftime('%Y-%m')}"]
    text = fm_text + "\n" + "\n".join(body_lines).strip("\n") + "\n"
    return text, note_id


def _note_from_text(vault: Path, rel: str, text: str) -> Note:
    """Like gardener.vault.parse_note, but from in-memory text (dry-run: the
    note has not been written to disk yet)."""
    fm, _body = frontmatter.parse(text)
    title = str(fm.get("title") or "").strip() or Path(rel).stem
    ntype = str(fm.get("type") or "note").strip() or "note"
    links = {key_of(t) for t in WIKILINK_RE.findall(text)}
    return Note(path=vault / rel, rel=rel, title=title, text=text, links=links,
               ntype=ntype, fm=fm)


# ---------------------------------------------------------------------------
# Related notes + backlinks
# ---------------------------------------------------------------------------

def find_related(vault: Path, title: str, summary: str, branch: str | None,
                 k: int = MAX_RELATED) -> list[dict]:
    query = f"{title}\n{summary[:600]}" if summary else title
    if branch:
        query = f"{branch.rsplit('/', 1)[-1]} {query}"
    hits, _used_fallback = search_mod.search(vault, query, k=k)
    return [{"rel": h.rel, "title": h.title, "relation": "relates-to"}
            for h in hits if h.title]


def apply_backlinks(vault: Path, new_note: Note, related: list[dict], write: bool) -> list[str]:
    """Adds `relates-to [[<new note title>]]` to each related note's Relations
    section (the one exception to 'never edit existing notes' - see ingest's
    contract). Returns rels touched (or, in dry-run, that WOULD be touched)."""
    writer = VaultWriter(vault, dry_run=not write)
    touched: list[str] = []
    for r in related:
        existing_path = vault / r["rel"]
        if not existing_path.is_file():
            continue
        existing_note = parse_note(vault, existing_path)
        if add_link(writer, existing_note, new_note, "relates-to", "relations"):
            touched.append(r["rel"])
    return touched


# ---------------------------------------------------------------------------
# Contradiction check
# ---------------------------------------------------------------------------

def _empty_contradiction_result(reason: str | None) -> dict:
    return {"checked": False, "skipped_reason": reason, "pairs_checked": 0,
           "found": 0, "findings": []}


def check_contradictions(vault: Path, new_note: Note, client, write: bool) -> dict:
    try:
        big = client.big_model_loaded()
    except OllamaError as e:
        return _empty_contradiction_result(f"Ollama nicht erreichbar: {e}")
    if big:
        return _empty_contradiction_result(f"48-GB-Regel: {big} geladen - uebersprungen")

    store = Store(config.STATE_DIR / "gardener.db", read_only=not write)
    try:
        vectors = dict(search_mod.load_all_embeddings(store))
        try:
            vec = embed_document(client, new_note.embed_text)
        except OllamaError as e:
            return _empty_contradiction_result(f"Embedding fehlgeschlagen: {e}")
        vectors[new_note.rel] = vec
        if write:
            store.put_embedding(new_note.rel, cache_key(new_note), vec)
    finally:
        store.close()

    all_notes = load_notes(vault)
    by_rel = {n.rel: n for n in all_notes}
    if new_note.rel not in by_rel:
        all_notes = all_notes + [new_note]
        by_rel[new_note.rel] = new_note
    to_check = by_rel[new_note.rel]

    cstore = contradict_mod.ContradictionStore(vault / config.CONTRADICTIONS_FILE)
    deadline = Deadline(CONTRADICT_DEADLINE_SECONDS)
    result = contradict_mod.run_contradict([to_check], all_notes, vectors, client,
                                           cstore, deadline=deadline)

    writer = VaultWriter(vault, dry_run=not write)
    for finding in result.findings:
        a, b = by_rel.get(finding["note_a"]["rel"]), by_rel.get(finding["note_b"]["rel"])
        if a is not None and b is not None:
            contradict_mod.apply_markers(writer, a, b, finding)
    cstore.save(dry_run=not write)
    contradict_mod.write_review_queue(vault, cstore.open_findings(), dry_run=not write)

    return {"checked": True, "skipped_reason": None, "pairs_checked": result.pairs_checked,
           "found": len(result.findings), "findings": result.findings}


# ---------------------------------------------------------------------------
# Log
# ---------------------------------------------------------------------------

def append_log(vault: Path, entry: dict, write: bool) -> str | None:
    if not write:
        return None
    path = vault / INGEST_LOG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path.relative_to(vault).as_posix()


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

EPHEMERAL_PREFIXES = ("/tmp/", "/private/tmp/", "/var/folders/",
                      "/private/var/folders/")


def is_ephemeral(source: str) -> bool:
    """True for a path that will not exist next week.

    A scratchpad path carries a session id and is gone with the session, so as
    provenance it says nothing - measured on the ingested Second-Brain video
    note, whose `source:` pointed at a temp file nobody can ever open again.
    """
    return source.startswith(EPHEMERAL_PREFIXES) or "/scratchpad/" in source


def run_ingest(vault: Path, source: str, *, branch: str | None = None,
              title_override: str | None = None, write: bool = False,
              check_contradict: bool = True, client=None,
              origin: str | None = None,
              stdin_text: str | None = None, today: dt.date | None = None) -> dict:
    vault = Path(vault)
    today = today or dt.date.today()
    client = client or OllamaClient()
    source_kind = detect_kind(source)

    raw_stdin = ""
    if source_kind == "stdin":
        raw_stdin = stdin_text if stdin_text is not None else sys.stdin.read()

    identity = source_identity(source_kind, source, raw_stdin)
    source_hash = source_hash_of(identity)

    dup = find_duplicate(vault, source_hash)
    if dup is not None:
        rel, existing_title = dup
        return {
            "source": source, "kind": source_kind, "content_kind": None,
            "write": write, "dry_run": not write, "duplicate": True,
            "note": rel, "title": existing_title, "branch": None,
            "extracted": None, "extractor": "", "extraction_error": None,
            "related_notes": [], "touched_notes": [],
            "contradictions": _empty_contradiction_result(
                "duplicate - source already ingested"),
            "log": None,
        }

    if source_kind == "file":
        result = extract_file_source(client, Path(source).expanduser())
    elif source_kind == "url":
        result = extract_url(client, source)
    elif source_kind == "youtube":
        result = extract_youtube(client, source)
    else:
        result = extract_stdin(client, raw_stdin)

    title = title_override or default_title(source_kind, source, result.title, today)
    note_branch = branch or "00-sources"

    related = find_related(vault, title, result.summary, branch)
    note_rel = free_source_path(vault, title, today)
    # Gelesen wird aus `source`, vermerkt wird `origin`, wenn der Aufrufer die
    # echte Herkunft kennt (heruntergeladenes Transkript, entpacktes Archiv).
    recorded_source = origin or source
    note_text, _note_id = build_note_text(
        title=title, source=recorded_source, source_kind=source_kind,
        branch=note_branch, source_hash=source_hash, result=result,
        related=related, today=today,
        ephemeral=origin is None and is_ephemeral(source))

    writer = VaultWriter(vault, dry_run=not write)
    writer.write(vault / note_rel, note_text, expect=None)
    new_note = _note_from_text(vault, note_rel, note_text)

    touched = apply_backlinks(vault, new_note, related, write)

    if check_contradict:
        contradictions = check_contradictions(vault, new_note, client, write)
    else:
        contradictions = _empty_contradiction_result("--no-contradict")

    log_entry = {
        "at": dt.datetime.now().isoformat(timespec="seconds"),
        "source": source, "kind": source_kind, "content_kind": result.content_kind,
        "extracted": bool(result.summary), "extractor": result.extractor,
        "note": note_rel, "touched_notes": touched,
        "contradictions_found": contradictions["found"],
    }
    log_rel = append_log(vault, log_entry, write)

    return {
        "source": source, "kind": source_kind, "content_kind": result.content_kind,
        "write": write, "dry_run": not write, "duplicate": False,
        "note": note_rel, "title": title, "branch": note_branch,
        "extracted": bool(result.summary), "extractor": result.extractor,
        "truncated": result.truncation_note or None,
        "extraction_error": result.error, "truncated": result.truncation_note or None,
        "related_notes": related,
        "touched_notes": touched, "contradictions": contradictions, "log": log_rel,
    }
