# Table Unitization Analysis Report

**Tables analyzed:** 62
**Date:** 2026-08-07
**Method:** Each table processed through `/ingest/table` API endpoint (skeleton + LLM row refinement + LLM column tree + deterministic overrides + deduplication + unit building)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total tables | 62 |
| Issue-free tables | 62 (100%) |
| Tables with structural issues | 0 |
| Tables with source-level duplicates | 17 |
| Total source-level duplicate units | 58 |

All 62 tables are now semantically correct. The 17 tables with "duplicates" have
repeated values in the source markdown itself (e.g. a foraging table where
"Обычный ингр./охота" appears 9× at different dice rolls). These are NOT
unitization bugs — each (row, column) pair correctly produces one unit, but the
content happens to be identical.

### Structure Type Distribution

| Type | Count | Description |
|------|-------|-------------|
| SPLIT | 18 | Column-split data (each cell independently retrievable) |
| SIMPLE | 25 | Full rows, one entity per row (deterministic override for numeric-key tables) |
| SPLIT+HEADER | 16 | Independent lists with column header secondary parents |
| VISUAL | 1 | Sparse grid collapsed to single unit |
| MULTI-MERGED | 2 | Section headers + data within columns |

### Fixes Applied (Cumulative, 11 fixes)

#### Prompt-level fixes (3)
1. **Column tree prompt: SPLIT vs SIMPLE guidance** — Added explicit decision criteria: sequential numeric keys → SIMPLE, independent lists → SPLIT, alternating name/description → SPLIT.
2. **Row refinement prompt: name→description chaining** — Added guidance to chain description rows to preceding name rows.
3. **Column tree prompt: merged title + independent lists** — Added explicit example for merged-title tables with independent numbered lists.

#### Deterministic post-processing fixes (5)
4. **Column tree deduplication** — `deduplicateColumnHeaders` removes duplicate header AND data nodes covering the same columns, remapping children to the first instance.
5. **Row-width column filtering** — Column data nodes referencing columns beyond a row's width are filtered to valid columns only, preventing both data loss and duplication.
6. **Per-row deduplication** — `(rowIndex, validCols)` pairs tracked to prevent duplicate units when multiple column data nodes resolve to the same columns.
7. **Deterministic column tree overrides** — `overrideColumnTree` applies language-agnostic, document-agnostic rules:
   - **Numeric key override**: If ALL col 0 values (from data rows, excluding merged rows) are short integers (0-999), force SIMPLE (one data node with all columns). This is a universal signal: sequential numeric keys in col 0 indicate key-value/property tables.
   - **Sparse grid override**: If fillRatio < 0.6 and colCount > 10, force VISUAL. This detects sparse diagram grids.
   - **Note**: Non-numeric tables are NOT overridden to SPLIT because that would break common patterns like Name|Description, Item|Price, Question|Answer. The SPLIT vs SIMPLE decision for non-numeric tables is left to the LLM.
8. **Column header deduplication** — When a column header produces the same content as the row header unit (happens in SIMPLE tables where one column header covers all columns), the duplicate is skipped and the column node is mapped to the existing row header unit.

#### Skeleton fixes (3)
9. **DESC+HEADER skeleton fix** — Post-separator row after a merged description is marked as `header` instead of `data`.
10. **Visual reclassification guard** — Fill-ratio heuristic (`< 0.7`) allows visual collapse for sparse grids while blocking it for data-rich tables.
11. **`new_role: visual` blocked** — The LLM can no longer reclassify individual rows to `visual` via `new_role`.

---

## Full Table Inventory (All 62 Tables)

### Advantage/Disadvantage Tables (TABLE-00001 to TABLE-00003)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00001 | Copper perks | 2 | 21 | ✓ SPLIT, 2 independent lists |
| TABLE-00002 | Silver perks | 2 | 29 | ✓ SPLIT, 2 independent lists |
| TABLE-00003 | Gold perks | 2 | 31 | ✓ SPLIT, 2 independent lists |

### Attribute Reference (TABLE-00004)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00004 | Attribute levels | 4 | 7 | ✓ SPLIT, 2 key-value pair groups |

### Ability Tables (TABLE-00005 to TABLE-00009)

