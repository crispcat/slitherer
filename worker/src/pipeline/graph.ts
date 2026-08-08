import type { Env, Relation, SemanticUnit } from "../types";
import {
  clearKeywords,
  clearRelationsForSource,
  getConceptIdByName,
  insertKeyword,
  insertRelation,
  linkConceptUnit,
  upsertConcept,
} from "../utils/db";
import { nextId } from "../utils/ids";

/** Phase 7 — populate D1 concepts/keywords for a single unit (runs right after Phase 4 metadata). */
export async function populateConceptsAndKeywords(env: Env, unit: SemanticUnit) {
  await clearKeywords(env, unit.id);
  for (const kw of unit.metadata?.keywords ?? []) {
    await insertKeyword(env, unit.id, kw);
  }

  const conceptNames = unit.metadata?.defines ?? [];
  for (const name of conceptNames) {
    let conceptId = await getConceptIdByName(env, name);
    if (!conceptId) {
      conceptId = nextId("CONCEPT");
      await upsertConcept(env, conceptId, name, unit.summary ?? "", unit.metadata?.aliases ?? []);
    }
    await linkConceptUnit(env, conceptId, unit.id);
  }
}

/** Phase 7 — populate D1 relations for a single unit (runs in the Phase 5 pass, after every unit exists). */
export async function populateRelations(env: Env, unit: SemanticUnit, relations: Relation[]) {
  await clearRelationsForSource(env, unit.id);
  for (const r of relations) {
    await insertRelation(env, r);
  }
}
