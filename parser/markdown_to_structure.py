"""
Phase 2 — Structural Parsing (Markdown -> hierarchical document model).

Pure heuristic parser, no AI/LLM involved. Produces a tree of nodes:

    Document -> Chapter -> Section -> Subsection -> (Rule | Table | Note)

Each node has: id, parent, type, section path, page, raw content.

This is the JSON contract handed off to the Cloudflare Workers pipeline,
which performs Phase 3 (semantic unit detection / splitting) onward using
an LLM.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

PAGE_RE = re.compile(r"^<!--\s*page:\s*(\d+)\s*-->$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
TABLE_ROW_RE = re.compile(r"^\|.*\|$")

# Chapter = level 1 heading, Section = level 2, Subsection = level 3+
LEVEL_TYPE = {1: "chapter", 2: "section", 3: "subsection", 4: "subsection"}


@dataclass
class Node:
    id: str
    type: str
    parent: str | None
    page: int
    path: list[str] = field(default_factory=list)
    content: str = ""
    children: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "parent": self.parent,
            "page": self.page,
            "path": self.path,
            "content": self.content.strip(),
            "children": self.children,
        }


class IdCounter:
    def __init__(self):
        self._counts: dict[str, int] = {}

    def next(self, node_type: str) -> str:
        self._counts[node_type] = self._counts.get(node_type, 0) + 1
        return f"{node_type.upper()}-{self._counts[node_type]:05d}"


NUMBERED_RULE_RE = re.compile(r"^\s*\d+(\.\d+)*[\.\)]\s+\S")

# Split structural leaf nodes if they grow too large, so downstream semantic
# unit detection stays within a reasonable verbatim-extraction budget.
MAX_TABLE_ROWS = 30
MAX_TABLE_CHARS = 4000
MAX_RULE_CHARS = 4000

# Pseudo-level for group nodes on the heading stack. Higher than any real
# heading level (1-6) so that any new heading pops all groups off the stack.
# Nested groups get incrementing levels (GROUP_LEVEL, GROUP_LEVEL+1, ...) so
# a child group is deeper than its parent group on the stack.
GROUP_LEVEL = 99


def _is_list_start(text: str) -> bool:
    """True if the line looks like the start of a list item (bold, numbered, or bullet)."""
    text = text.strip()
    if text.startswith("**"):
        return True
    if NUMBERED_RULE_RE.match(text):
        return True
    if text.startswith(("- ", "+ ", "\u2022 ")):
        return True
    return False


def _peek_next_non_empty(lines: list[str], start: int) -> str | None:
    """Return the next non-empty stripped line after index `start`, or None."""
    for j in range(start, len(lines)):
        t = lines[j].strip()
        if t:
            return t
    return None


def parse(markdown_text: str) -> dict:
    ids = IdCounter()
    nodes: dict[str, Node] = {}

    doc_id = ids.next("document")
    nodes[doc_id] = Node(id=doc_id, type="document", parent=None, page=1, path=[])

    # stack of (level, node_id) for chapter/section/subsection headings
    heading_stack: list[tuple[int, str]] = [(0, doc_id)]
    current_page = 1
    current_leaf_id: str | None = None  # accumulates paragraph text into a node
    pending_table_lines: list[str] = []
    # True while we're appending list items into a colon-introduced parent leaf.
    in_list_after_intro = False

    def parent_of_new_block() -> str:
        return heading_stack[-1][1]

    def last_rule_leaf_of_parent() -> str | None:
        """Return the id of the last rule/note child of the current heading, or None."""
        pid = parent_of_new_block()
        for cid in reversed(nodes[pid].children):
            if nodes[cid].type in ("rule", "note"):
                return cid
        return None

    def ends_with_list_intro(leaf_id: str | None) -> bool:
        """True if the leaf's content ends with a colon, indicating it introduces a list."""
        if leaf_id is None:
            return False
        return nodes[leaf_id].content.rstrip().endswith(":")

    def is_separator_row(line: str) -> bool:
        """A Markdown table separator row only contains dashes/colons/whitespace."""
        cells = [cell.strip() for cell in line.split("|")]
        cells = [cell for cell in cells if cell]
        if not cells:
            return False
        return all(re.fullmatch(r"^[-:\s]+$", cell) for cell in cells)

    def is_data_table(lines: list[str]) -> bool:
        """True if the table has a header separator row (|---|---|...)."""
        return any(is_separator_row(line) for line in lines)

    def flush_table():
        nonlocal pending_table_lines, current_leaf_id, in_list_after_intro
        if not pending_table_lines:
            return
        parent_id = parent_of_new_block()

        if is_data_table(pending_table_lines):
            # Real data table: keep as one (or split) table node(s).
            table_id = ids.next("table")
            node = Node(
                id=table_id,
                type="table",
                parent=parent_id,
                page=current_page,
                path=list(path_titles),
                content="\n".join(pending_table_lines),
            )
            nodes[table_id] = node
            nodes[parent_id].children.append(table_id)
        else:
            # Decorative grid (e.g. skills laid out in a table with no header):
            # each non-empty cell becomes its own rule leaf so semantic detection
            # treats every skill/perk as an independent unit.
            for line in pending_table_lines:
                cells = [cell.strip() for cell in line.split("|")]
                for cell in cells:
                    if not cell:
                        continue
                    rule_id = ids.next("rule")
                    node = Node(
                        id=rule_id,
                        type="rule",
                        parent=parent_id,
                        page=current_page,
                        path=list(path_titles),
                        content=cell,
                    )
                    nodes[rule_id] = node
                    nodes[parent_id].children.append(rule_id)

        pending_table_lines = []
        current_leaf_id = None
        in_list_after_intro = False

    def maybe_split_table():
        nonlocal pending_table_lines
        if not pending_table_lines:
            return
        # Only split real data tables; decorative grids are better handled as
        # one cell-per-rule emission once the block is flushed.
        if is_data_table(pending_table_lines) and (
            len(pending_table_lines) >= MAX_TABLE_ROWS
            or sum(len(line) for line in pending_table_lines) >= MAX_TABLE_CHARS
        ):
            flush_table()

    path_titles: list[str] = []

    lines = markdown_text.splitlines()
    for i, raw_line in enumerate(lines):
        line = raw_line.rstrip("\n")

        page_m = PAGE_RE.match(line.strip())
        if page_m:
            flush_table()
            current_page = int(page_m.group(1))
            continue

        if TABLE_ROW_RE.match(line.strip()):
            maybe_split_table()
            pending_table_lines.append(line.strip())
            in_list_after_intro = False
            continue
        else:
            flush_table()

        heading_m = HEADING_RE.match(line)
        if heading_m:
            level = len(heading_m.group(1))
            title = heading_m.group(2).strip()
            node_type = LEVEL_TYPE.get(level, "subsection")

            # pop stack back to parent level
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            parent_id = heading_stack[-1][1]

            node_id = ids.next(node_type)
            new_path = [nodes[nid].path[-1] if nodes[nid].path else _title_of(nodes[nid]) for lvl, nid in heading_stack[1:]]
            new_path.append(title)

            node = Node(
                id=node_id,
                type=node_type,
                parent=parent_id,
                page=current_page,
                path=new_path,
                content=title,
            )
            nodes[node_id] = node
            nodes[parent_id].children.append(node_id)
            heading_stack.append((level, node_id))
            path_titles = new_path
            current_leaf_id = None
            in_list_after_intro = False
            continue

        text = line.strip()
        if not text:
            current_leaf_id = None
            in_list_after_intro = False
            # Auto-close the current group if the next non-empty line is not a
            # list item. This prevents groups from absorbing unrelated content
            # (e.g. implicit sub-headings like "БОЕВОЙ НАВЫК" or paragraphs)
            # that appears after the list ends but before the next heading.
            if heading_stack and heading_stack[-1][0] >= GROUP_LEVEL:
                next_text = _peek_next_non_empty(lines, i + 1)
                if next_text is None or not _is_list_start(next_text):
                    heading_stack.pop()
                    path_titles = [
                        nodes[nid].path[-1] if nodes[nid].path else _title_of(nodes[nid])
                        for _, nid in heading_stack[1:]
                    ]
            continue

        # Skip bare bold-marker lines (DOCX conversion artifacts like "**" or "****")
        if re.fullmatch(r"\*+", text):
            continue

        parent_id = parent_of_new_block()
        note = text.lower().startswith(("примечание", "note:", "внимание"))
        is_numbered_or_bullet = bool(NUMBERED_RULE_RE.match(text)) or text.startswith("- ")
        is_bold_start = text.startswith("**")
        is_rule_start = is_numbered_or_bullet or is_bold_start

        # --- Group node detection ---
        # A standalone line ending with ":" (or ":") whose next non-empty line
        # is a list item (bold / numbered / bullet) becomes a "group" structural
        # node. Subsequent list items become children of the group, giving the
        # tree an explicit category → entries hierarchy. This prevents short
        # category labels from becoming orphan units and stops later category
        # labels from bleeding into the last entry of the previous group.
        # A ":"-ending line whose next non-empty line is a list item becomes a
        # group node, regardless of whether the label itself is bold/numbered.
        # The key signal is the trailing ":" + list-following, not the format
        # of the label. Bold entries like "**Аврианцы.**" end with "." not ":"
        # so they won't be caught.
        # Strip trailing bold markers (** or ***) before checking for ":".
        _stripped_text = text.rstrip("*")
        if _stripped_text.endswith(":"):
            next_text = _peek_next_non_empty(lines, i + 1)
            if next_text is not None and _is_list_start(next_text):
                # Determine the group's parent. If we're currently inside a
                # group and this ":"-ending line is itself a list item (bold,
                # numbered, or bullet), it's a sub-category → nest as a child
                # of the current group. Otherwise, pop back to the heading
                # level (siblings, not nested).
                in_group = heading_stack and heading_stack[-1][0] >= GROUP_LEVEL
                if in_group and is_numbered_or_bullet:
                    # Nested group: child of the current (innermost) group.
                    group_parent = heading_stack[-1][1]
                    group_level = heading_stack[-1][0] + 1
                else:
                    # Sibling group: pop back to the last non-group heading.
                    while heading_stack and heading_stack[-1][0] >= GROUP_LEVEL:
                        heading_stack.pop()
                    group_parent = heading_stack[-1][1]
                    group_level = GROUP_LEVEL

                # Always create a new group node. The previous leaf (if any)
                # stays as a rule under its original parent — we never convert
                # an existing bold entry or paragraph into a group, since the
                # ":"-ending line is the category label, not part of the entry.
                group_id = ids.next("group")
                nodes[group_id] = Node(
                    id=group_id,
                    type="group",
                    parent=group_parent,
                    page=current_page,
                    path=[],
                    content=text,
                )
                nodes[group_parent].children.append(group_id)

                # Build the group's path from the heading stack + a short title.
                group_title = text.rstrip(":").strip()
                new_path = [
                    nodes[nid].path[-1] if nodes[nid].path else _title_of(nodes[nid])
                    for _, nid in heading_stack[1:]
                ]
                new_path.append(group_title[:80])
                nodes[group_id].path = new_path

                heading_stack.append((group_level, group_id))
                path_titles = new_path
                current_leaf_id = None
                in_list_after_intro = False
                continue

        # If the current rule leaf has grown too large, force a new leaf so that
        # downstream semantic detection can work with reasonably sized chunks.
        if current_leaf_id is not None and len(nodes[current_leaf_id].content) >= MAX_RULE_CHARS:
            current_leaf_id = None
            in_list_after_intro = False

        # Only numbered/bullet items can be merged into a colon-introduced list.
        # Bold-term "lists" (**Аврианцы.** ...) are separate entities and should
        # be split into their own nodes so the LLM can link them later.
        if is_numbered_or_bullet:
            target = current_leaf_id
            if target is None:
                target = last_rule_leaf_of_parent()

            if target is not None and (in_list_after_intro or ends_with_list_intro(target)):
                nodes[target].content += "\n" + text
                current_leaf_id = target
                in_list_after_intro = True
                continue

            # Not part of a colon-introduced list — start a fresh leaf.
            in_list_after_intro = False
        else:
            in_list_after_intro = False

        if current_leaf_id is None or is_rule_start:
            node_type = "note" if note else "rule"
            node_id = ids.next(node_type)
            node = Node(
                id=node_id,
                type=node_type,
                parent=parent_id,
                page=current_page,
                path=list(path_titles),
                content=text,
            )
            nodes[node_id] = node
            nodes[parent_id].children.append(node_id)
            current_leaf_id = node_id
        else:
            nodes[current_leaf_id].content += "\n" + text

    flush_table()

    return {
        "root": doc_id,
        "nodes": {nid: n.to_json() for nid, n in nodes.items()},
    }


def _title_of(node: Node) -> str:
    return node.content.splitlines()[0] if node.content else ""


def main():
    ap = argparse.ArgumentParser(description="Parse Markdown into hierarchical structure.json (Phase 2)")
    ap.add_argument("markdown", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    text = args.markdown.read_text(encoding="utf-8")
    structure = parse(text)

    out_path = args.output or args.markdown.with_suffix(".structure.json")
    out_path.write_text(json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(structure['nodes'])} nodes)")


if __name__ == "__main__":
    main()
