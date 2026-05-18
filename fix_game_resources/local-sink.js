/**
 * HTTP client for poki-dl-server（与 download-poki-game 共用 pokiSinkSettings）
 */

export const SINK_SETTINGS_KEY = "pokiSinkSettings";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:22222";
const BATCH_SIZE = 40;
const FLUSH_MS = 200;

/** @type {{ enabled: boolean, serverUrl: string, outputRoot: string } | null} */
let settings = null;

/** @type {string | null} */
let sessionId = null;

/** @type {{ sourceUrl?: string, relPath: string, body?: string, encoding?: string, overwrite?: boolean }[]} */
let pendingBatch = [];

let flushTimer = null;
/** @type {Promise<{ results: object[] }>} */
let flushChain = Promise.resolve({ results: [] });

function mergeSinkSettings(saved = {}, overrides = {}) {
  const serverUrl = String(overrides.serverUrl ?? saved.serverUrl ?? DEFAULT_SERVER_URL)
    .trim()
    .replace(/\/+$/, "");
  return {
    enabled: overrides.enabled ?? saved.enabled ?? true,
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    outputRoot: String(overrides.outputRoot ?? saved.outputRoot ?? "").trim()
  };
}

export function isEnabled() {
  return !!settings?.enabled;
}

async function refreshOutputRootFromServer() {
  const health = await healthCheck();
  const root = String(health.defaultOutputRoot || "").trim();
  if (root) settings.outputRoot = root;
  return root;
}

export async function loadSettings(overrides = {}) {
  const stored = await chrome.storage.local.get(SINK_SETTINGS_KEY);
  const saved = stored[SINK_SETTINGS_KEY] || {};
  settings = mergeSinkSettings(saved, overrides);
  if (settings.enabled && !settings.outputRoot) {
    try {
      await refreshOutputRootFromServer();
    } catch {
      /* 见 download-poki-game/local-sink.js */
    }
  }
  return settings;
}

export async function saveSettings(next) {
  settings = mergeSinkSettings(settings || {}, next || {});
  await chrome.storage.local.set({
    [SINK_SETTINGS_KEY]: {
      enabled: settings.enabled !== false,
      serverUrl: settings.serverUrl,
      outputRoot: settings.outputRoot
    }
  });
  return settings;
}

export function getSettings() {
  return settings;
}

export function getSessionId() {
  return sessionId;
}

async function api(path, options = {}) {
  const base = settings?.serverUrl || DEFAULT_SERVER_URL;
  const res = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `本地服务 HTTP ${res.status}`);
  }
  return data;
}

export async function healthCheck() {
  const data = await api("/health");
  if (!data?.ok) throw new Error("本地服务未就绪");
  return data;
}

export async function pingServer(overrides = {}) {
  await loadSettings(overrides);
  if (!settings.enabled) return { mode: "chrome-downloads" };
  const health = await healthCheck();
  return {
    mode: "local-server",
    serverUrl: settings.serverUrl,
    outputRoot: settings.outputRoot,
    ...health
  };
}

export async function ensureReady(overrides) {
  await loadSettings(overrides);
  if (!settings.enabled) return { mode: "chrome-downloads" };
  if (!settings.outputRoot) {
    throw new Error("请填写「输出根目录」");
  }
  return pingServer(overrides);
}

export async function startSession(opts) {
  if (!isEnabled()) return null;
  if (!settings.outputRoot) {
    throw new Error("请填写「输出根目录」");
  }
  const data = await api("/api/session/start", {
    method: "POST",
    body: {
      gameName: opts.gameName,
      outputRoot: settings.outputRoot,
      relPrefix: opts.relPrefix,
      pageUrl: opts.pageUrl,
      referer: opts.referer || opts.pageUrl,
      gameUrl: opts.gameUrl || ""
    }
  });
  sessionId = data.sessionId;
  return data;
}

export function clearSession() {
  sessionId = null;
  pendingBatch = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushChain = Promise.resolve({ results: [] });
}

export async function ingestImmediate(item) {
  if (!isEnabled() || !sessionId) {
    throw new Error("本地会话未建立");
  }
  return api("/api/assets/ingest", {
    method: "POST",
    body: { sessionId, ...item }
  });
}

export async function ingestBatch(items) {
  if (!isEnabled() || !sessionId) {
    throw new Error("本地会话未建立");
  }
  if (items.length === 0) return { results: [], stats: {} };
  return api("/api/assets/ingest/batch", {
    method: "POST",
    body: { sessionId, items }
  });
}

export function enqueueIngest(item) {
  pendingBatch.push(item);
  if (pendingBatch.length >= BATCH_SIZE) {
    void flushQueue();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, FLUSH_MS);
}

async function drainPending() {
  const allResults = [];
  while (pendingBatch.length > 0) {
    const batch = pendingBatch.splice(0, BATCH_SIZE);
    const data = await ingestBatch(batch);
    if (data?.results?.length) allResults.push(...data.results);
  }
  return { results: allResults };
}

export function flushQueue() {
  flushChain = flushChain.then(() => drainPending());
  return flushChain;
}

export async function resumeSession(opts) {
  if (!isEnabled()) return null;
  if (sessionId) return { sessionId, resumed: false };
  if (!opts?.relPrefix) throw new Error("无法恢复本地会话：缺少 relPrefix");
  await loadSettings();
  const data = await startSession(opts);
  return { sessionId: data.sessionId, resumed: true };
}