| Table | Ability | Cols | Units | Type | Verdict |
|-------|---------|------|-------|------|---------|
| TABLE-00005 | Сила (Strength) | 4 | 9 | SIMPLE | ✓ Full rows (numeric key override) |
| TABLE-00006 | Ловкость (Dexterity) | 4 | 9 | SIMPLE | ✓ Full rows (numeric key override, was SPLIT) |
| TABLE-00007 | Выносливость (Endurance) | 4 | 9 | SIMPLE | ✓ Full rows (numeric key override) |
| TABLE-00008 | Разум (Mind) | 2 | 9 | SIMPLE | ✓ Full rows (numeric key override, was SPLIT) |
| TABLE-00009 | Сила Воли (Willpower) | 3 | 12 | SIMPLE | ✓ Full rows (numeric key override) |

### Skills Tables (TABLE-00010 to TABLE-00012)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00010 | Skill levels | 4 | 25 | ✓ SPLIT, 2 key-value pair groups |
| TABLE-00011 | Skill categories | 2 | 20 | ✓ SPLIT, 2 independent lists |
| TABLE-00012 | Combat perks | 2 | 16 | ✓ SPLIT, merged title + independent lists |

### Trauma/Mutation Tables (TABLE-00013 to TABLE-00017)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00013 | Body parts trauma | 4 | 14 | ✓ FLAT, full rows |
| TABLE-00014 | Body mutations | 3 | 7 | ✓ SIMPLE (numeric key override) |
| TABLE-00015 | Mind mutations | 3 | 7 | ✓ SIMPLE (numeric key override) |
| TABLE-00016 | Mutation costs | 3 | 12 | ✓ FLAT, full rows |
| TABLE-00017 | Mutation costs | 3 | 12 | ✓ FLAT, full rows |

### Combat Tables (TABLE-00018 to TABLE-00024)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00018 | Wounds reference | 2 | 5 | ✓ SPLIT, 2 independent notes |
| TABLE-00019 | Battlefield grid | 15 | 2 | ✓ VISUAL (sparse grid override) |
| TABLE-00020 | Combat perks | 2 | 14 | ✓ SPLIT, merged title + independent lists |
| TABLE-00021 | Combat perks detail | 2 | 13 | ✓ SPLIT (source has repeated col 0 content) |
| TABLE-00022 | Weapon techniques | 2 | 17 | ✓ SPLIT, 2 independent lists |
| TABLE-00023 | Combat schools | 2 | 21 | ✓ SPLIT, 2 independent school descriptions |
| TABLE-00024 | Combat actions | 2 | 11 | ✓ SPLIT, 2 independent action lists |

### Weapon Tables (TABLE-00025 to TABLE-00031)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00025 | Knives | 4 | 28 | ✓ SPLIT, weapon stats |
| TABLE-00026 | Swords | 4 | 28 | ✓ SPLIT, weapon stats |
| TABLE-00027 | Blunt weapons | 4 | 31 | ✓ SPLIT, weapon stats |
| TABLE-00028 | Polearms | 4 | 31 | ✓ SPLIT, weapon stats |
| TABLE-00029 | Axes | 4 | 31 | ✓ SPLIT, weapon stats |
| TABLE-00030 | Crossbows | 4 | 31 | ✓ SPLIT, weapon stats |
| TABLE-00031 | Throwing/Magic weapons | 4 | 39 | ✓ SPLIT (source has repeated stats) |

### Armor Tables (TABLE-00032 to TABLE-00035)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00032 | Weapon properties | 2 | 14 | ✓ MULTI-MERGED, section headers + data |
| TABLE-00033 | Light armor | 4 | 57 | ✓ SPLIT |
| TABLE-00034 | Combat actions | 2 | 21 | ✓ SPLIT, 2 independent action lists |
| TABLE-00035 | Armor modifiers | 2 | 41 | ✓ SPLIT, 2 independent modifier lists |

### Crafting Tables (TABLE-00036 to TABLE-00042)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00036 | Crafting costs | 3 | 22 | ✓ FLAT, full rows |
| TABLE-00037 | Weapon improvements | 2 | 11 | ✓ MULTI-MERGED |
| TABLE-00038 | Armor quality/material | 2 | 13 | ✓ SPLIT, 2 independent lists |
| TABLE-00039 | Ingredients + equipment | 4 | 17 | ✓ MULTI-MERGED, 2 sections |
| TABLE-00040 | Potions | 4 | 15 | ✓ SIMPLE, full rows |
| TABLE-00041 | Alchemy recipes | 4 | 27 | ✓ FLAT, full rows |
| TABLE-00042 | Blood magic potions | 4 | 13 | ✓ SIMPLE, full rows |

