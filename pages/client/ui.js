/**
 * Slitherer RAG — UI Controller
 * Manages tabbed chat, parameter controls, streaming display,
 * and intermediate thinking steps.
 */

(function () {
  const API = window.SlithererAPI;
  const API_URL = API.DEFAULT_BASE_URL; // hardcoded, not user-editable
  let apiKey = ""; // set after login, not exposed in sidebar

  // ---- Tab state ----
  // Each tab: { id, conversationId, title, messagesEl, isStreaming, abortController }
  const tabs = [];
  let activeTabId = null;
  let tabCounter = 0;

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const tabBar = $("tab-bar");
  const messagesContainer = $("messages");
  const inputEl = $("message-input");
  const sendBtn = $("send-btn");
  const stopBtn = $("stop-btn");
  const newChatBtn = $("new-chat-btn");

  // Param controls
  const paramMode = $("param-mode");
  const paramStream = $("param-stream");
  const paramDebug = $("param-debug");
  const paramMaxIterations = $("param-max-iterations");
  const maxIterationsVal = $("max-iterations-val");
  const connectionStatus = $("connection-status");
  const connectionText = $("connection-text");

  // ---- Login gate ----

  const CFG = (typeof PAGES_CONFIG !== "undefined" && PAGES_CONFIG.client) || {};
  const STORAGE_KEY = CFG.authStorageKey || "slitherer_rag_auth";
  const ASSISTANT_NAME = CFG.ui?.assistantName || "SLITHERER";
  const ASSISTANT_BADGE = CFG.ui?.assistantBadge || "S";
  const USER_BADGE = CFG.ui?.userBadge || "U";
  const loginScreen = $("login-screen");
  const appEl = $("app");
  const loginForm = $("login-form");
  const loginToken = $("login-token");
  const loginBtn = $("login-btn");
  const loginError = $("login-error");

  function getStoredAuth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function storeAuth(token) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: token }));
  }

  function clearAuth() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function showApp(token) {
    apiKey = token;
    loginScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    // Create first tab
    if (tabs.length === 0) {
      createTab();
    }
    inputEl.focus();
    updateConnectionStatus();
  }

  function showLogin() {
    appEl.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    loginToken.focus();
  }

  async function handleLogin(e) {
    e.preventDefault();
    const token = loginToken.value.trim();
    if (!token) {
      loginError.textContent = "API token is required";
      loginError.classList.remove("hidden");
      return;
    }
    loginError.classList.add("hidden");
    loginBtn.classList.add("loading");
    loginBtn.textContent = "Connecting...";

    const result = await API.verifyToken(API_URL, token);
    loginBtn.classList.remove("loading");
    loginBtn.textContent = "Connect";

    if (result.ok) {
      storeAuth(token);
      showApp(token);
    } else {
      console.error("Login failed:", result.error);
      loginError.textContent = result.error || "Unknown error";
      loginError.classList.remove("hidden");
    }
  }

  function logout() {
    clearAuth();
    apiKey = "";
    // Clear all tabs
    tabs.length = 0;
    activeTabId = null;
    tabBar.innerHTML = "";
    showLogin();
    loginToken.value = "";
  }

  // ---- Tab management ----

  function createTab() {
    tabCounter++;
    const tabId = `tab-${tabCounter}`;
    const conversationId = API.generateConversationId();

    const tab = {
      id: tabId,
      conversationId,
      title: `Chat ${tabCounter}`,
      isStreaming: false,
      abortController: null,
      messages: [], // stored message DOM elements
    };

    tabs.push(tab);

    // Create tab button
    const tabEl = document.createElement("div");
    tabEl.className = "tab";
    tabEl.dataset.tabId = tabId;
    tabEl.innerHTML = `
      <span class="tab-label">${tab.title}</span>
      <span class="tab-close" title="Close tab">×</span>
    `;
    tabEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) {
        closeTab(tabId);
      } else {
        switchTab(tabId);
      }
    });
    tabBar.appendChild(tabEl);

    switchTab(tabId);
    return tab;
  }

  function switchTab(tabId) {
    activeTabId = tabId;

    // Update tab button styles
    document.querySelectorAll(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tabId === tabId);
    });

    // Rebuild messages container for this tab
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Clear container
    messagesContainer.innerHTML = "";

    // If tab has no messages, show welcome
    if (tab.messages.length === 0) {
      messagesContainer.innerHTML = `
        <div class="welcome-message">
          <h2>Slitherer RAG</h2>
          <p>Ask questions about tabletop RPG rules. The system will route, decompose, retrieve, and iterate to find the best answer.</p>
          <p class="hint">Try: "Как работает оглушение?" or "What are the combat modifiers?"</p>
        </div>
      `;
    } else {
      // Re-append stored message elements
      for (const msgEl of tab.messages) {
        messagesContainer.appendChild(msgEl);
      }
    }

    inputEl.focus();
    scrollToBottom();
  }

  function closeTab(tabId) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    // Abort streaming if active
    const tab = tabs[idx];
    if (tab.abortController) {
      tab.abortController.abort();
    }

    tabs.splice(idx, 1);

    // Remove tab button
    const tabEl = tabBar.querySelector(`[data-tab-id="${tabId}"]`);
    if (tabEl) tabEl.remove();

    // If we closed the active tab, switch to another or create new
    if (activeTabId === tabId) {
      if (tabs.length > 0) {
        switchTab(tabs[tabs.length - 1].id);
      } else {
        createTab();
      }
    }
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId);
  }

  function updateTabTitle(tabId, title) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.title = title;
    const labelEl = tabBar.querySelector(`[data-tab-id="${tabId}"] .tab-label`);
    if (labelEl) labelEl.textContent = title;
  }

  function setTabStreaming(tabId, streaming) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.isStreaming = streaming;
    const tabEl = tabBar.querySelector(`[data-tab-id="${tabId}"]`);
    if (!tabEl) return;
    // Add/remove spinner
    let spinner = tabEl.querySelector(".tab-spinner");
    if (streaming) {
      if (!spinner) {
        spinner = document.createElement("span");
        spinner.className = "tab-spinner";
        tabEl.insertBefore(spinner, tabEl.firstChild);
      }
    } else if (spinner) {
      spinner.remove();
    }
  }

  // ---- Parameter helpers ----

  function getParams() {
    return {
      apiUrl: API_URL,
      apiKey: apiKey,
      mode: paramMode.value,
      stream: paramStream.checked,
      debug: paramDebug.checked,
      maxIterations: parseInt(paramMaxIterations.value, 10),
    };
  }

  // ---- Connection status ----

  async function updateConnectionStatus() {
    connectionStatus.className = "status-dot status-loading";
    connectionText.textContent = "Checking...";
    const result = await API.verifyToken(API_URL, apiKey);
    if (result.ok) {
      connectionStatus.className = "status-dot status-ok";
      connectionText.textContent = "Connected";
    } else {
      connectionStatus.className = "status-dot status-error";
      connectionText.textContent = "Disconnected";
    }
  }

  // ---- Message rendering ----

  function addUserMessage(text) {
    const el = document.createElement("div");
    el.className = "message user";
    el.innerHTML = `
      <div class="message-header">
        <span class="message-role-badge user">${USER_BADGE}</span>
        <span>You</span>
      </div>
      <div class="message-content"></div>
    `;
    el.querySelector(".message-content").textContent = text;
    messagesContainer.appendChild(el);

    // Store in active tab
    const tab = getActiveTab();
    if (tab) tab.messages.push(el);

    scrollToBottom();
    return el;
  }

  function addSlithererMessage() {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = `
      <div class="message-header">
        <span class="message-role-badge slitherer">${ASSISTANT_BADGE}</span>
        <span>${ASSISTANT_NAME}</span>
      </div>
      <div class="thinking-container"></div>
      <div class="message-content"></div>
      <div class="citations"></div>
    `;
    messagesContainer.appendChild(el);

    // Store in active tab
    const tab = getActiveTab();
    if (tab) tab.messages.push(el);

    scrollToBottom();
    return {
      el,
      contentEl: el.querySelector(".message-content"),
      citationsEl: el.querySelector(".citations"),
      thinkingEl: el.querySelector(".thinking-container"),
    };
  }

  /** Add a thinking/intermediate step block (greyed out, expandable). */
  function addThinkingBlock(thinkingContainer, stepName, label) {
    const block = document.createElement("div");
    block.className = "thinking-block";
    block.dataset.step = stepName;
    block.innerHTML = `
      <div class="thinking-header">
        <span class="chevron">▶</span>
        <span class="thinking-step-label">${label}</span>
        <span class="thinking-step-status active">running...</span>
      </div>
      <div class="thinking-body"></div>
    `;
    block.querySelector(".thinking-header").addEventListener("click", () => {
      block.classList.toggle("expanded");
    });
    thinkingContainer.appendChild(block);
    scrollToBottom();
    return {
      block,
      statusEl: block.querySelector(".thinking-step-status"),
      bodyEl: block.querySelector(".thinking-body"),
    };
  }

  function updateThinkingStatus(thinkingBlock, status, data) {
    thinkingBlock.statusEl.className = `thinking-step-status ${status}`;
    if (status === "done") {
      thinkingBlock.statusEl.textContent = "done";
      if (data) {
        renderThinkingBody(thinkingBlock.bodyEl, thinkingBlock.block.dataset.step, data);
      }
    } else if (status === "active") {
      thinkingBlock.statusEl.textContent = "running...";
    } else if (status === "error") {
      thinkingBlock.statusEl.textContent = "error";
    }
  }

  function renderThinkingBody(bodyEl, stepName, data) {
    const sections = [];

    if (stepName === "router" || stepName.startsWith("router")) {
      sections.push({ title: "RAG", data: data.rag ? "Yes" : "No (chat)" });
      sections.push({ title: "Language", data: data.language });
      sections.push({ title: "Russian Query", data: data.russianQuery });
      if (data.chatResponse) sections.push({ title: "Chat Response", data: data.chatResponse });
      if (data.durationMs) sections.push({ title: "Duration", data: `${data.durationMs}ms` });
    } else if (stepName === "decompose" || stepName.startsWith("decompose")) {
      sections.push({ title: "Sub-queries", data: data.subQueries?.map((q, i) => `${i + 1}. ${q}`).join("\n") });
      sections.push({ title: "Rerank Threshold", data: data.rerankThreshold });
      if (data.durationMs) sections.push({ title: "Duration", data: `${data.durationMs}ms` });
    } else if (stepName.startsWith("retrieve")) {
      const units = data.retrievedUnits || [];
      sections.push({ title: `Retrieved Units (${units.length})`, data: units.slice(0, 10).map((u) =>
        `[${u.id}] ${u.type} — ${u.name || "(unnamed)"}\n  section: ${Array.isArray(u.section) ? u.section.join(" > ") : u.section}\n  page: ${u.page}\n  rerank: ${u.rerankScore?.toFixed(3) ?? "n/a"}\n  via: ${u.sourceSubQueries ? "sub-query " + u.sourceSubQueries.join(",") : "seed"}`
      ).join("\n\n") + (units.length > 10 ? `\n\n... and ${units.length - 10} more` : "") });
      if (data.durationMs) sections.push({ title: "Duration", data: `${data.durationMs}ms` });
    } else if (stepName.startsWith("sufficiency")) {
      sections.push({ title: "Sufficient", data: data.sufficient ? "Yes" : "No" });
      if (data.gaps?.length) sections.push({ title: "Gaps", data: data.gaps.map((g) => `- ${g}`).join("\n") });
      if (data.followUpQueries?.length) sections.push({ title: "Follow-up Queries", data: data.followUpQueries.map((q, i) => `${i + 1}. ${q}`).join("\n") });
      if (data.durationMs) sections.push({ title: "Duration", data: `${data.durationMs}ms` });
    } else if (stepName === "answer") {
      sections.push({ title: "Language", data: data.language });
      if (data.citations?.length) sections.push({ title: "Citations", data: data.citations.map((c) => `[${c.unitId}] ${c.section} (p.${c.page})`).join("\n") });
      if (data.usedUnitIds?.length) sections.push({ title: "Used Units", data: data.usedUnitIds.join(", ") });
      if (data.durationMs) sections.push({ title: "Duration", data: `${data.durationMs}ms` });
    } else if (stepName === "final") {
      sections.push({ title: "Total Evidence Units", data: data.finalCount ?? data });
    }

    bodyEl.innerHTML = sections.map((s) =>
      `<div class="step-section"><div class="step-title">${s.title}</div><div class="step-data">${escapeHtml(s.data ?? "")}</div></div>`
    ).join("");
  }

  function renderCitations(citationsEl, citations) {
    citationsEl.innerHTML = "";
    if (!citations || citations.length === 0) return;
    for (const c of citations) {
      const chip = document.createElement("span");
      chip.className = "citation-chip";
      chip.textContent = `[${c.unitId}] p.${c.page}`;
      chip.title = c.section;
      citationsEl.appendChild(chip);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ---- Send message ----

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    const tab = getActiveTab();
    if (!tab || tab.isStreaming) return;

    // Update tab title with first message
    if (tab.messages.length === 0) {
      updateTabTitle(tab.id, text.slice(0, 30) + (text.length > 30 ? "..." : ""));
    }

    // Add user message
    addUserMessage(text);

    // Clear input
    inputEl.value = "";
    autoResize();

    // Start streaming state
    tab.isStreaming = true;
    tab.abortController = new AbortController();
    setTabStreaming(tab.id, true);
    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");

    // Add SLITHERER message placeholder
    const slitherer = addSlithererMessage();

    const params = getParams();
    params.question = text;
    params.conversationId = tab.conversationId;

    try {
      if (params.mode === "staged") {
        await sendStaged(params, slitherer, tab);
      } else {
        await sendFull(params, slitherer);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        slitherer.contentEl.textContent += "\n\n[stopped by user]";
      } else {
        console.error(err);
        slitherer.contentEl.textContent = `Error: ${err.message}`;
        slitherer.contentEl.style.color = "#f44336";
      }
    } finally {
      tab.isStreaming = false;
      tab.abortController = null;
      setTabStreaming(tab.id, false);
      sendBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
      slitherer.contentEl.classList.remove("streaming");
      scrollToBottom();
    }
  }

  /** Full mode: all-in-one /query endpoint. */
  async function sendFull(params, slitherer) {
    if (params.stream) {
      let firstChunk = true;
      await API.fullQuery(params.apiUrl, params.apiKey, params, {
        onChunk: (chunk) => {
          if (firstChunk) {
            slitherer.contentEl.classList.add("streaming");
            firstChunk = false;
          }
          slitherer.contentEl.textContent += chunk;
          scrollToBottom();
        },
        onResult: (result) => {
          slitherer.contentEl.classList.remove("streaming");
          slitherer.contentEl.textContent = result.answer;
          renderCitations(slitherer.citationsEl, result.citations);
          if (params.debug && result.debug) {
            renderDebugInfo(slitherer.thinkingEl, result.debug);
          }
        },
        onError: (err) => { throw err; },
        signal: getActiveTab()?.abortController?.signal,
      });
    } else {
      const result = await API.fullQuery(params.apiUrl, params.apiKey, params, {
        signal: getActiveTab()?.abortController?.signal,
      });
      slitherer.contentEl.textContent = result.answer;
      renderCitations(slitherer.citationsEl, result.citations);
      if (params.debug && result.debug) {
        renderDebugInfo(slitherer.thinkingEl, result.debug);
      }
      if (result.retrievedUnits) {
        const tb = addThinkingBlock(slitherer.thinkingEl, "retrieve", `Retrieved Units (${result.retrievedUnits.length})`);
        updateThinkingStatus(tb, "done", { retrievedUnits: result.retrievedUnits });
      }
    }
  }

  /** Staged mode: step-by-step endpoints with intermediate output. */
  async function sendStaged(params, slitherer, tab) {
    const stepLabels = {
      router: "Router (RAG/chat + language + translation)",
      decompose: "Decomposition (sub-queries + threshold)",
      retrieve: "Retrieval (vector search + expansion + rerank)",
      "retrieve-2": "Retrieval (follow-up iteration 2)",
      "retrieve-3": "Retrieval (follow-up iteration 3)",
      "retrieve-4": "Retrieval (follow-up iteration 4)",
      "retrieve-5": "Retrieval (follow-up iteration 5)",
      sufficiency: "Sufficiency Check",
      "sufficiency-2": "Sufficiency Check (iteration 2)",
      "sufficiency-3": "Sufficiency Check (iteration 3)",
      "sufficiency-4": "Sufficiency Check (iteration 4)",
      "sufficiency-5": "Sufficiency Check (iteration 5)",
      answer: "Answer Generation",
    };

    const thinkingBlocks = {};

    await API.stagedQuery(params.apiUrl, params.apiKey, params, {
      onStep: (stepName, status, data) => {
        const label = stepLabels[stepName] || stepName;
        if (status === "active") {
          thinkingBlocks[stepName] = addThinkingBlock(slitherer.thinkingEl, stepName, label);
          thinkingBlocks[stepName].block.classList.add("expanded");
        } else if (status === "done" && thinkingBlocks[stepName]) {
          updateThinkingStatus(thinkingBlocks[stepName], "done", data);
          thinkingBlocks[stepName].block.classList.remove("expanded");
        }
      },
      onChunk: (chunk) => {
        slitherer.contentEl.classList.add("streaming");
        slitherer.contentEl.textContent += chunk;
        scrollToBottom();
      },
      onResult: (result) => {
        slitherer.contentEl.classList.remove("streaming");
        slitherer.contentEl.textContent = result.answer;
        renderCitations(slitherer.citationsEl, result.citations);
      },
      onError: (err) => { throw err; },
      signal: tab.abortController?.signal,
    });
  }

  /** Render debug info from full-mode response into thinking blocks. */
  function renderDebugInfo(thinkingEl, debug) {
    if (debug.router) {
      const tb = addThinkingBlock(thinkingEl, "router", "Router (RAG/chat + language + translation)");
      updateThinkingStatus(tb, "done", debug.router);
    }
    if (debug.decomposition) {
      const tb = addThinkingBlock(thinkingEl, "decompose", "Decomposition (sub-queries + threshold)");
      updateThinkingStatus(tb, "done", debug.decomposition);
    }
    if (debug.iterations) {
      for (const iter of debug.iterations) {
        const retrieveName = iter.iteration === 1 ? "retrieve" : `retrieve-${iter.iteration}`;
        const suffName = iter.iteration === 1 ? "sufficiency" : `sufficiency-${iter.iteration}`;
        const tb = addThinkingBlock(thinkingEl, retrieveName, `Retrieval (iteration ${iter.iteration})`);
        updateThinkingStatus(tb, "done", { _meta: iter });
        tb.bodyEl.innerHTML = `
          <div class="step-section"><div class="step-title">Sub-queries</div><div class="step-data">${escapeHtml(iter.subQueries.map((q,i) => `${i+1}. ${q}`).join("\n"))}</div></div>
          <div class="step-section"><div class="step-title">Candidates Found</div><div class="step-data">${iter.candidatesFound}</div></div>
          <div class="step-section"><div class="step-title">After Rerank (total)</div><div class="step-data">${iter.afterRerank}</div></div>
        `;
        if (iter.sufficiency) {
          const stb = addThinkingBlock(thinkingEl, suffName, `Sufficiency Check (iteration ${iter.iteration})`);
          updateThinkingStatus(stb, "done", iter.sufficiency);
        }
      }
    }
    if (debug.finalEvidenceCount !== undefined) {
      const tb = addThinkingBlock(thinkingEl, "final", "Final Evidence");
      updateThinkingStatus(tb, "done", { finalCount: debug.finalEvidenceCount });
    }
  }

  // ---- Stop streaming ----

  function stopStreaming() {
    const tab = getActiveTab();
    if (tab?.abortController) {
      tab.abortController.abort();
    }
  }

  // ---- Auto-resize textarea ----

  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  }

  // ---- Init ----

  async function init() {
    const stored = getStoredAuth();
    if (stored && stored.apiKey) {
      const result = await API.verifyToken(API_URL, stored.apiKey);
      if (result.ok) {
        showApp(stored.apiKey);
        return;
      }
      console.warn("Stored token invalid:", result.error);
    }
    showLogin();
  }

  // ---- Event listeners ----

  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", stopStreaming);
  newChatBtn.addEventListener("click", () => createTab());

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener("input", autoResize);

  paramMaxIterations.addEventListener("input", () => {
    maxIterationsVal.textContent = paramMaxIterations.value;
  });

  loginForm.addEventListener("submit", handleLogin);

  const logoutBtn = $("logout-btn");
  logoutBtn.addEventListener("click", logout);

  // ---- Start ----

  init();
})();
