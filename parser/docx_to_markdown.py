"""
Phase 1 — Document Conversion (DOCX -> Markdown).

Walks the DOCX body in document order (paragraphs + tables) and emits
Markdown that preserves:
  - heading hierarchy (Word "Heading N" styles -> "#"..."######")
  - lists (bulleted / numbered paragraph styles -> "-")
  - tables (-> GitHub-flavored Markdown tables)
  - bold/italic formatting on runs (key terms)
  - paragraph structure and original case
  - page numbers, via Word's <w:lastRenderedPageBreak/> markers, emitted
    as HTML comments: <!-- page: N -->

No AI/LLM is used in this stage.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _iter_block_items(parent):
    """Yield paragraphs and tables in document order."""
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def _heading_level(style_name: str) -> int | None:
    if not style_name:
        return None
    m = re.match(r"^Heading\s*(\d+)$", style_name.strip(), re.IGNORECASE)
    if m:
        return min(int(m.group(1)), 6)
    if style_name.strip().lower() in ("title",):
        return 1
    return None


ROMAN_RE = re.compile(r"^\**([IVXLCDM]{1,6})\**\.\**\s+(.*)$")
NUMERIC_RE = re.compile(r"^\**(\d+(?:\.\d+){0,4})\.\**\s+(\S.*)$")


def _strip_md_markup(text: str) -> str:
    return re.sub(r"\*+", "", text)


def _numbering_heading_level(text: str) -> int | None:
    """
    This document has no Word heading styles; chapter/section/subsection
    headings are only distinguishable by their numeric/roman numbering
    prefix (e.g. "II. TITLE", "2.1. Title", "2.1.1. TITLE").
    Numbered *list* items in this document use a closing paren ("1)") so
    they don't collide with this pattern.
    """
    plain = _strip_md_markup(text).strip()
    m = ROMAN_RE.match(plain)
    if m:
        title = m.group(2).strip()
        if title and len(title) < 80:
            return 1
        return None
    m = NUMERIC_RE.match(plain)
    if m:
        depth = m.group(1).count(".") + 1
        title = m.group(2).strip()
        if title and len(title) < 120:
            return min(depth, 4)
    return None


def _is_list_paragraph(paragraph: Paragraph) -> bool:
    style_name = (paragraph.style.name or "") if paragraph.style else ""
    if "list" in style_name.lower():
        return True
    pPr = paragraph._p.find(qn("w:pPr"))
    if pPr is not None and pPr.find(qn("w:numPr")) is not None:
        return True
    return False


def _run_to_md(run) -> str:
    text = run.text
    if text is None or text == "":
        return ""
    # preserve leading/trailing spaces outside markers
    lead = len(text) - len(text.lstrip(" "))
    trail = len(text) - len(text.rstrip(" "))
    core = text.strip(" ")
    if core == "":
        return text
    if run.bold and run.italic:
        core = f"***{core}***"
    elif run.bold:
        core = f"**{core}**"
    elif run.italic:
        core = f"*{core}*"
    return (" " * lead) + core + (" " * trail)


def _paragraph_page_breaks_and_text(paragraph: Paragraph):
    """
    Returns list of tokens in order: either ('page',) marker or ('text', str).
    Detects <w:lastRenderedPageBreak/> (Word's cached pagination marks) inside
    runs, which is the closest available signal to true page numbers in a
    reflowable DOCX.
    """
    tokens = []
    buf = []
    for run in paragraph.runs:
        r_el = run._r
        for child in r_el.iter():
            tag = child.tag
            if tag == qn("w:lastRenderedPageBreak"):
                if buf:
                    tokens.append(("text", "".join(buf)))
                    buf = []
                tokens.append(("page",))
            elif tag == qn("w:br") and child.get(qn("w:type")) == "page":
                if buf:
                    tokens.append(("text", "".join(buf)))
                    buf = []
                tokens.append(("page",))
            elif tag == qn("w:t"):
                # apply run formatting to this text node's content
                pass
        rendered = _run_to_md(run)
        if rendered:
            buf.append(rendered)
    if buf:
        tokens.append(("text", "".join(buf)))
    return tokens


def _table_to_md(table: Table) -> str:
    rows = []
    for row in table.rows:
        cells = [c.text.strip().replace("\n", "<br>").replace("|", "\\|") for c in row.cells]
        rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = []
    header, body = rows[0], rows[1:]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---"] * width) + " |")
    for r in body:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


def convert(docx_path: Path) -> str:
    doc = Document(str(docx_path))
    out_lines: list[str] = []
    page = 1
    out_lines.append(f"<!-- page: {page} -->")

    for block in _iter_block_items(doc):
        if isinstance(block, Paragraph):
            style_name = (block.style.name or "") if block.style else ""
            style_level = _heading_level(style_name)
            tokens = _paragraph_page_breaks_and_text(block)

            text_parts = []
            for tok in tokens:
                if tok[0] == "page":
                    page += 1
                    if text_parts:
                        out_lines.append("".join(text_parts).strip())
                        text_parts = []
                    out_lines.append(f"<!-- page: {page} -->")
                else:
                    text_parts.append(tok[1])
            text = "".join(text_parts).strip()

            if not text:
                continue

            level = style_level or _numbering_heading_level(text)

            if level:
                out_lines.append(f"\n{'#' * level} {text}\n")
            elif _is_list_paragraph(block):
                out_lines.append(f"- {text}")
            else:
                out_lines.append(text)
        elif isinstance(block, Table):
            md_table = _table_to_md(block)
            if md_table:
                out_lines.append("\n" + md_table + "\n")

    return "\n".join(out_lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Convert DOCX rulebook to Markdown (Phase 1)")
    ap.add_argument("docx", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    out_path = args.output or args.docx.with_suffix(".md")
    md = convert(args.docx)
    out_path.write_text(md, encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
