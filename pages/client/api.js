/**
 * Slitherer RAG — API Client
 * Handles both full (all-in-one) and staged (step-by-step) request modes,
 * plus SSE streaming.
 */

// PAGES_CONFIG is defined in config.js (auto-generated from config/pages.yaml)
const DEFAULT_BASE_URL = (typeof PAGES_CONFIG !== "undefined" && PAGES_CONFIG.api?.baseUrl) || "https://api.slitherer.workers.dev";

/** Generate a new conversation ID. */
function generateConversationId() {
  return `CONV-${crypto.randomUUID()}`;
}

/** Build headers for API requests. */
function buildHeaders(apiKey) {
  const headers = { "content-type": "application/json" };
  if (apiKey && apiKey.trim()) {
    headers["authorization"] = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

/**
 * Full mode: call /query with all parameters.
 * Returns a ReadableStream (if streaming) or a JSON response.
 */
async function fullQuery(baseUrl, apiKey, params, { onChunk, onResult, onError, signal }) {
  const body = {
    question: params.question,
    conversationId: params.conversationId,
    debug: params.debug,
    graphHops: params.graphHops,
    maxIterations: params.maxIterations,
  };

  if (params.stream) {
    body.stream = true;
    return streamSSE(`${baseUrl}/query`, apiKey, body, { onChunk, onResult, onError, signal });
  } else {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return await res.json();
  }
}

/**
 * Staged mode: call each step endpoint sequentially.
 * Calls onStep callback after each step with the step name and result.
 */
async function stagedQuery(baseUrl, apiKey, params, { onStep, onChunk, onResult, onError, signal }) {
  const headers = buildHeaders(apiKey);

  // Step 1: Router
  onStep("router", "active");
  const routerRes = await fetch(`${baseUrl}/query/router`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: params.question,
      conversationId: params.conversationId,
    }),
    signal,
  });
  if (!routerRes.ok) throw new Error(`Router failed: ${routerRes.statusText}`);
  const routerResult = await routerRes.json();
  onStep("router", "done", routerResult);

  // If not RAG, return chat response
  if (!routerResult.rag) {
    onStep("answer", "done", { answer: routerResult.chatResponse, citations: [], language: routerResult.language });
    return {
      answer: routerResult.chatResponse,
      citations: [],
      usedUnitIds: [],
      language: routerResult.language,
      _staged: { router: routerResult },
    };
  }

  // Step 2: Decompose
  onStep("decompose", "active");
  const decomposeRes = await fetch(`${baseUrl}/query/decompose`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      russianQuery: routerResult.russianQuery,
      conversationId: params.conversationId,
    }),
    signal,
  });
  if (!decomposeRes.ok) throw new Error(`Decompose failed: ${decomposeRes.statusText}`);
  const decomposeResult = await decomposeRes.json();
  onStep("decompose", "done", decomposeResult);

  let allRetrievedUnits = [];
  let allGaps = [];
  let iterations = 0;
  const maxIter = params.maxIterations || 3;
  let currentSubQueries = decomposeResult.subQueries;
  let sufficiencyResult = null;

  // Iterative retrieval loop
  while (iterations < maxIter) {
    iterations++;
    const iterLabel = iterations === 1 ? "retrieve" : `retrieve-${iterations}`;
    const suffLabel = iterations === 1 ? "sufficiency" : `sufficiency-${iterations}`;

    // Step 3+4: Retrieve
    onStep(iterLabel, "active");
    const existingIds = allRetrievedUnits.map((u) => u.id);
    const retrieveRes = await fetch(`${baseUrl}/query/retrieve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subQueries: currentSubQueries,
        rerankThreshold: decomposeResult.rerankThreshold,
        graphHops: params.graphHops,
        existingIds,
      }),
      signal,
    });
    if (!retrieveRes.ok) throw new Error(`Retrieve failed: ${retrieveRes.statusText}`);
    const retrieveResult = await retrieveRes.json();
    onStep(iterLabel, "done", retrieveResult);

    // Merge retrieved units (dedupe by id)
    const existingMap = new Map(allRetrievedUnits.map((u) => [u.id, u]));
    for (const u of retrieveResult.retrievedUnits) {
      if (!existingMap.has(u.id)) {
        allRetrievedUnits.push(u);
        existingMap.set(u.id, u);
      }
    }

    // Step 5: Sufficiency (skip on last iteration)
    if (iterations < maxIter) {
      onStep(suffLabel, "active");
      const suffRes = await fetch(`${baseUrl}/query/sufficiency`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          russianQuery: routerResult.russianQuery,
          retrievedUnits: allRetrievedUnits,
          subQueries: currentSubQueries,
        }),
        signal,
      });
      if (!suffRes.ok) throw new Error(`Sufficiency failed: ${suffRes.statusText}`);
      sufficiencyResult = await suffRes.json();
      onStep(suffLabel, "done", sufficiencyResult);

      allGaps = [...allGaps, ...sufficiencyResult.gaps];

      if (sufficiencyResult.sufficient || sufficiencyResult.followUpQueries.length === 0) {
        break;
      }
      currentSubQueries = sufficiencyResult.followUpQueries;
    }
  }

  // Step 6: Answer
  onStep("answer", "active");
  const answerRes = await fetch(`${baseUrl}/query/answer`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: params.question,
      language: routerResult.language,
      retrievedUnits: allRetrievedUnits,
      subQueries: decomposeResult.subQueries,
      gaps: allGaps,
    }),
    signal,
  });
  if (!answerRes.ok) throw new Error(`Answer failed: ${answerRes.statusText}`);
  const answerResult = await answerRes.json();
  onStep("answer", "done", answerResult);

  return {
    ...answerResult,
    retrievedUnits: allRetrievedUnits,
    _staged: {
      router: routerResult,
      decompose: decomposeResult,
      iterations,
      gaps: allGaps,
      sufficiency: sufficiencyResult,
    },
  };
}

/**
 * Stream SSE from an endpoint. Calls onChunk for each token chunk,
 * onResult for the final result event, onError on error.
 */
async function streamSSE(url, apiKey, body, { onChunk, onResult, onError, signal }) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        try {
          const parsed = JSON.parse(data);
          if (currentEvent === "result") {
            if (onResult) onResult(parsed);
          } else if (currentEvent === "error") {
            if (onError) onError(new Error(parsed.error));
          } else {
            if (parsed.chunk && onChunk) onChunk(parsed.chunk);
          }
        } catch {
          // ignore malformed JSON
        }
        currentEvent = null;
      }
    }
  }
}

/** Verify API key by calling /query/verify. Returns { ok, error }. */
async function verifyToken(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/query/verify`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({}),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "Invalid API token" };
    return { ok: false, error: `Server returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/** Check API connectivity by sending a simple test request. */
async function checkConnection(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/query/verify`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({}),
    });
    return res.ok || res.status !== 404; // 404 = wrong URL, anything else = server is up
  } catch {
    return false;
  }
}

// Export for use in ui.js
window.SlithererAPI = {
  DEFAULT_BASE_URL,
  generateConversationId,
  fullQuery,
  stagedQuery,
  verifyToken,
  checkConnection,
};
