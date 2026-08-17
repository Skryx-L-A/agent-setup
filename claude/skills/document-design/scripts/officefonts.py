"""officefonts.py — embed TTF fonts into a .docx or .pptx after python-docx/python-pptx
has saved it. Neither library supports font embedding; this is direct OOXML package
surgery, run once as a post-processing step on the saved file.

Shared across templates/office-report and templates/office-deck the same way
scripts/check-fonts.sh is shared across the Typst templates: format-specific mechanics
that are not part of any one document's content.

--- DOCX: verified working (2026-07-29) ---
Word/Writer obfuscate embedded font bytes: the first 32 bytes are XORed with a 16-byte
GUID key, byte i against key[15 - (i % 16)] — the REVERSED index, not the direct one.
This is undocumented in the public ECMA-376 text and was confirmed here empirically:
building a .docx with a plain (non-reversed) XOR produced a file LibreOffice opened by
silently falling back to Liberation Serif; the reversed-index version round-tripped
through `soffice --headless --convert-to pdf` with the real embedded face
(`pdffonts` reported `ArchivoRoman-Regular`/`-Bold`, both `emb=yes`, no fallback), bold
rendered as the drawn bold instance, not synthesised. See fontembed test in this
project's build log.

--- PPTX: implemented per spec, NOT verified the same way ---
The embeddedFontLst/embeddedFont/regular structure below matches the presentationml
schema and needs no obfuscation (PPTX embeds raw font bytes, unlike DOCX). But
LibreOffice Impress does not appear to consume externally-embedded pptx fonts on
import: the identical mechanism that made the DOCX case pass produced no change in
Impress's rendering — `pdffonts` on the converted PDF still showed a system fallback
even though presentation.xml, its rels, and the font part were all structurally correct
and equivalent to the working DOCX case. This means docrender's font-fallback check,
which goes through the same soffice conversion, cannot confirm a pptx font embedded
correctly — a finding worth treating with the same suspicion as its two known
false-positive shapes (see reference/antipatterns.md). Real Microsoft PowerPoint is the
only confirmation path left untested here.
"""

from __future__ import annotations

import re
import shutil
import uuid
import zipfile
from pathlib import Path


def _obfuscate(data: bytes, guid: str) -> bytes:
    key = uuid.UUID(guid).bytes_le
    out = bytearray(data)
    for i in range(32):
        out[i] ^= key[15 - (i % 16)]
    return bytes(out)


def embed_fonts_docx(docx_path: str, fonts: list[dict]) -> None:
    """fonts: [{"family": "Archivo", "regular": "fonts/Archivo-Regular.ttf",
                "bold": "fonts/Archivo-Bold.ttf"}, ...]  ("bold" optional)
    Rewrites docx_path in place."""
    path = Path(docx_path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    shutil.copyfile(path, tmp)

    zin = zipfile.ZipFile(tmp, "r")
    names = zin.namelist()
    content_types = zin.read("[Content_Types].xml").decode("utf-8")
    settings = zin.read("word/settings.xml").decode("utf-8")
    font_table = zin.read("word/fontTable.xml").decode("utf-8")
    others = {
        n: zin.read(n)
        for n in names
        if n not in ("[Content_Types].xml", "word/settings.xml", "word/fontTable.xml")
    }
    zin.close()

    if 'Extension="fntdata"' not in content_types:
        content_types = content_types.replace(
            "</Types>",
            '<Default Extension="fntdata" ContentType="application/x-font-data"/></Types>',
        )

    if "embedTrueTypeFonts" not in settings:
        settings = re.sub(
            r"(<w:settings[^>]*>)",
            r'\1<w:embedTrueTypeFonts w:val="true"/><w:saveSubsetFonts w:val="true"/>',
            settings,
            count=1,
        )

    rels_entries: list[str] = []
    font_parts: dict[str, bytes] = {}
    entries: list[str] = []
    part_n = 0
    for spec in fonts:
        family = spec["family"]
        slots = [("embedRegular", spec["regular"])]
        if spec.get("bold"):
            slots.append(("embedBold", spec["bold"]))
        if spec.get("italic"):
            slots.append(("embedItalic", spec["italic"]))
        if spec.get("bold_italic"):
            slots.append(("embedBoldItalic", spec["bold_italic"]))

        slot_xml = []
        for slot, ttf_path in slots:
            part_n += 1
            rid = f"rIdFont{part_n}"
            guid = "{" + str(uuid.uuid4()).upper() + "}"
            data = Path(ttf_path).read_bytes()
            font_parts[f"word/fonts/font{part_n}.fntdata"] = _obfuscate(data, guid)
            slot_xml.append(f'<w:{slot} r:id="{rid}" w:fontKey="{guid}"/>')
            rels_entries.append(
                f'<Relationship Id="{rid}" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" '
                f'Target="fonts/font{part_n}.fntdata"/>'
            )
        entries.append(f'<w:font w:name="{family}">' + "".join(slot_xml) + "</w:font>")

    font_table = font_table.replace("</w:fonts>", "".join(entries) + "</w:fonts>")
    font_table_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(rels_entries)
        + "</Relationships>"
    )

    zout = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED)
    zout.writestr("[Content_Types].xml", content_types)
    zout.writestr("word/settings.xml", settings)
    zout.writestr("word/fontTable.xml", font_table)
    for n, data in others.items():
        zout.writestr(n, data)
    zout.writestr("word/_rels/fontTable.xml.rels", font_table_rels)
    for part_name, data in font_parts.items():
        zout.writestr(part_name, data)
    zout.close()
    tmp.unlink()


