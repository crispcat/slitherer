import type { Env, ConversationMessage, QueueMessage } from "./types";
import { processIngestionBatch, processVisionPage, rebuildAllConcepts, startIngestion, INGEST_STAGES } from "./pipeline/ingest";
import { cleanupDocument, getIngestionJob, getLastConversationTurns, logQueryStep, logDebug, resetIngestionStage, getAllUnits, getSourceNodesWithUnits, getUnitDetails, getDebugLogs, clearDebugLogs, updateUnit, getCandidateLogs, clearCandidateLogs, logCandidate } from "./utils/db";
import { runQuery, runQueryStream } from "./retrieval/pipeline";
import { route, generateChatResponse } from "./retrieval/router";
import { decompose } from "./retrieval/decompose";
import { retrieve } from "./retrieval/query";
import { checkSufficiency } from "./retrieval/sufficiency";
import { generateAnswer } from "./retrieval/answer";
import { uuid } from "./utils/ids";
import { INGESTION, WORKER } from "./config.gen";

const CORS_ORIGIN = WORKER.cors.allowOrigin;
const CORS_HEADERS = WORKER.cors.allowHeaders;
const CORS_METHODS = WORKER.cors.allowMethods;
const CORS_MAX_AGE = String(WORKER.cors.maxAge);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-allow-methods": CORS_METHODS,
    },
  });
}

/** Handle CORS preflight (OPTIONS) requests. */
function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-max-age": CORS_MAX_AGE,
    },
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

