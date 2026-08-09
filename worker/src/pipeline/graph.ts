import type { Env, Relation, SemanticUnit } from "../types";
import { clearRelationsForSource, insertRelation } from "../utils/db";

/** Phase 5 — populate D1 relations for a single unit (runs in the relations pass). */
export async function populateRelations(env: Env, unit: SemanticUnit, relations: Relation[]) {
  await clearRelationsForSource(env, unit.id);
  for (const r of relations) {
    await insertRelation(env, r);
  }
}