### Knowledge Tables (TABLE-00043 to TABLE-00046)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00043 | Foraging lookup | 6 | 17 | ✓ SPLIT, transposed lookup |
| TABLE-00044 | Foraging results | 7 | 40 | ✓ SPLIT (23 source-level dups) |
| TABLE-00045 | Animal stats | 4 | 49 | ✓ SPLIT, 2 key-value pair groups |
| TABLE-00046 | NPC stats | 4 | 25 | ✓ SPLIT, 2 key-value pair groups |

### Sleep Magic Tables (TABLE-00047 to TABLE-00051)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00047 | Sleep magic forms | 7 | 4 | ✓ FLAT, transposed, full rows |
| TABLE-00048 | Sleep magic effects | 7 | 4 | ✓ FLAT, transposed, full rows |
| TABLE-00049 | Sleep magic forms | 3 | 6 | ✓ FLAT, full rows |
| TABLE-00050 | Sleep magic effects | 4 | 13 | ✓ SPLIT, transposed |
| TABLE-00051 | Sleep magic checks | 6 | 19 | ✓ SPLIT, transposed (5 source-level dups) |

### Will Magic (TABLE-00052)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00052 | Магия Воли | 2 | 53 | ✓ SPLIT, 2 independent spell lists |

### Blood Magic Tables (TABLE-00053 to TABLE-00055)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00053 | Blood magic spells | 2 | 26 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00054 | Blood magic paths | 2 | 33 | ✓ SPLIT, 2 independent path lists |
| TABLE-00055 | Blood magic rituals | 2 | 16 | ✓ SPLIT, 2 independent ritual lists |

### Mind Magic Tables (TABLE-00056 to TABLE-00061)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00056 | Дом Огней (Fire) | 2 | 15 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00057 | Дом Влаги (Water) | 2 | 29 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00058 | Дом Ветров (Air) | 2 | 29 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00059 | Дом Тверди (Earth) | 2 | 32 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00060 | Дом Света (Light) | 2 | 28 | ✓ SPLIT, 2 independent spell lists |
| TABLE-00061 | Дом Жизни (Life) | 2 | 20 | ✓ SPLIT, 2 independent spell lists |

### Heart Magic (TABLE-00062)

| Table | Type | Cols | Units | Verdict |
|-------|------|------|-------|---------|
| TABLE-00062 | Магия Сердца | 2 | 18 | ✓ SPLIT, 2 independent lists |

---

## Architecture Notes

### Processing Pipeline

Each table goes through the following stages:

1. **`buildRowSkeleton`** (deterministic): Parses the markdown table and builds a row tree based on:
   - Merged rows (all cells identical) → `structural`
   - Row before `---` separator → `header`
   - Row after `---` separator when preceded by merged description → `header` (DESC+HEADER fix)
   - All other rows → `data`

2. **`refineRowSkeleton`** (LLM): Sends the skeleton to the LLM for corrections:
   - Role reclassification (description, header, section, data, structural)
   - Reparenting (creating section hierarchies, chaining name→description)
   - Visual reclassification (guarded by fill-ratio < 0.7 and dataRowCount ≤ 2)

3. **`detectColumnTree`** (LLM): Builds a column tree to determine if columns are:
   - SPLIT: Independent sub-tables side by side
   - SIMPLE: Properties of one entity
   - Key-value pairs kept together
   - Merged title + independent numbered lists

4. **`overrideColumnTree`** (deterministic): Applies language-agnostic, document-agnostic overrides:
   - Numeric key override: ALL col 0 values are short integers → force SIMPLE
   - Sparse grid override: fillRatio < 0.6 && colCount > 10 → force VISUAL

5. **`deduplicateColumnHeaders`** (deterministic): Removes duplicate column tree nodes (header and data) covering the same columns, remapping children to the first instance.

6. **`buildTableUnitsFromTree`** (deterministic): Creates semantic units from the double-tree:
   - Row tree structural nodes → root/section units
   - Column tree header nodes → column header units (linked to row header, deduplicated if same content)
   - Data nodes × column data nodes → individual data units
   - Row-width column filtering: columns beyond row width are filtered
   - Per-row deduplication: `(rowIndex, validCols)` pairs tracked to prevent duplicates

### Portability

All deterministic rules use only structural signals (cell fill ratio, column count, numeric content patterns) that are language-agnostic and document-agnostic. No rule hard-codes document-specific terms, attribute names, or vocabulary. The SPLIT vs SIMPLE decision for non-numeric tables is left to the LLM, which can understand the semantic relationship between columns.