def embed_fonts_pptx(pptx_path: str, fonts: list[dict]) -> None:
    """fonts: [{"family": "Archivo", "regular": "fonts/Archivo-Regular.ttf",
                "bold": "fonts/Archivo-Bold.ttf"}, ...]  ("bold" optional)
    Spec-correct (see module docstring for the unverified caveat). Rewrites in place."""
    path = Path(pptx_path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    shutil.copyfile(path, tmp)

    zin = zipfile.ZipFile(tmp, "r")
    names = zin.namelist()
    content_types = zin.read("[Content_Types].xml").decode("utf-8")
    pres_xml = zin.read("ppt/presentation.xml").decode("utf-8")
    pres_rels = zin.read("ppt/_rels/presentation.xml.rels").decode("utf-8")
    others = {
        n: zin.read(n)
        for n in names
        if n
        not in (
            "[Content_Types].xml",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
        )
    }
    zin.close()

    if 'Extension="fntdata"' not in content_types:
        content_types = content_types.replace(
            "</Types>",
            '<Default Extension="fntdata" ContentType="application/x-font-ttf"/></Types>',
        )

    existing_ids = re.findall(r'Id="rId(\d+)"', pres_rels)
    next_id = 1 + max((int(i) for i in existing_ids), default=0)

    font_parts: dict[str, bytes] = {}
    embed_entries: list[str] = []
    rels_entries: list[str] = []
    part_n = 0
    for spec in fonts:
        family = spec["family"]
        slots = [("regular", "p:regular", spec["regular"])]
        if spec.get("bold"):
            slots.append(("bold", "p:bold", spec["bold"]))
        slot_xml = []
        for _label, tag, ttf_path in slots:
            part_n += 1
            rid = f"rId{next_id}"
            next_id += 1
            part_name = f"fonts/font{part_n}.fntdata"
            font_parts[f"ppt/{part_name}"] = Path(ttf_path).read_bytes()
            slot_xml.append(f'<{tag} r:id="{rid}"/>')
            rels_entries.append(
                f'<Relationship Id="{rid}" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" '
                f'Target="{part_name}"/>'
            )
        embed_entries.append(
            f'<p:embeddedFont><p:font typeface="{family}"/>' + "".join(slot_xml) + "</p:embeddedFont>"
        )

    pres_rels = pres_rels.replace("</Relationships>", "".join(rels_entries) + "</Relationships>")

    if "embedTrueTypeFonts" not in pres_xml:
        pres_xml = re.sub(r"(<p:presentation )", r'\1embedTrueTypeFonts="1" ', pres_xml, count=1)

    embedded_font_lst = "<p:embeddedFontLst>" + "".join(embed_entries) + "</p:embeddedFontLst>"
    if "<p:notesSz" not in pres_xml:
        raise RuntimeError("ppt/presentation.xml has no <p:notesSz> to anchor embeddedFontLst after")
    pres_xml = re.sub(r"(<p:notesSz[^/]*/>)", r"\1" + embedded_font_lst, pres_xml, count=1)

    zout = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED)
    zout.writestr("[Content_Types].xml", content_types)
    zout.writestr("ppt/presentation.xml", pres_xml)
    zout.writestr("ppt/_rels/presentation.xml.rels", pres_rels)
    for n, data in others.items():
        zout.writestr(n, data)
    for part_name, data in font_parts.items():
        zout.writestr(part_name, data)
    zout.close()
    tmp.unlink()
