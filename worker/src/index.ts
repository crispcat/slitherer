import type { Env, StructureDocument } from "./types";
import { processIngestionBatch, rebuildAllRelationships, startIngestion } from "./pipeline/ingest";
import { cleanupDocument, getIngestionJob, getUnitsWithUnresolvedRefs } from "./utils/db";
import { retrieve } from "./retrieval/query";
import { generateAnswer } from "./retrieval/answer";
import { uuid } from "./utils/ids";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Constant-time-ish string compare to avoid trivial timing side-channels on the API key check. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

/** Admin routes (/ingest*) fail CLOSED if ADMIN_API_KEY isn't configured — never silently open. */
function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) return false;
  const token = bearerToken(request);
  return token.length > 0 && safeEqual(token, env.ADMIN_API_KEY);
}

/** /query is open by default; set QUERY_API_KEY to lock it down too. */
function isQueryAuthorized(request: Request, env: Env): boolean {
  if (!env.QUERY_API_KEY) return true;
  const token = bearerToken(request);
  return token.length > 0 && safeEqual(token, env.QUERY_API_KEY);
}

/**
 * Structure documents are large; the client is expected to store the raw
 * structure.json in R2 first (or POST it directly for small docs) and pass
 * either { structure: StructureDocument } or { bucketKey: string }.
 */
async function loadStructureDoc(env: Env, body: any): Promise<StructureDocument> {
  if (body.structure) return body.structure as StructureDocument;
  if (body.bucketKey) {
    const obj = await env.slitherer_rag_storage.get(body.bucketKey);
    if (!obj) throw new Error(`No such object in BUCKET: ${body.bucketKey}`);
    return (await obj.json()) as StructureDocument;
  }
  throw new Error("Request body must include either 'structure' or 'bucketKey'");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/ingest") && !isAdminAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/query" && !isQueryAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }

      // POST /ingest/upload?documentId=...&sourcePath=...
      // Body: raw StructureDocument JSON. Stores it (plus a small sourcePath
      // sidecar) in R2 and returns { bucketKey } for use with POST /ingest.
      // This is the recommended default path — it sidesteps any client/edge
      // request-body-size caveats around inlining `structure` directly.
      if (url.pathname === "/ingest/upload" && request.method === "POST") {
        const documentId = url.searchParams.get("documentId");
        const sourcePath = url.searchParams.get("sourcePath") ?? "unknown";
        if (!documentId) return json({ error: "documentId query param is required" }, 400);

        const bodyText = await request.text();
        JSON.parse(bodyText); // validate it's well-formed JSON before storing

        const bucketKey = `structures/${documentId}.json`;
        await env.slitherer_rag_storage.put(bucketKey, bodyText, {
          httpMetadata: { contentType: "application/json" },
        });
        await env.slitherer_rag_storage.put(
          `structures/${documentId}.meta.json`,
          JSON.stringify({ documentId, sourcePath, uploadedAt: new Date().toISOString() })
        );

        return json({ bucketKey, documentId, sourcePath });
      }

      // POST /ingest  { documentId, sourcePath, structure | bucketKey }
      // Starts (or restarts) ingestion for a document and stores the structure
      // tree + a resumable job. Returns { jobId }.
      if (url.pathname === "/ingest" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId ?? uuid();
        const sourcePath: string = body.sourcePath ?? "unknown";
        const doc = await loadStructureDoc(env, body);
        const jobId = uuid();

        await env.slitherer_rag_storage.put(`jobs/${jobId}.json`, JSON.stringify(doc));

        const { totalNodes } = await startIngestion(env, documentId, sourcePath, doc, jobId);
        return json({ jobId, documentId, totalNodes });
      }

      // POST /ingest/step { jobId, batchSize? }
      // Advances an ingestion job by one batch. Call repeatedly until done=true.
      if (url.pathname === "/ingest/step" && request.method === "POST") {
        const body = await request.json<any>();
        const jobId: string = body.jobId;
        const obj = await env.slitherer_rag_storage.get(`jobs/${jobId}.json`);
        if (!obj) return json({ error: "job structure not found" }, 404);
        const doc = (await obj.json()) as StructureDocument;
        const result = await processIngestionBatch(env, doc, jobId, body.batchSize ?? 3);
        return json(result);
      }

      // GET /ingest/status?jobId=...
      if (url.pathname === "/ingest/status" && request.method === "GET") {
        const jobId = url.searchParams.get("jobId") ?? "";
        const job = await getIngestionJob(env, jobId);
        if (!job) return json({ error: "not found" }, 404);
        return json(job);
      }

      // GET /ingest/orphans?documentId=...
      // Returns units with unresolved metadata references, useful for QA review.
      if (url.pathname === "/ingest/orphans" && request.method === "GET") {
        const documentId = url.searchParams.get("documentId") ?? "";
        if (!documentId) return json({ error: "documentId is required" }, 400);
        const units = await getUnitsWithUnresolvedRefs(env, documentId);
        return json({
          documentId,
          count: units.length,
          units: units.map((u) => ({
            id: u.id,
            type: u.type,
            name: u.name,
            section: u.section,
            page: u.page,
            unresolved: u.metadata?.unresolved_references ?? [],
          })),
        });
      }

      // POST /ingest/cleanup { documentId }
      // Removes every D1 row, Vectorize vector, and R2 object for a document.
      if (url.pathname === "/ingest/cleanup" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId;
        if (!documentId) return json({ error: "documentId is required" }, 400);
        await cleanupDocument(env, documentId);
        return json({ ok: true, documentId });
      }

      // POST /ingest/rebuild-relations { batchSize?, cursor? }
      // Second pass over Phase 5 across the whole knowledge base (see
      // pipeline/ingest.ts:rebuildAllRelationships for rationale).
      if (url.pathname === "/ingest/rebuild-relations" && request.method === "POST") {
        const body = await request.json<any>().catch(() => ({}));
        const result = await rebuildAllRelationships(env, body.batchSize ?? 10, body.cursor ?? 0);
        return json(result);
      }

      // POST /query { question }
      // Full Phase 8/9 retrieval + citation-backed answer generation.
      if (url.pathname === "/query" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const retrieved = await retrieve(env, question, {
          topKVector: body.topKVector,
          graphHops: body.graphHops,
          finalCount: body.finalCount,
        });
        const result = await generateAnswer(env, question, retrieved);
        return json({
          ...result,
          retrievedUnits: retrieved.map((r) => ({
            id: r.unit.id,
            type: r.unit.type,
            name: r.unit.name,
            section: r.unit.section,
            page: r.unit.page,
            vectorScore: r.vectorScore,
            rerankScore: r.rerankScore,
          })),
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      console.error(err?.stack ?? err); // full detail in `wrangler tail`, not in the response
      return json({ error: err?.message ?? "internal error" }, 500);
    }
  },
};