/** /query* endpoints are open by default; set QUERY_API_KEY to lock them down. */
function isQueryAuthorized(request: Request, env: Env): boolean {
  if (!env.QUERY_API_KEY) return true;
  const token = bearerToken(request);
  return token.length > 0 && safeEqual(token, env.QUERY_API_KEY);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — handle before auth so the browser can complete the handshake
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    try {
      if (url.pathname.startsWith("/ingest") && !isAdminAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (url.pathname.startsWith("/query") && !isQueryAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }

      // POST /query/verify
      // Validates the API key without doing any work. Used by the client
      // to check the token before rendering the UI.
      if (url.pathname === "/query/verify" && request.method === "POST") {
        return json({ ok: true });
      }

      // POST /ingest  { documentId, sourcePath, totalPages, pages? }
      // Starts (or restarts) ingestion for a document. The client is expected
      // to have already uploaded page images to R2 (pages/{documentId}/*.png).
      // This endpoint creates a job and enqueues pages to the vision Queue.
      // If `pages` is provided (array of 1-indexed page numbers), only those
      // pages are enqueued; otherwise all pages 1..totalPages are enqueued.
      if (url.pathname === "/ingest" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId ?? uuid();
        const sourcePath: string = body.sourcePath ?? "unknown";
        const totalPages: number = body.totalPages;
        if (!totalPages || totalPages < 1) {
          return json({ error: "totalPages is required (must be >= 1)" }, 400);
        }
        const pages: number[] | null = Array.isArray(body.pages) ? body.pages : null;
        const jobId = uuid();

        const { totalPages: tp } = await startIngestion(env, documentId, sourcePath, totalPages, jobId, pages);

        // Enqueue pages to the vision Queue (FIFO order, max_concurrency=1)
        const pagesToEnqueue = pages ?? Array.from({ length: totalPages }, (_, i) => i + 1);
        const messages: { body: QueueMessage }[] = [];
        for (const page of pagesToEnqueue) {
          messages.push({ body: { jobId, documentId, pageNumber: page } });
        }
        await env.VISION_QUEUE.sendBatch(messages);

        await logDebug(env, "info", "ingestion", `Enqueued ${pagesToEnqueue.length} pages to vision queue`, { jobId, documentId, pages: pagesToEnqueue });
        return json({ jobId, documentId, totalPages: tp, pagesEnqueued: pagesToEnqueue.length });
      }

      // POST /ingest/step { jobId, batchSize?, stage? }
      // Advances an ingestion job by one batch for the summary/metadata/embedding/concepts phases.
      // The vision phase is Queue-driven — call this to advance post-vision phases.
      // If stage is specified (e.g. "summary", "metadata", "embedding", "concepts"),
      // skips ahead to that phase and stops after it completes.
      if (url.pathname === "/ingest/step" && request.method === "POST") {
        const body = await request.json<any>();
        const jobId: string = body.jobId;
        const stage = body.stage;
        if (stage && !INGEST_STAGES.includes(stage)) {
          return json({ error: `Invalid stage: ${stage}. Valid stages: ${INGEST_STAGES.join(", ")}` }, 400);
        }
        const pages = Array.isArray(body.pages) ? body.pages : null;
        const result = await processIngestionBatch(
          env, jobId,
          body.batchSize ?? INGESTION.ingestion.batchSizes.summary.value,
          stage,
          pages
        );
        return json(result);
      }

      // GET /ingest/status?jobId=...
      if (url.pathname === "/ingest/status" && request.method === "GET") {
        const jobId = url.searchParams.get("jobId") ?? "";
        const job = await getIngestionJob(env, jobId);
        if (!job) return json({ error: "not found" }, 404);
        return json(job);
      }

      // PUT /ingest/r2/{key} — upload binary data to R2 at the specified key.
      // Used by the ingest script to upload page images to R2.
      // The key path is everything after /ingest/r2/ in the URL.
      // Optional header `X-Content-Hash` stores a hash in customMetadata for
      // skip-if-unchanged checks on subsequent uploads.
      {
        const r2Match = url.pathname.match(/^\/ingest\/r2\/(.+)$/);
        if (r2Match && request.method === "PUT") {
          const r2Key = r2Match[1];
          const contentType = request.headers.get("content-type") ?? "application/octet-stream";
          const contentHash = request.headers.get("x-content-hash") ?? undefined;
          const body = await request.arrayBuffer();
          await env.slitherer_rag_storage.put(r2Key, body, {
            httpMetadata: { contentType },
            customMetadata: contentHash ? { hash: contentHash } : undefined,
          });
          return json({ ok: true, key: r2Key, size: body.byteLength });
        }
      }

      // GET /ingest/r2/meta/{key} — check if an R2 object exists and return its metadata.
      // Used by the ingest script to skip re-uploading unchanged files (hash check).
      // Returns { exists, hash, size } where hash is the customMetadata hash.
      {
        const metaMatch = url.pathname.match(/^\/ingest\/r2\/meta\/(.+)$/);
        if (metaMatch && request.method === "GET") {
          const r2Key = metaMatch[1];
          const obj = await env.slitherer_rag_storage.head(r2Key);
          if (!obj) return json({ exists: false });
          return json({ exists: true, hash: obj.customMetadata?.hash ?? null, size: obj.size });
        }
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

      // POST /ingest/reset-stage { documentId, stage }
      // Clears the outputs of the specified stage AND all downstream stages,
      // then resets unit statuses so the stage can be re-run from clean state.
      // Stages: vision | summary | metadata | embedding | concepts
      // For "vision": also re-enqueues all pages to the vision Queue.
      if (url.pathname === "/ingest/reset-stage" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId;
        const stage: string = body.stage;
        if (!documentId) return json({ error: "documentId is required" }, 400);
        if (!stage || !INGEST_STAGES.includes(stage as any)) {
          return json({ error: `Invalid stage: ${stage}. Valid stages: ${INGEST_STAGES.join(", ")}` }, 400);
        }
        const pages = Array.isArray(body.pages) ? body.pages : null;
        await resetIngestionStage(env, documentId, stage, pages);

        // For vision reset: re-enqueue pages to the vision Queue
        if (stage === "vision") {
          const job = await getIngestionJob(env, body.jobId);
          if (!job) {
            return json({ error: "jobId not found. Provide jobId to re-enqueue vision pages." }, 400);
          }
          const jobId = job.id as string;
          const detail = JSON.parse(job.detail as string);
          const totalPages = detail.totalPages;
          if (!totalPages || totalPages < 1) {
            return json({ error: "totalPages not found in job detail" }, 400);
          }
          // If pages scope was provided, only re-enqueue those pages.
          // Otherwise, re-enqueue all pages from the job's page list (or 1..totalPages).
          const pagesToEnqueue = pages ?? (Array.isArray(detail.pages) ? detail.pages : Array.from({ length: totalPages }, (_, i) => i + 1));
          const messages: { body: QueueMessage }[] = [];
          for (const page of pagesToEnqueue) {
            messages.push({ body: { jobId, documentId, pageNumber: page } });
          }
          await env.VISION_QUEUE.sendBatch(messages);
          await logDebug(env, "info", "ingestion:vision", `Re-enqueued ${pagesToEnqueue.length} pages after vision reset`, { jobId, documentId, pages: pagesToEnqueue });
          return json({ ok: true, documentId, stage, reEnqueued: pagesToEnqueue.length, jobId, pages: pagesToEnqueue });
        }

        return json({ ok: true, documentId, stage, pages: pages ?? undefined });
      }

      // POST /ingest/vision/test { image: base64, page: number, continuation?, writeToDb?, documentId? }
      // Test endpoint: extracts units from a single page image and optionally
      // writes them to D1 for debugging via the debug frontend.
      // Returns { units, continuation, logs? }
      if (url.pathname === "/ingest/vision/test" && request.method === "POST") {
        const body = await request.json<any>();
        if (!body.image) return json({ error: "image (base64 string) is required" }, 400);
        const pageNumber: number = body.page ?? 0;
        const documentId: string = body.documentId ?? "test-doc";
        const writeToDb: boolean = body.writeToDb === true;

        const { extractPage } = await import("./pipeline/vision_extract");
        const { normalizeUnits } = await import("./pipeline/vision_verify");
        const { upsertSemanticUnit } = await import("./utils/db");
        const { sha256 } = await import("./utils/hash");

        const result = await extractPage(
          env,
          body.image,
          pageNumber,
          body.continuation ?? null,
          body.model,
          body.maxTokens,
        );

        const normalized = normalizeUnits(result.units);

        if (writeToDb) {
          const now = new Date().toISOString();
          for (let i = 0; i < normalized.length; i++) {
            const unit = normalized[i];
            const contentHash = await sha256(unit.content);
            await upsertSemanticUnit(env, {
              id: unit.id,
              documentId,
              sourceNodeId: `page-${pageNumber}`,
              parentUnitId: unit.parentId,
              sourceOrder: i,
              type: unit.type as any,
              name: unit.name,
              page: pageNumber,
              section: unit.section,
              content: unit.content,
              contentHash,
              status: "pending",
              updatedAt: now,
            });
          }
        }

        return json({
          page: pageNumber,
          units: normalized,
          continuation: result.continuation,
          writtenToDb: writeToDb,
        });
      }

      // POST /ingest/rebuild-concepts { batchSize?, cursor? }
      // Second pass over the whole knowledge base to rebuild concepts.
      if (url.pathname === "/ingest/rebuild-concepts" && request.method === "POST") {
        const body = await request.json<any>().catch(() => ({}));
        const result = await rebuildAllConcepts(env, body.batchSize ?? INGESTION.ingestion.batchSizes.concepts.value, body.cursor ?? 0);
        return json(result);
      }


      // POST /query { question, conversationId?, stream?, debug?, maxIterations? }
      // Full agentic retrieval pipeline: router → decompose → retrieve → sufficiency loop → answer.
      // All-in-one endpoint. For step-by-step execution, use the /query/* endpoints below.
      if (url.pathname === "/query" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const stream = body.stream === true;

        if (stream) {
          // Streaming mode: Server-Sent Events
          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(controller) {
              try {
                const generator = runQueryStream(env, question, {
                  conversationId: body.conversationId,
                  stream: true,
                  debug: body.debug === true,
                  maxIterations: body.maxIterations,
                });

                let result;
                while (true) {
                  const { value, done } = await generator.next();
                  if (done) {
                    result = value;
                    break;
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: value })}\n\n`));
                }

                // Send final result as a metadata event
                if (result) {
                  controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify(result.result)}\n\n`));
                }
                controller.close();
              } catch (err: any) {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err?.message ?? "internal error" })}\n\n`));
                controller.close();
              }
            },
          });

          return new Response(readable, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              "connection": "keep-alive",
              "access-control-allow-origin": CORS_ORIGIN,
              "access-control-allow-headers": CORS_HEADERS,
              "access-control-allow-methods": CORS_METHODS,
            },
          });
        }

        // Complete mode: standard JSON response
        const { result, retrieved } = await runQuery(env, question, {
          conversationId: body.conversationId,
          debug: body.debug === true,
          maxIterations: body.maxIterations,
        });

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
            sourceSubQueries: r.sourceSubQueries,
          })),
        });
      }

      // ---- Step-by-step query endpoints (for client-side orchestration) ----

      // POST /query/router { question, conversationId? }
      // Step 1: RAG-vs-chat classification + language detection + translation.
      if (url.pathname === "/query/router" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const history: ConversationMessage[] = body.conversationId
          ? await getLastConversationTurns(env, body.conversationId, 6)
          : [];

        const start = Date.now();
        const result = await route(env, question, history);
        const durationMs = Date.now() - start;
        console.log(`[/query/router] rag=${result.rag} lang=${result.language} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "router", { question }, result, durationMs, body.conversationId);
        }

        // If not RAG, generate chat response
        if (!result.rag && !result.chatResponse) {
          result.chatResponse = await generateChatResponse(env, question, result.language, history);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/decompose { russianQuery, originalQuery?, entities?, conversationId? }
      // Step 2: Query decomposition into sub-queries + dynamic rerank threshold.
      // Phase 8: Accept originalQuery and entities for cross-language preservation.
      if (url.pathname === "/query/decompose" && request.method === "POST") {
        const body = await request.json<any>();
        const russianQuery: string = body.russianQuery;
        if (!russianQuery) return json({ error: "russianQuery is required" }, 400);

        const history: ConversationMessage[] = body.conversationId
          ? await getLastConversationTurns(env, body.conversationId, 6)
          : [];

        const start = Date.now();
        const result = await decompose(env, russianQuery, history, body.originalQuery, body.entities);
        const durationMs = Date.now() - start;
        console.log(`[/query/decompose] ${result.subQueries.length} sub-queries threshold=${result.rerankThreshold} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "decompose", { russianQuery, originalQuery: body.originalQuery, entities: body.entities }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/retrieve { subQueries, rerankThreshold?, existingIds? }
      // Step 3+4: Hybrid retrieval (subject + content + lexical, RRF-fused) + per-sub-query rerank + threshold filter.
      if (url.pathname === "/query/retrieve" && request.method === "POST") {
        const body = await request.json<any>();
        const subQueries: string[] = body.subQueries;
        if (!subQueries || !Array.isArray(subQueries) || subQueries.length === 0) {
          return json({ error: "subQueries array is required" }, 400);
        }

        const start = Date.now();
        const retrieved = await retrieve(env, subQueries, {
          rerankThreshold: body.rerankThreshold,
          existingIds: body.existingIds ? new Set(body.existingIds) : undefined,
        });
        const durationMs = Date.now() - start;
        console.log(`[/query/retrieve] ${retrieved.length} units duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "retrieve", { subQueries }, { count: retrieved.length }, durationMs, body.conversationId);
        }

        return json({
          retrievedUnits: retrieved.map((r) => ({
            id: r.unit.id,
            type: r.unit.type,
            name: r.unit.name,
            section: r.unit.section,
            page: r.unit.page,
            content: r.unit.content,
            vectorScore: r.vectorScore,
            rerankScore: r.rerankScore,
            sourceSubQueries: r.sourceSubQueries,
          })),
          durationMs,
        });
      }

      // POST /query/sufficiency { russianQuery, retrievedUnits, subQueries }
      // Step 5: Sufficiency check + follow-up query generation.
      if (url.pathname === "/query/sufficiency" && request.method === "POST") {
        const body = await request.json<any>();
        const russianQuery: string = body.russianQuery;
        const subQueries: string[] = body.subQueries;
        if (!russianQuery || !subQueries) {
          return json({ error: "russianQuery and subQueries are required" }, 400);
        }

        // Reconstruct RetrievedUnit[] from the flat JSON
        const retrieved = (body.retrievedUnits ?? []).map((r: any) => ({
          unit: {
            id: r.id,
            type: r.type,
            name: r.name,
            section: r.section,
            page: r.page,
            content: r.content,
          },
          rerankScore: r.rerankScore,
          sourceSubQueries: r.sourceSubQueries,
        }));

        const start = Date.now();
        const result = await checkSufficiency(env, russianQuery, retrieved, subQueries);
        const durationMs = Date.now() - start;
        console.log(`[/query/sufficiency] sufficient=${result.sufficient} gaps=${result.gaps.length} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "sufficiency", { russianQuery }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/answer { question, language, retrievedUnits, subQueries?, gaps? }
      // Step 6: Answer generation with citations.
      if (url.pathname === "/query/answer" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const retrieved = (body.retrievedUnits ?? []).map((r: any) => ({
          unit: {
            id: r.id,
            type: r.type,
            name: r.name,
            section: r.section,
            page: r.page,
            content: r.content,
          },
          rerankScore: r.rerankScore,
        }));

        const start = Date.now();
        const result = await generateAnswer(env, question, retrieved, {
          language: body.language ?? "ru",
          subQueries: body.subQueries,
          gaps: body.gaps,
        });
        const durationMs = Date.now() - start;
        console.log(`[/query/answer] ${result.citations.length} citations duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "answer", { question }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }


      // GET /debug/sources
      // Lists all structure nodes that have semantic units, with unit counts.
      // Used by the tree viewer to populate the source node dropdown.
      if (url.pathname === "/debug/sources" && request.method === "GET") {
        const sources = await getSourceNodesWithUnits(env);
        return json({ sources });
      }

      // GET /debug/concepts
      // Lists all concepts with their aliases and mention counts.
      // Used by the debug viewer to visualize the concept layer.
      if (url.pathname === "/debug/concepts" && request.method === "GET") {
        const { results: concepts } = await env.DB.prepare(
          `SELECT c.id, c.canonical_name, c.description, c.created_at,
             (SELECT COUNT(*) FROM concept_aliases a WHERE a.concept_id = c.id) as alias_count,
             (SELECT COUNT(*) FROM concept_mentions m WHERE m.concept_id = c.id) as mention_count
           FROM concepts c
           ORDER BY c.canonical_name`
        ).all();
        return json({ concepts: concepts ?? [] });
      }

      // GET /debug/concepts/:id
      // Returns detailed information about a single concept, including aliases and mentions.
      if (url.pathname.startsWith("/debug/concepts/") && request.method === "GET") {
        const conceptId = url.pathname.replace("/debug/concepts/", "");
        const concept = await env.DB.prepare(`SELECT * FROM concepts WHERE id = ?`).bind(conceptId).first();
        if (!concept) return json({ error: "Concept not found" }, 404);
        const [aliases, mentions] = await Promise.all([
          env.DB.prepare(`SELECT alias, source, confidence FROM concept_aliases WHERE concept_id = ?`).bind(conceptId).all(),
          env.DB.prepare(
            `SELECT cm.id, cm.unit_id, cm.raw_term, cm.mention_type, cm.confidence, cm.resolution_method, cm.created_at,
                    su.name as unit_name, su.type as unit_type
             FROM concept_mentions cm
             JOIN semantic_units su ON su.id = cm.unit_id
             WHERE cm.concept_id = ?
             ORDER BY cm.created_at`
          ).bind(conceptId).all(),
        ]);
        return json({ concept, aliases: aliases.results ?? [], mentions: mentions.results ?? [] });
      }

      // GET /debug/tree?format=tree|flat&sourceNodeId=<id>
      // Returns the semantic unit hierarchy for visualization.
      // - format=flat (default): array of {id, parentId, type, name, section, status}
      // - format=tree: nested tree rooted at units with no parent
      // - sourceNodeId: filter to units from a specific structure node (table/rule)
      if (url.pathname === "/debug/tree" && request.method === "GET") {
        const format = url.searchParams.get("format") ?? "flat";
        const sourceNodeId = url.searchParams.get("sourceNodeId");
        let units = await getAllUnits(env);
        if (sourceNodeId) {
          units = units.filter((u) => u.sourceNodeId === sourceNodeId);
        }
        const flat = units.map((u) => ({
          id: u.id,
          parentId: u.parentUnitId ?? null,
          type: u.type,
          name: u.name ?? "",
          content: u.content ?? "",
          section: u.section,
          page: u.page,
          status: u.status,
          sourceNodeId: u.sourceNodeId,
        }));
        if (format === "tree") {
          const byId = new Map(flat.map((u) => [u.id, { ...u, children: [] as any[] }]));
          const roots: any[] = [];
          for (const u of byId.values()) {
            // Guard against self-parenting (cycles break tree layout)
            if (u.parentId && u.parentId !== u.id && byId.has(u.parentId)) {
              byId.get(u.parentId)!.children.push(u);
            } else {
              roots.push(u);
            }
          }
          return json({ roots });
        }
        return json({ units: flat });
      }

      // GET /debug/unit/:id
      // Returns comprehensive data for a single unit: all fields, metadata,
      // concept mentions, parent/child units,
      // and the source structure node. Used by the tree viewer side panel.
      {
        const unitMatch = url.pathname.match(/^\/debug\/unit\/(.+)$/);
        if (unitMatch && request.method === "GET") {
          const details = await getUnitDetails(env, unitMatch[1]);
          if (!details) return json({ error: "unit not found" }, 404);
          return json(details);
        }
      }

      // PUT /debug/unit/:id
      // Updates editable fields of a semantic unit (content, name, section, type, parentId).
      // Used by the debug frontend to correct vision extraction errors.
      {
        const unitMatch = url.pathname.match(/^\/debug\/unit\/(.+)$/);
        if (unitMatch && request.method === "PUT") {
          const body = await request.json<any>();
          await updateUnit(env, unitMatch[1], {
            content: body.content,
            name: body.name,
            section: body.section,
            type: body.type,
            parentUnitId: body.parentUnitId,
          });
          return json({ ok: true, unitId: unitMatch[1] });
        }
      }

      // GET /debug/logs?since=<ISO>&limit=<n>
      // Returns debug log entries from the ingestion/retrieval pipelines.
      // If `since` is provided, returns only logs created after that timestamp
      // (ascending order) — used for polling. Otherwise returns the most recent
      // `limit` logs (descending order).
      if (url.pathname === "/debug/logs" && request.method === "GET") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
        const logs = await getDebugLogs(env, since, limit);
        return json({ logs });
      }

      // DELETE /debug/logs
      // Clears all debug log entries.
      if (url.pathname === "/debug/logs" && request.method === "DELETE") {
        await clearDebugLogs(env);
        return json({ ok: true });
      }

      // GET /debug/candidates?query=<text>&limit=<n>
      // Phase 10: Returns candidate logs for a specific query — per-stage
      // candidate data and provenance for diagnostics.
      if (url.pathname === "/debug/candidates" && request.method === "GET") {
        const query = url.searchParams.get("query") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
        if (!query) return json({ error: "query parameter is required" }, 400);
        const logs = await getCandidateLogs(env, query, limit);
        return json({ logs });
      }

      // DELETE /debug/candidates
      // Phase 10: Clears all candidate log entries.
      if (url.pathname === "/debug/candidates" && request.method === "DELETE") {
        await clearCandidateLogs(env);
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      console.error(err?.stack ?? err); // full detail in `wrangler tail`, not in the response
      try { await logDebug(env, "error", "worker", err?.message ?? "internal error", { stack: err?.stack }); } catch {}
      return json({ error: err?.message ?? "internal error" }, 500);
    }
  },

  // Queue handler — processes vision pages from the VISION_QUEUE.
  // With max_concurrency=1, pages are processed sequentially in FIFO order,
  // ensuring continuation state is consistent between pages.
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { jobId, documentId, pageNumber } = message.body;
      try {
        await processVisionPage(env, jobId, documentId, pageNumber);
        message.ack();
      } catch (err: any) {
        console.error(`[queue] page ${pageNumber} failed: ${err?.message}`);
        try {
          await logDebug(env, "error", "ingestion:vision", `Queue page ${pageNumber} failed`, {
            jobId,
            documentId,
            pageNumber,
            error: err?.message,
            stack: err?.stack,
          });
        } catch {}
        // Retry: the message will be redelivered up to max_retries times
        message.retry();
      }
    }
  },
};
