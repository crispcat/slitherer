# AI Rulebook Knowledge Engine
## Implementation Plan v1.0

## Goal

Build a semantic knowledge engine for a single (~200-page) RPG rulebook using Cloudflare.

Target rulebook `deorim_rules.docx` is stored under `rulebooks/` directory.

This is **not** a traditional chunk-based RAG. The system should understand mechanics, relationships, exceptions, and interactions that are distributed throughout the document.

The ingestion pipeline should perform as much work as possible up front so that runtime queries are fast, inexpensive, and accurate.

---

# Objectives

The system should:

- Understand relationships between mechanics.
- Answer questions requiring information from multiple sections.
- Minimize hallucinations.
- Always provide citations.
- Be inexpensive to operate.
- Support incremental document updates.
- Be extensible for future features.

Non-goals (v1):

- MediaWiki generation
- Multi-document support
- Fine-tuning models

---

# Technology Stack

## Cloudflare

- Workers
- Workers AI
- Vectorize
- D1
- R2 (optional)

## Development

Recommended language:

- Go

Suggested libraries:

- goldmark
- goquery
- sqlc
- ent (optional)

---

# System Overview

The system consists of two major pipelines:

1. **Ingestion Pipeline**
   - Converts the source document into structured knowledge.
   - Generates embeddings.
   - Builds the knowledge graph.

2. **Query Pipeline**
   - Retrieves relevant semantic units.
   - Expands through the knowledge graph.
   - Reranks candidates.
   - Generates a citation-backed answer.

---

# Phase 1 — Document Conversion

## Input

- DOCX

## Output

- Markdown

The Markdown document becomes the canonical source.

The conversion must preserve:

- Heading hierarchy
- Tables
- Lists
- Numbered rules (if present)
- Examples
- Page numbers
- Formatting where semantically relevant (e.g., bold for key terms)
- Paragraph structure
- Case

---

# Phase 2 — Structural Parsing

Parse the Markdown into a hierarchical document model.

Each node should contain:

- Unique ID
- Parent ID
- Node type
- Section path
- Page number
- Raw content

## Node Types

- Document
- Chapter
- Section
- Subsection
- Rule
- Table
- Image
- Note

Example:

```json
{
  "id": "RULE-00004",
  "type": "rule",
  "parent": "SECTION-0001",
  "page": 4,
  "path": [
    "1. ЯДРО СИСТЕМЫ",
    "1.2. Сражение – сравнение навыков, оружие, броня, урон состоянию передвижение.",
  ],
  "content": "Успех попадания в бою определяется броском двух шестигранных кубиков, сложность которого зависит от сравнения навыков владения оружием (успех на 7-12 при равных навыках), либо основных атрибутов. Механика боя основана на использовании оружия с разными видами повреждений (колющее, дробящее, рубящее, огненное), по-разному взаимодействующими с разными видами брони (легкая, средняя, тяжелая) и различными параметрами состояния персонажа (К, З, С, Э). Помимо этого, в сражении играет роль перемещение по полю боя и инициатива, влияющая на порядок объявления действий (сами действия происходят одновременно).  Взаимное расположение персонажей также важно – оружие имеет разную удобную и возможную дистанцию боя, а удары сзади и окружение противника увеличивают вероятность попадания по нему. 
Опционально могут применяться ситуативные преимущества и штрафы (укрытия, дающие бонус в защите от стрелкового оружия; узкое пространство, дающее штраф к шансу попадания оружия, требующего размах; разница высот; препятствия, о которые можно толкнуть или ударить противника; сложные участки поля боя, требующие бросков на преодоление и т.п.), а также разные школы боя и особые приемы, которые за счет траты ресурсов (как правило, К или Э) либо меньшего шанса попадания способны заметно поменять ситуацию в бою. "
}
```

Use LLM here to split the document into semantic units and assign them a proper type.

---

# Phase 3 — Semantic Unit Detection

Do **not** split by token count.

Instead, identify meaningful semantic units.

Examples:

- Rule
- Attribute
- Skill
- Trait
- Ability
- Action (Any action type)
- Status Effect
- Item
- Spell
- Example
- Situation
- Modifier
- Definition
- Equipment
- Weapon
- Formula
- Table
- Example

