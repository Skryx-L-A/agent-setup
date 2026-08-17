"""Local content extraction for assets: PDF text, image description, summaries.

Everything runs on this machine (pdftotext / pypdf / Ollama). Nothing is ever
uploaded. Every function degrades to "" or None instead of raising, so a missing
tool or model only costs a placeholder plus a review-queue entry.
"""
from __future__ import annotations

import base64
import logging
import mimetypes
import shutil
import subprocess
from pathlib import Path

from . import config
from .ollama import OllamaError, OllamaUnavailable

log = logging.getLogger("gardener")

PDF_PAGES = 8
PDF_MAX_CHARS = 6000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

SUMMARY_SYSTEM = (
    "You summarize a document for a personal markdown knowledge vault. "
    "Answer ONLY with JSON: {\"summary\": \"<4-8 dense sentences, German, no "
    "filler, facts only: what the document is, what it contains, what it is "
    "good for>\"}."
)

IMAGE_PROMPT = (
    "Beschreibe dieses Bild fuer eine Wissensdatenbank: was ist zu sehen, "
    "welche Information traegt es (Text, Diagramm, Screenshot, Foto)? "
    "4-6 dichte Saetze, Deutsch, keine Floskeln."
)


def mime_of(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def pdf_text(path: Path, max_chars: int = PDF_MAX_CHARS) -> str:
    """First pages of a PDF as plain text. "" when no extractor is available."""
    if shutil.which("pdftotext"):
        try:
            r = subprocess.run(
                ["pdftotext", "-l", str(PDF_PAGES), "-q", str(path), "-"],
                capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout[:max_chars]
        except (OSError, subprocess.SubprocessError) as e:
            log.warning("pdftotext failed on %s: %s", path.name, e)
    try:
        import pypdf  # optional dependency
    except ImportError:
        return ""
    try:
        reader = pypdf.PdfReader(str(path))
        out = "\n".join((p.extract_text() or "")
                        for p in reader.pages[:PDF_PAGES])
        return out[:max_chars]
    except Exception as e:  # corrupt/encrypted PDF
        log.warning("pypdf failed on %s: %s", path.name, e)
        return ""


def summarize(client, text: str, hint: str = "") -> str:
    """Local summary of extracted text via the judge model. "" on failure."""
    if client is None or not text.strip():
        return ""
    try:
        verdict = client.judge(
            SUMMARY_SYSTEM,
            f"{hint}\n\n---\n{text[:PDF_MAX_CHARS]}\n---\n\nSummarize.")
    except OllamaUnavailable:
        raise                              # Ollama is gone: abort the run
    except OllamaError as e:
        log.warning("summary failed: %s", e)
        return ""
    return str(verdict.get("summary") or "").strip()


# Wie viel Text in EINEN Judge-Aufruf geht, und wie viele Aufrufe ein einzelnes
# Material hoechstens kosten darf. 12 Abschnitte * 6000 Zeichen = 72k Zeichen, also
# ein knapp einstuendiges Transkript oder ein mittleres PDF. Darueber wird gekuerzt
# und das ehrlich vermerkt, statt stillschweigend nur den Anfang zu nehmen.
LONG_CHUNK_CHARS = 6000
LONG_MAX_CHUNKS = 12


def _split_chunks(text: str, chunk_chars: int) -> list[str]:
    """Splittet an Absatzgrenzen, nicht mitten im Satz."""
    paras = text.split("\n\n")
    chunks, cur = [], ""
    for para in paras:
        if len(cur) + len(para) + 2 > chunk_chars and cur:
            chunks.append(cur)
            cur = para
        else:
            cur = f"{cur}\n\n{para}" if cur else para
        # Ein einzelner Absatz, der laenger ist als ein Abschnitt, wird hart geteilt.
        while len(cur) > chunk_chars:
            chunks.append(cur[:chunk_chars])
            cur = cur[chunk_chars:]
    if cur.strip():
        chunks.append(cur)
    return chunks


def summarize_long(client, text: str, hint: str = "",
                   chunk_chars: int = LONG_CHUNK_CHARS,
                   max_chunks: int = LONG_MAX_CHUNKS) -> tuple[str, str]:
    """Zusammenfassung ueber langes Material. Gibt (zusammenfassung, hinweis) zurueck.

    `summarize()` schneidet bei 6000 Zeichen ab. Fuer einen Sidecar ("was ist diese
    Datei") reicht das; fuer einen Ingest nicht: ein 49k-Zeichen-Transkript waere zu
    12 Prozent eingelesen und zu 88 Prozent verloren, ohne dass es jemand merkt.
    Deshalb hier abschnittsweise zusammenfassen und die Zusammenfassungen noch einmal
    verdichten. Kostet einen Judge-Aufruf je Abschnitt plus einen - das ist der Preis
    dafuer, dass "eingelesen" auch eingelesen heisst.

    Der Hinweis ist leer, wenn alles verarbeitet wurde, sonst nennt er die Kuerzung.
    """
    if client is None or not text.strip():
        return "", ""
    if len(text) <= chunk_chars:
        return summarize(client, text, hint), ""

    chunks = _split_chunks(text, chunk_chars)
    note = ""
    if len(chunks) > max_chunks:
        done = max_chunks * chunk_chars
        note = (f"gekuerzt: {max_chunks} von {len(chunks)} Abschnitten verarbeitet "
                f"(~{done} von {len(text)} Zeichen)")
        chunks = chunks[:max_chunks]

    parts = []
    for i, chunk in enumerate(chunks, 1):
        piece = summarize(client, chunk, hint=f"{hint} (Abschnitt {i}/{len(chunks)})")
        if piece:
            parts.append(piece)
    if not parts:
        return "", note
    if len(parts) == 1:
        return parts[0], note

    joined = "\n\n".join(parts)
    final = summarize(client, joined,
                      hint=f"{hint} - Verdichtung aus {len(parts)} Abschnittszusammenfassungen")
    return (final or joined), note


def vision_available(client) -> bool:
    """Vision model pulled AND the 48-GB rule satisfied (no big model loaded)."""
    if client is None:
        return False
    try:
        if client.big_model_loaded():
            log.warning("48-GB rule: big model loaded - skipping vision")
            return False
    except OllamaError:
        return False
    return client.has_model(config.VISION_MODEL)


def describe_image(client, path: Path) -> str:
    """Local image description. "" when no vision model is usable."""
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    if size > config.MAX_VISION_BYTES:
        # base64 of a 50-MB photo is a 67-MB request body: the vision model
        # would stall the whole run. Leave it to a human instead.
        log.warning("image too large for local vision (%.1f MB): %s",
                    size / 1024**2, path.name)
        return ""
    if not vision_available(client):
        return ""
    try:
        b64 = base64.b64encode(path.read_bytes()).decode()
        return client.describe_image(b64, IMAGE_PROMPT)
    except OllamaUnavailable:
        raise                              # Ollama is gone: abort the run
    except (OSError, OllamaError) as e:
        log.warning("vision failed on %s: %s", path.name, e)
        return ""


def read_text_snippet(path: Path, max_chars: int = PDF_MAX_CHARS) -> str:
    """First `max_chars` of a plain-text file. "" if it cannot be read."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    except OSError:
        return ""


def describe_file(client, path: Path) -> tuple[str, str]:
    """(description, kind) for any dropped file. kind is one of
    pdf | image | text | unknown; an empty description means: needs a human."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        text = pdf_text(path)
        return summarize(client, text, hint=f"PDF: {path.name}"), "pdf"
    if is_image(path):
        return describe_image(client, path), "image"
    if suffix in (".txt", ".csv", ".log", ".json", ".yaml", ".yml"):
        text = read_text_snippet(path)
        if not text:
            return "", "text"
        return summarize(client, text, hint=f"Datei: {path.name}"), "text"
    return "", "unknown"