Each semantic unit receives a permanent identifier.

Example:

```text
RULE-00042
SPELL-00018
ACTION-00007
TABLE-00003
```

There can be more than one semantic unit in one node. If this happens you must split a node into several nodes for each semantic unit separately. So extracted node becomes a child of an original node from which it was extracted.

---

# Phase 4 — Metadata Extraction

Run an LLM over every semantic unit, searching the document about where this unit is defined, referenced, modified, etc.

You should also semantically split the content of the unit into several parts if needed. When a reference to a part of the unit is found, you should split the unit into several parts like on phase 3. So extracted node becomes a child of an original node from which it was extracted.
 
The model should extract structured metadata.

Required fields:

- Defines
- References
- Requires
- Exceptions
- Modifies
- Modified by
- Keywords
- Aliases
- Summary

Example:

```json
{
  "defines": [
    "Практика"
  ],
  "references": [
    "ВЫБОР НАВЫКОВ",
    "СОЗДАНИЕ ПЕРСОНАЖА"
  ],
  "requires": [
    "Больше 20 лет. Юноша/Дева или старше.",
  ],
  "exceptions": [
    "Помимо связанной с возрастом, Практика также может быть приобретена за 1 Золотую Монету Преимуществ."
  ],
  "modifies": [
    "Дает +20 к любому навыку"
  ],
  "modified_by": [
    "ВЫБОР ВОЗРАСТА",
    "Возраст"
  ],
  "keywords": [
    "Навыки",
    "Практика",
    "Создание персонажа",
    "Возраст",
    "Золотая монета преимуществ"
  ],
  "aliases": [
    "Бонус к навыку",
    "Повышение навыка"
  ],
  "summary": "Практика. +20 к навыку. Помимо связанной с возрастом, Практика также может быть приобретена за 1 Золотую Монету Преимуществ."
}
```

Add metadata to a semantical unit.

---

# Phase 5 — Relationship Extraction

Run a second LLM pass dedicated to relationships.

The objective is to connect semantical units together.

Supported relationship types:

- defines
- references
- requires
- excepts
- modifies
- modified_by
- overrides
- related_to
- incompatible_with
- creates
- consumes
- supersedes
- example_of

Example:

```text
Основное действие: ФИНТ.
По оружейным навыкам, 9-12.
Успех: враг теряет К, +1 к шансу Финта на следующий ход. Не действует реакт. защита.
Крит: на след. ход враг раскрыт (-1 в защ).
Три успешных Финта подряд: +5 к шансу попадания на один следующий удар против врага (не позднее третьего хода после успеха).
Не может быть перекрещен.
Финт-2. Может применяться как малое действие за 1К; +2 шанс крит. успеха.

MODIFIED_BY -> Оружейные навыки

MODIFIES -> Контроль (Rule). Реактивная защита (Rule). Раскрыт (Status Effect).

REFERENCES -> Основное действие (Rule). Оружейные навыки (Rule). Перекрест (Ability). Три успешных Финта подряд (Rule). Финт-2 (Ability).

DEPENDS_ON -> Оружие. Оружейные навыки.

etc...
```

Every relationship should include a confidence score.

You can design required json structure yourself.

---

# Phase 6 — Embedding Generation

Do not embed only the original text.

Construct an enriched embedding document for every semantical unit.

Structure:

- Chapter
- Section
- Unit Name
- Summary
- Keywords
- Type
- Original Text

Generate an embedding for this enriched representation.

Store embeddings in Cloudflare Vectorize.

---

# Phase 7 — Knowledge Graph

Store structured knowledge in Cloudflare D1.

## concepts

Fields:

- id
- name
- description
- aliases

## semantic_units

Fields:

- id
- type
- page
- section
- content

## relations

Fields:

- id
- source
- target
- relation_type
- confidence

## concept_unit

Fields:

- concept_id
- unit_id

## keywords

Fields:

- unit_id
- keyword

---

# Phase 8 — Retrieval Pipeline

Processing steps:

1. Receive user question.
2. Generate embedding.
3. Search Vectorize.
4. Retrieve top semantic units.
5. Extract concepts from retrieved units.
6. Expand through the knowledge graph.
7. Collect all connected semantic units.
8. Remove duplicates.
9. Rerank.
10. Send final context to the LLM.

---

# Graph Expansion

Suppose vector search retrieves:

- Финт

Expand by traversing relationships:

- Финт-2
- Оружейные навыки
- Оружие
- Контроль
- Реактивная защита
- Раскрыт
- Основное действие
- Перекрест
- Три успешных Финта подряд
etc.


Collect every linked semantic unit before reranking.

---

# Reranking

Inputs:

- User question
- Candidate semantic units

Output:

Best 5–15 semantic units.

The reranker should prioritize:

- Direct answers
- Definitions
- Exceptions
- Overrides
- Related mechanics

---

# Phase 9 — Answer Generation

The LLM should follow these rules:

- Use only supplied evidence.
- Never invent rules.
- Mention conflicting rules.
- Mention uncertainty when evidence is incomplete.
- Cite every rule used.

Example:

```text
According to RULE-42, Shield Block functions normally.

RULE-98 introduces an exception while mounted.

RULE-140 overrides both rules when Magic Barrier is active.
```

---

# Citation Requirements

Every citation should include:

- Rule ID
- Section
- Page number

Example:

```text
RULE-42

Combat > Defense > Shield Block

Page 142
```

---

# Storage Layout

## R2

- original.docx
- markdown.md
- structure.json
- metadata.json

## Vectorize

- embeddings

## D1

Tables:

- concepts
- semantic_units
- relations
- concept_unit
- keywords

---

# Workers

## Ingestion Worker

Responsibilities:

- Receive uploads.
- Convert DOCX.
- Start ingestion pipeline.

## Parser Worker

Responsibilities:

- Parse Markdown.
- Build document tree.
- Assign stable IDs.

## Metadata Worker

Responsibilities:

- Extract metadata.
- Generate summaries.
- Extract keywords.

## Relationship Worker

Responsibilities:

- Extract graph relationships.
- Compute confidence scores.

## Embedding Worker

Responsibilities:

- Generate embeddings.
- Upload to Vectorize.

## Graph Worker

Responsibilities:

- Populate D1.
- Update graph relationships.

## Query Worker

Responsibilities:

- Embed query.
- Perform vector search.
- Expand graph.
- Rerank.
- Generate final answer.

---

# Incremental Updates

When the source document changes:

1. Detect modified semantic units.
2. Re-run metadata extraction only for changed units.
3. Rebuild affected graph relationships.
4. Regenerate affected embeddings.
5. Update D1 and Vectorize.

Avoid rebuilding the entire knowledge base.

---

# Future Improvements

## Multi-query Retrieval

Rewrite one question into multiple focused searches.

Example:

Question:

> Can I Shield Block while mounted?

Generated searches:

- Shield Block
- Mounted Combat
- Combat Exceptions
- Magic Barrier

Merge and rerank all retrieved results.

## Conflict Detection

Automatically identify:

- Conflicting rules
- Duplicate definitions
- Circular dependencies
- Unreachable mechanics

## Rule Timeline

Track:

- Introduced
- Modified
- Deprecated
- Overridden

## Mechanic Summaries

Generate synthetic concept summaries by aggregating every semantic unit connected to the same mechanic.

These summaries can improve retrieval quality.

---

# Design Principles

1. Never split by arbitrary token count.
2. Split by semantic meaning.
3. Preserve document hierarchy.
4. Perform expensive processing during ingestion.
5. Build explicit graph relationships.
6. Use embeddings only for discovery.
7. Use graph traversal to gather context.
8. Rerank before answer generation.
9. Generate answers strictly from retrieved evidence.
10. Every answer must include citations.

---

# MVP Deliverables

- DOCX → Markdown conversion
- Structural parser
- Semantic unit detection
- Metadata extraction
- Relationship extraction
- Embedding generation
- Vectorize integration
- D1 schema
- Knowledge graph builder
- Hybrid retrieval engine
- Reranking pipeline
- Citation-aware answer generation
- Incremental update pipeline

The MVP is complete when users can ask questions involving multiple interacting mechanics, and the system consistently retrieves all relevant rules, resolves interactions using only retrieved evidence, and produces fully cited answers.