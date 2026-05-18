import * as localSink from "./local-sink.js";
import { scrapePokiPortalPage } from "./portal-scraper.js";
import { scrapePokiGameTiles } from "./portal-tiles-scraper.js";
import { mergeManifest, hydrateSessionFiles } from "./assets-manifest-lib.js";

const MANIFEST_REL_PATH = "assets-manifest.json";

const INFO_ASSETS_DIR = "__info_assets__";


/** 下载选项：chrome.downloads 回退时使用 */
const DOWNLOAD_OPTS = { conflictAction: "overwrite", saveAs: false };

const TRACKER_KEYWORDS = [
  "google-analytics", "googletagmanager", "doubleclick",
  "googlesyndication", "adservice.", "sentry.io",
  "hotjar", "intercom", "facebook.net",
  "mixpanel", "segment.io", "amplitude",
  "statsig", "branch.io", "adjust.com"
];

let activeSession = null;
let persistTimer = null;
let manifestTimer = null;
let debuggerAttached = false;
let pendingNetworkCaptures = new Map();
const networkHtmlCache = new Map();
let gameframeTimer = null;
let requestBuffer = [];
let htmlAutoCaptureTimer = null;
let htmlAutoCaptureInFlight = false;
let portalRotateTimer = null;



const sessionReady = restoreSession();

localSink.setFlushHandler((data) => {
  if (activeSession) applyAllIngestResults(data);
});

/* ── Chrome message listener ───────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_MONITOR") {
    sessionReady
      .then(() =>
        startMonitor(message.tabId, {
          sinkSettings: message.sinkSettings || null
        })
      )
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "STOP_MONITOR") {
    sessionReady
      .then(() => stopMonitor(message.tabId))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "GET_MONITOR_STATUS") {
    sessionReady.then(async () => {
      const status = getMonitorStatus(message.tabId);
      if (status.status === "idle") {
        const stored = await chrome.storage.local.get("lastGameInfo");
        if (stored.lastGameInfo) Object.assign(status, stored.lastGameInfo);
      }
      sendResponse({ ok: true, ...status });
    });
    return true;
  }
  if (message?.type === "SCAN_MISSING_GAMES") {
    sessionReady
      .then(() => scanMissingGames(message.tabId, message.sinkSettings || {}))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "CAPTURE_HTML") {
    sessionReady
      .then(() => captureAndSaveHtml(message.tabId, { force: !!message.force }))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "CHECK_SINK_HEALTH") {
    sessionReady
      .then(async () => {
        await localSink.loadSettings(message.sinkSettings || {});
        if (!localSink.isEnabled()) {
          return { mode: "chrome-downloads", message: "已关闭本地服务，将使用 Chrome 下载" };
        }
        return localSink.pingServer(message.sinkSettings || {});
      })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

/* ── webRequest listener ───────────────────────────────────── */

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    void sessionReady.then(() => {
      if (!activeSession || details.tabId !== activeSession.tabId) return;
      if (activeSession.status !== "listening") return;

      activeSession.stats.totalSeen += 1;
      const url = details.url;
      if (!url.startsWith("http")) return;
      if (details.type === "main_frame" || details.type === "sub_frame") return;
      if (activeSession.seenUrls.has(url)) return;
      if (isTrackerUrl(url)) {
        activeSession.stats.skipped += 1;
        return;
      }

      if (!activeSession.gameHost) {
        requestBuffer.push({ url, type: details.type });
        return;
      }

      const reqHost = safeHost(url);
      if (!isSameGameHost(reqHost, activeSession.gameHost)) return;
      void processRequest(url, details.type);
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (activeSession.status !== "listening") return;

  const pageUrl = changeInfo.url || tab?.url || "";
  if (pageUrl.startsWith("http")) {
    schedulePortalGameCheck(tabId, pageUrl);
  }

  if (changeInfo.status === "loading") {
    debuggerAttached = false;
    pendingNetworkCaptures.clear();
    void attachDebugger(tabId);
  }
});

/* ── Tab removal ───────────────────────────────────────────── */

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSession?.tabId === tabId) {
    stopGameframeDetection();
    void detachDebugger(tabId);
    activeSession = null;
    chrome.storage.local.remove("activeSession");
  }
});

/* ── CDP event listeners ───────────────────────────────────── */

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!activeSession || source.tabId !== activeSession.tabId) return;
  if (activeSession.status !== "listening") return;

  if (method === "Network.responseReceived") {
    const { response, requestId, type } = params;
    const url = response.url || "";
    if (!url || !url.startsWith("http")) return;
    const reqHost = safeHost(url);
    const fromGameHost = activeSession.gameHost && isSameGameHost(reqHost, activeSession.gameHost);
    if (type === "Document") {
      pendingNetworkCaptures.set(requestId, { url, type: "Document" });
      return;
    }
    if (fromGameHost && ["Script", "XHR", "Fetch", "Stylesheet", "Image", "Media", "Font", "Other"].includes(type)) {
      pendingNetworkCaptures.set(requestId, { url, type });
    }
  }

  if (method === "Network.loadingFinished") {
    const capture = pendingNetworkCaptures.get(params.requestId);
    if (capture) {
      pendingNetworkCaptures.delete(params.requestId);
      void captureResponseBody(source.tabId, params.requestId, capture);
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (activeSession && source.tabId === activeSession.tabId) {
    debuggerAttached = false;
    pendingNetworkCaptures.clear();
    console.warn(`[poki-dl] debugger detached: ${reason}`);
  }
});

/* ── CDP functions ─────────────────────────────────────────── */

async function attachDebugger(tabId) {
  if (debuggerAttached) return true;
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        console.warn("[poki-dl] debugger attach failed:", chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          console.warn("[poki-dl] Network.enable failed:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        debuggerAttached = true;
        pendingNetworkCaptures.clear();
        resolve(true);
      });
    });
  });
}

async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  debuggerAttached = false;
  pendingNetworkCaptures.clear();
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) { /* tab may already be closed */ }
      resolve();
    });
  });
}

async function captureResponseBody(tabId, requestId, info) {
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        }
      );
    });

    const type = info.type || "Document";
    const isDocument = type === "Document";
    let bodyDecoded = null;

    if (isDocument) {
      bodyDecoded = result.base64Encoded ? decodeBase64Body(result.body) : result.body;
      if (!bodyDecoded || bodyDecoded.length < 50) return;
      if (networkHtmlCache.size > 100) {
        const oldest = networkHtmlCache.keys().next().value;
        networkHtmlCache.delete(oldest);
      }
      networkHtmlCache.set(info.url, bodyDecoded);
      const baseUrl = info.url.split("?")[0];
      if (baseUrl !== info.url) networkHtmlCache.set(baseUrl, bodyDecoded);
      console.log(`[poki-dl] HTML cached: ${info.url.slice(0, 100)} (${bodyDecoded.length} bytes, total=${networkHtmlCache.size})`);
      if (activeSession?.gameUrl) {
        const gameBase = activeSession.gameUrl.split("?")[0];
        const cachedBase = info.url.split("?")[0];
        if (cachedBase === gameBase || info.url === activeSession.gameUrl) {
          scheduleAutoCaptureHtml(tabId, "html-cached");
        }
      }
    }

    if (!activeSession || activeSession.tabId !== tabId) return;
    const fromGameHost = activeSession.gameHost && isSameGameHost(safeHost(info.url), activeSession.gameHost);
    if (!fromGameHost) return;

    let localPath = urlToLocalPath(info.url);
    const extFromUrl = extractExtFromUrl(info.url);
    const extFromType = extensionForCdpType(type);
    if (!extFromUrl && extFromType && !localPath.endsWith(extFromType)) {
      localPath = localPath.endsWith("/") ? localPath.slice(0, -1) + extFromType : localPath + extFromType;
    }
    if (activeSession.downloadedLocalPaths.has(localPath)) {
      activeSession.seenUrls.add(info.url);
      return;
    }
    const filename = `${activeSession.folder}/${localPath}`;
    const bodyEmpty = result.base64Encoded
      ? !result.body || result.body.length < 100
      : !result.body && !(isDocument && bodyDecoded);
    if (bodyEmpty) {
      try {
        await downloadUrl(info.url, filename, type);
        activeSession.seenUrls.add(info.url);
        if (!localSink.isEnabled()) {
          activeSession.downloadedLocalPaths.add(localPath);
          activeSession.stats.downloaded += 1;
          activeSession.files.push({
            type: "asset",
            sourceUrl: info.url,
            localPath,
            status: "ok",
            requestType: type
          });
        }
        console.log(`[poki-dl] CDP body 为空，直链下载: ${info.url.slice(0, 80)} -> ${localPath}`);
        schedulePersist();
        scheduleManifest();
        updateBadgeCount();
      } catch (e2) {
        console.warn("[poki-dl] 直链下载失败:", info.url.slice(0, 60), e2.message);
      }
      return;
    }
    const ext = extFromUrl || extFromType || "";
    const mime = mimeForCdpSave(type, ext, result.base64Encoded);
    let dataUrl;
    if (result.base64Encoded) {
      dataUrl = `data:${mime};base64,${result.body}`;
    } else {
      const text = isDocument ? bodyDecoded : result.body;
      dataUrl = `data:${mime};base64,${stringToBase64(text)}`;
    }
    if (type === "Font" && activeSession && localPath) {
      activeSession.fontDataUrls[localPath] = dataUrl;
    }
    await saveDataUrl(localPath, dataUrl, info.url, type);
    activeSession.seenUrls.add(info.url);
    if (!localSink.isEnabled()) {
      activeSession.downloadedLocalPaths.add(localPath);
      activeSession.stats.downloaded += 1;
      activeSession.files.push({
        type: "asset",
        sourceUrl: info.url,
        localPath,
        status: "ok",
        requestType: type
      });
    }
    console.log(`[poki-dl] CDP 保存: ${info.url.slice(0, 100)} -> ${localPath}`);
    schedulePersist();
    scheduleManifest();
    updateBadgeCount();
  } catch (e) {
    console.warn("[poki-dl] getResponseBody/save failed:", e.message);
    // 当 getResponseBody 失败（如二进制/大文件/缓存）时，用直链下载回退
    if (!activeSession || activeSession.tabId !== tabId) return;
    const fromGameHost = activeSession.gameHost && isSameGameHost(safeHost(info.url), activeSession.gameHost);
    if (!fromGameHost) return;
    if (activeSession.seenUrls.has(info.url)) return;
    const type = info.type || "Other";
    let localPath = urlToLocalPath(info.url);
    const extFromUrl = extractExtFromUrl(info.url);
    const extFromType = extensionForCdpType(type);
    if (!extFromUrl && extFromType && !localPath.endsWith(extFromType)) {
      localPath = localPath.endsWith("/") ? localPath.slice(0, -1) + extFromType : localPath + extFromType;
    }
    if (activeSession.downloadedLocalPaths.has(localPath)) {
      activeSession.seenUrls.add(info.url);
      return;
    }
    const filename = `${activeSession.folder}/${localPath}`;
    try {
      await downloadUrl(info.url, filename, type);
      activeSession.seenUrls.add(info.url);
      if (!localSink.isEnabled()) {
        activeSession.downloadedLocalPaths.add(localPath);
        activeSession.stats.downloaded += 1;
        activeSession.files.push({
          type: "asset",
          sourceUrl: info.url,
          localPath,
          status: "ok",
          requestType: type
        });
      }
      console.log(`[poki-dl] CDP 失败后直链下载: ${info.url.slice(0, 80)} -> ${localPath}`);
      schedulePersist();
      scheduleManifest();
      updateBadgeCount();
    } catch (e2) {
      console.warn("[poki-dl] 直链回退也失败:", info.url.slice(0, 60), e2.message);
    }
  }
}

function stringToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function decodeBase64Body(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function findInNetworkCache(url) {
  if (!url) return null;
  if (networkHtmlCache.has(url)) return networkHtmlCache.get(url);
  const base = url.split("?")[0];
  if (base !== url && networkHtmlCache.has(base)) return networkHtmlCache.get(base);
  try {
    const target = new URL(url);
    for (const [cachedUrl, body] of networkHtmlCache) {
      try {
        const cached = new URL(cachedUrl);
        if (cached.host === target.host && cached.pathname === target.pathname) return body;
      } catch {}
    }
  } catch {}
  return null;
}

/* ── Gameframe detection ───────────────────────────────────── */

function startGameframeDetection(tabId) {
  stopGameframeDetection();
  gameframeTimer = setInterval(() => void detectGameframe(tabId), 1500);
  void detectGameframe(tabId);
}

function stopGameframeDetection() {
  if (gameframeTimer) {
    clearInterval(gameframeTimer);
    gameframeTimer = null;
  }
  if (htmlAutoCaptureTimer) {
    clearTimeout(htmlAutoCaptureTimer);
    htmlAutoCaptureTimer = null;
  }
}

async function detectGameframe(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const iframe = document.getElementById("gameframe");
        return iframe?.src || null;
      }
    });
    const src = results?.find((r) => r.result)?.result || null;
    if (src) {
      console.log(`[poki-dl] gameframe detected: ${src.slice(0, 120)}`);
      await onGameframeDetected(tabId, src);
    }
  } catch {
    /* frame might not be ready yet */
  }
}

async function onGameframeDetected(tabId, src) {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (activeSession.gameUrl === src) return;

  if (activeSession.gameUrl && activeSession.gameUrl !== src) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = tab.url || "";
      const slug = parsePortalGameSlug(pageUrl);
      if (slug && sanitizeName(slug) !== sanitizeName(activeSession.portalSlug || activeSession.gameName)) {
        await rotateToNewGame(tabId, pageUrl, slug);
        if (!activeSession || activeSession.tabId !== tabId) return;
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const url = new URL(src);
    activeSession.gameHost = url.host;
    activeSession.gameUrl = src;
    activeSession.gameBaseUrl = getBaseUrl(src);
    console.log(`[poki-dl] game host: ${url.host}, base: ${activeSession.gameBaseUrl}`);
  } catch (e) {
    console.warn("[poki-dl] failed to parse gameframe src:", e.message);
    return;
  }
  await flushRequestBuffer();
  await persistSession();
  scheduleAutoCaptureHtml(tabId, "gameframe");
}

async function flushRequestBuffer() {
  const buffer = requestBuffer;
  requestBuffer = [];
  console.log(`[poki-dl] flushing ${buffer.length} buffered requests`);
  for (const req of buffer) {
    await processRequest(req.url, req.type);
  }
}

/* ── Request processing ────────────────────────────────────── */

function isSameGameHost(requestHost, gameHost) {
  if (!requestHost || !gameHost) return false;
  if (requestHost === gameHost) return true;
  // 同站不同子域也接受（例如资源来自 *.gdn.poki.com 的其他子域）
  if (gameHost.endsWith(".gdn.poki.com") && requestHost.endsWith(".gdn.poki.com")) return true;
  return false;
}

async function processRequest(url, requestType) {
  if (!activeSession?.gameHost) return;
  const host = safeHost(url);
  if (!isSameGameHost(host, activeSession.gameHost)) return;
  if (activeSession.seenUrls.has(url)) return;
  activeSession.seenUrls.add(url);

  const localPath = urlToLocalPath(url);
  if (activeSession.downloadedLocalPaths.has(localPath)) {
    return;
  }
  if (activeSession.pending.has(url)) return;
  activeSession.pending.add(url);

  console.log("[poki-dl] 下载:", url.slice(0, 120));
  try {
    await downloadUrl(url, `${activeSession.folder}/${localPath}`, requestType);
    if (!localSink.isEnabled()) {
      activeSession.downloadedLocalPaths.add(localPath);
      activeSession.stats.downloaded += 1;
      activeSession.files.push({
        type: "asset",
        sourceUrl: url,
        localPath,
        status: "ok",
        requestType
      });
    }
    await updateBadgeCount();
  } catch (error) {
    if (!localSink.isEnabled()) {
      activeSession.stats.failed += 1;
      activeSession.files.push({
        type: "asset",
        sourceUrl: url,
        localPath,
        status: "failed",
        requestType,
        error: String(error?.message || error)
      });
    }
  } finally {
    activeSession.pending.delete(url);
    schedulePersist();
    scheduleManifest();
  }
}

/* ── Portal /g/slug 切换 ─────────────────────────────────────── */

function isPokiPortalUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\./, "");
    return host === "poki.com" || host.endsWith(".poki.com");
  } catch {
    return false;
  }
}

/** 从 Poki 门户 URL 解析游戏 slug，如 https://poki.com/en/g/beauty-salon */
function parsePortalGameSlug(pageUrl) {
  try {
    const m = new URL(pageUrl).pathname.match(/\/g\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

function schedulePortalGameCheck(tabId, pageUrl) {
  if (portalRotateTimer) clearTimeout(portalRotateTimer);
  portalRotateTimer = setTimeout(() => {
    portalRotateTimer = null;
    void maybeRotateGameOnPortalUrl(tabId, pageUrl);
  }, 450);
}

async function maybeRotateGameOnPortalUrl(tabId, pageUrl) {
  if (!activeSession || activeSession.tabId !== tabId) return false;
  if (activeSession.status !== "listening") return false;
  if (!isPokiPortalUrl(pageUrl)) return false;

  const slug = parsePortalGameSlug(pageUrl);
  if (!slug) return false;

  const nextName = sanitizeName(slug);
  const currentSlug =
    activeSession.portalSlug ||
    parsePortalGameSlug(activeSession.pageUrl) ||
    activeSession.gameName;
  if (sanitizeName(currentSlug) === nextName) {
    activeSession.pageUrl = pageUrl;
    activeSession.portalSlug = slug;
    return false;
  }

  await rotateToNewGame(tabId, pageUrl, slug);
  return true;
}

/** 写入并结束当前游戏的 manifest / 本地会话（不解除标签页监听） */
async function finalizeGameManifest() {
  if (!activeSession) return;
  try {
    if (localSink.isEnabled()) {
      await flushLocalSinkAndApply();
    }
    await writeManifest();
    if (localSink.isEnabled() && activeSession.localSessionId) {
      const manifest = buildManifestPayloadFromSession();
      await localSink.finishSession(manifest);
    }
  } finally {
    localSink.clearSession();
    if (activeSession) activeSession.localSessionId = null;
  }
}

async function beginNewGameCapture(tabId, pageUrl, slug) {
  const gameName = sanitizeName(slug);
  const folder = gameName;

  await localSink.loadSettings();
  const useLocalSink = localSink.isEnabled();

  activeSession = {
    tabId,
    gameName,
    folder,
    portalSlug: slug,
    pageUrl,
    startedAt: new Date().toISOString(),
    status: "listening",
    gameHost: null,
    gameUrl: null,
    gameBaseUrl: null,
    seenUrls: new Set(),
    pending: new Set(),
    downloadedLocalPaths: new Set(),
    stats: { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 },
    files: [],
    htmlCaptured: false,
    fontDataUrls: {},
    portalInfo: null,
    sinkMode: useLocalSink ? "local-server" : "chrome-downloads",
    localSessionId: null
  };

  if (useLocalSink) {
    const started = await localSink.startSession({
      gameName,
      relPrefix: folder,
      pageUrl,
      gameUrl: ""
    });
    activeSession.localSessionId = started.sessionId;
    console.log("[poki-dl] 新游戏本地会话:", started.sessionId, started.gameDir);
  }

  if (await isIndexHtmlOnDisk()) {
    activeSession.htmlCaptured = true;
    console.log("[poki-dl] 新游戏目录已有 index.html，跳过自动生成");
  }

  await hydrateSessionFromManifestOnDisk();
  void writeManifest();

  requestBuffer = [];
  networkHtmlCache.clear();
  pendingNetworkCaptures.clear();
  htmlAutoCaptureInFlight = false;

  startGameframeDetection(tabId);
  schedulePortalScrape(tabId);

  await persistSession();
  await chrome.storage.local.set({ lastGameInfo: { gameName, folder } });
  try {
    await chrome.action.setBadgeText({ tabId, text: "ON" });
  } catch {
    /* ignore */
  }
}

async function rotateToNewGame(tabId, pageUrl, slug) {
  const prevName = activeSession?.gameName || "?";
  const nextName = sanitizeName(slug);
  console.log(`[poki-dl] 切换游戏: ${prevName} → ${nextName}`);

  if (activeSession) {
    activeSession.status = "stopped";
    activeSession.stoppedAt = new Date().toISOString();
    try {
      await finalizeGameManifest();
    } catch (e) {
      console.warn("[poki-dl] 收尾上一游戏 manifest:", e.message);
    }
  }

  stopGameframeDetection();
  await beginNewGameCapture(tabId, pageUrl, slug);
  debuggerAttached = false;
  await attachDebugger(tabId);
}

/* ── Monitor lifecycle ─────────────────────────────────────── */

async function startMonitor(tabId, options = {}) {
  const { sinkSettings = null } = options;

  const pageInfo = await getPageInfoFromTab(tabId);
  if (!pageInfo?.pageUrl) throw new Error("无法读取页面信息。");

  let host;
  try {
    host = new URL(pageInfo.pageUrl).host;
  } catch {
    throw new Error("页面 URL 无法解析。");
  }
  if (host !== "poki.com" && !host.endsWith(".poki.com")) {
    throw new Error("请在 Poki 游戏页面开启监听。");
  }

  const portalSlug = parsePortalGameSlug(pageInfo.pageUrl) || pageInfo.gameName || "";
  const gameName = sanitizeName(portalSlug || pageInfo.gameName || "poki-game");
  const folder = gameName;

  localSink.clearSession();
  const sinkReady = await localSink.ensureReady(sinkSettings || {});
  const useLocalSink = localSink.isEnabled();

  activeSession = {
    tabId,
    gameName,
    folder,
    portalSlug: portalSlug || gameName,
    pageUrl: pageInfo.pageUrl,
    startedAt: new Date().toISOString(),
    status: "listening",
    gameHost: null,
    gameUrl: null,
    gameBaseUrl: null,
    seenUrls: new Set(),
    pending: new Set(),
    /** 当前监听会话中已下载的本地路径，用于去重，避免同一文件重复下载 */
    downloadedLocalPaths: new Set(),
    stats: { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 },
    files: [],
    htmlCaptured: false,
    /** 字体 data URL，用于生成 index 时内联，避免 file:// 下无法加载 */
    fontDataUrls: {},
    portalInfo: null,
    sinkMode: useLocalSink ? "local-server" : "chrome-downloads",
    localSessionId: null
  };

  if (useLocalSink) {
    const started = await localSink.startSession({
      gameName,
      relPrefix: folder,
      pageUrl: pageInfo.pageUrl,
      gameUrl: ""
    });
    activeSession.localSessionId = started.sessionId;
    console.log("[poki-dl] 本地服务会话:", started.sessionId, started.gameDir);
  }

  if (await isIndexHtmlOnDisk()) {
    activeSession.htmlCaptured = true;
    console.log("[poki-dl] 检测到已有 index.html，跳过自动生成");
  }

  await hydrateSessionFromManifestOnDisk();
  void writeManifest();

  requestBuffer = [];
  networkHtmlCache.clear();

  const dbgOk = await attachDebugger(tabId);

  startGameframeDetection(tabId);

  schedulePortalScrape(tabId);

  await persistSession();
  await chrome.storage.local.set({ lastGameInfo: { gameName, folder } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

  return {
    gameName,
    folder,
    status: "listening",
    debugger: dbgOk,
    sinkMode: activeSession.sinkMode
  };
}

async function isIndexHtmlOnDisk() {
  if (!activeSession) return false;
  const rel = "index.html";
  if (
    activeSession.files?.some(
      (f) => f.localPath === rel && f.status === "ok"
    )
  ) {
    return true;
  }
  if (localSink.isEnabled()) {
    try {
      await ensureLocalSinkSession();
      return await localSink.fileExists(rel);
    } catch {
      return false;
    }
  }
  return false;
}

function scheduleAutoCaptureHtml(tabId, reason = "") {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (activeSession.htmlCaptured) return;
  if (htmlAutoCaptureTimer) clearTimeout(htmlAutoCaptureTimer);
  htmlAutoCaptureTimer = setTimeout(() => {
    htmlAutoCaptureTimer = null;
    void tryAutoCaptureHtml(tabId, reason);
  }, 800);
}

async function tryAutoCaptureHtml(tabId, reason = "") {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (htmlAutoCaptureInFlight || activeSession.htmlCaptured) return;

  if (await isIndexHtmlOnDisk()) {
    activeSession.htmlCaptured = true;
    console.log("[poki-dl] index.html 已存在，跳过自动生成");
    schedulePersist();
    return;
  }

  if (!activeSession.gameUrl || !findInNetworkCache(activeSession.gameUrl)) return;

  htmlAutoCaptureInFlight = true;
  try {
    const r = await captureAndSaveHtml(tabId, { auto: true });
    if (!r?.skipped) {
      console.log(`[poki-dl] 已自动生成 HTML${reason ? ` (${reason})` : ""}`);
    }
  } catch (e) {
    console.log(`[poki-dl] 自动生成 HTML 等待中: ${e.message}`);
  } finally {
    htmlAutoCaptureInFlight = false;
  }
}

async function captureAndSaveHtml(tabId, options = {}) {
  const { force = false, auto = false } = options;
  if (!activeSession || activeSession.tabId !== tabId) {
    throw new Error("当前没有监听会话。");
  }

  if (localSink.isEnabled()) {
    await ensureLocalSinkSession();
  }

  if (!force) {
    if (activeSession.htmlCaptured || (await isIndexHtmlOnDisk())) {
      activeSession.htmlCaptured = true;
      await persistSession();
      return {
        message: "index.html 已存在，跳过生成",
        skipped: true
      };
    }
  }

  const gameUrl = activeSession.gameUrl;
  if (!gameUrl) {
    throw new Error("尚未检测到 gameframe，请等待游戏加载完成。");
  }

  const rawHtml = findInNetworkCache(gameUrl);
  if (!rawHtml) {
    throw new Error(
      `未检测到 ${gameUrl.slice(0, 80)} 的网络缓存 (共 ${networkHtmlCache.size} 条)`
    );
  }

  await generateIndexHtml(rawHtml, gameUrl);
  await generateSdkStubFile();
  await generatePokiLoaderShimFiles();

  activeSession.htmlCaptured = true;
  await persistSession();

  return {
    message: auto
      ? "已自动生成 index.html、poki-sdk-stub.js、master-loader.js、unity-2020.js"
      : "已生成 index.html、poki-sdk-stub.js、master-loader.js、unity-2020.js"
  };
}

async function stopMonitor(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle" };
  }

  stopGameframeDetection();
  const errors = [];

  if (activeSession.gameUrl && !activeSession.htmlCaptured) {
    try {
      await tryAutoCaptureHtml(tabId, "stop");
    } catch (e) {
      errors.push(e.message);
    }
  }

  try {
    await detachDebugger(tabId);
  } catch { /* ignore */ }

  activeSession.status = "stopped";
  activeSession.stoppedAt = new Date().toISOString();

  if (!activeSession.portalInfo) {
    try {
      await scrapeAndSavePortalInfo(tabId);
    } catch (e) {
      errors.push(`portalInfo: ${e.message}`);
    }
  }

  try {
    await finalizeGameManifest();
  } catch (e) {
    errors.push(`writeManifest: ${e.message}`);
  }

  const result = buildStatusPayload();
  if (errors.length > 0) result.warnings = errors;

  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch { /* badge might fail if tab closed */ }

  activeSession = null;
  await chrome.storage.local.remove("activeSession");
  return result;
}

function getMonitorStatus(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) return { status: "idle" };
  return buildStatusPayload();
}

/* ── HTML & script generation ──────────────────────────────── */

/** 将 @font-face 中的字体 url 替换为内联 data URL，避免 file:// 下无法加载 */
function inlineFontDataUrls(html) {
  const fontDataUrls = activeSession?.fontDataUrls;
  if (!fontDataUrls || Object.keys(fontDataUrls).length === 0) return html;
  return html.replace(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, path) => {
    const normalized = path.replace(/^\.\//, "").split("?")[0].trim();
    const dataUrl = fontDataUrls[normalized];
    if (dataUrl) return 'url("' + dataUrl.replace(/"/g, "%22") + '")';
    return match;
  });
}

async function generateIndexHtml(rawHtml, gameUrl) {
  const gameBaseUrl = getBaseUrl(gameUrl);
  const urlMap = buildUrlToLocalMap();

  let html = rawHtml;
  html = rewriteAllUrls(html, urlMap);
  html = rewriteRemainingAbsoluteUrls(html, gameBaseUrl);
  html = neutralizePokiSdk(html);
  html = removeDynamicLoaderContent(html, detectGameEngine());
  html = inlineFontDataUrls(html);
  html = html.replace(
    /<meta\s+name="apple-mobile-web-app-capable"\s+content="[^"]*"\s*\/?>/gi,
    '<meta name="mobile-web-app-capable" content="yes">'
  );

  const scriptTags = '<script src="poki-sdk-stub.js"></script>';
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    html = html.replace(headMatch[0], headMatch[0] + "\n" + scriptTags);
  } else {
    html = scriptTags + "\n" + html;
  }

  await downloadText(
    `${activeSession.folder}/index.html`,
    html,
    "text/html;charset=utf-8"
  );
  upsertFile({
    type: "entry-html",
    sourceUrl: gameUrl,
    localPath: "index.html",
    status: "ok"
  });
  console.log("[poki-dl] index.html generated");
}

async function generateSdkStubFile() {
  const content = buildSdkStubContent();
  await downloadText(
    `${activeSession.folder}/poki-sdk-stub.js`,
    content,
    "text/javascript;charset=utf-8"
  );
  upsertFile({
    type: "compat-script",
    sourceUrl: "",
    localPath: "poki-sdk-stub.js",
    status: "ok"
  });
}

async function readBundledTextFile(relativePath) {
  const url = chrome.runtime.getURL(relativePath);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[poki-dl] fetch ${relativePath}: ${r.status}`);
  return r.text();
}

/** 官方 master-loader v2/v3 会先加载 poki-sdk.js，覆盖桩；写入本地 shim（与 happy-glass 离线方案一致） */
async function generatePokiLoaderShimFiles() {
  const masterShim = await readBundledTextFile("poki-master-loader-shim.js");
  await downloadText(
    `${activeSession.folder}/master-loader.js`,
    masterShim,
    "text/javascript;charset=utf-8"
  );
  upsertFile({
    type: "compat-script",
    sourceUrl: "",
    localPath: "master-loader.js",
    status: "ok"
  });
  const unityLoader = await readBundledTextFile("poki-unity-2020-loader.js");
  await downloadText(
    `${activeSession.folder}/unity-2020.js`,
    unityLoader,
    "text/javascript;charset=utf-8"
  );
  upsertFile({
    type: "compat-script",
    sourceUrl: "",
    localPath: "unity-2020.js",
    status: "ok"
  });
}

async function generateInterceptorFile() {
  const content = buildInterceptorContent();
  await downloadText(
    `${activeSession.folder}/interceptor.js`,
    content,
    "text/javascript;charset=utf-8"
  );
  upsertFile({
    type: "compat-script",
    sourceUrl: "",
    localPath: "interceptor.js",
    status: "ok"
  });
}

function buildSdkStubContent() {
  return `(function() {
  var _oeSetter = null;
  Object.defineProperty(window, "onerror", {
    configurable: true,
    set: function(fn) { _oeSetter = fn; },
    get: function() {
      return function(msg, url, line, col, err) {
        console.error("[poki-dl] onerror:", msg, url, line);
        return true;
      };
    }
  });

  var _pn = function() {};
  var _pp = function() { return Promise.resolve(); };

  var _loadingGone = false;
  var _loadingIds = [
    "loading-screen-container", "loader", "loading", "progress-container",
    "splash", "defold-progress", "unity-loading-bar", "application-splash-wrapper"
  ];

  function _hideLoading() {
    if (_loadingGone) return;
    var found = false;
    for (var i = 0; i < _loadingIds.length; i++) {
      var el = document.querySelector("#" + CSS.escape(_loadingIds[i]) + ":not([data-poki-placeholder])");
      if (el && el.parentElement) {
        el.parentElement.removeChild(el);
        found = true;
      }
    }
    try {
      if (typeof ProgressView !== "undefined"
          && ProgressView.progress
          && ProgressView.progress.parentElement
          && !ProgressView.progress.dataset.pokiPlaceholder) {
        ProgressView.progress.parentElement.removeChild(ProgressView.progress);
        found = true;
      }
    } catch (e) {}
    if (found) {
      _loadingGone = true;
      console.log("[poki-dl] loading overlay removed");
    }
  }

  var _hlTimer = setInterval(function() {
    _hideLoading();
    if (_loadingGone) clearInterval(_hlTimer);
  }, 2000);
  setTimeout(function() { clearInterval(_hlTimer); }, 30000);

  function _breakWithCb(cb) {
    if (typeof cb === "function") {
      try { cb(); } catch (e) {}
    }
    return Promise.resolve();
  }
  function _rewardedWithCb(cb) {
    if (typeof cb === "function") {
      try { cb(); } catch (e) {}
    }
    return Promise.resolve(true);
  }

  var _pokiBase = {
    init: function() {
      window.PokiSDK_OK = true;
      return Promise.resolve();
    },
    setDebug: _pn,
    setLogging: _pn,
    gameLoadingStart: _pn,
    gameLoadingFinished: _hideLoading,
    gameLoadingProgress: _pn,
    gameInteractive: _hideLoading,
    gameplayStart: () => {
      console.log("[poki-dl] gameplayStart");
      return Promise.resolve();
    },
    gameplayStop: () => {
      console.log("[poki-dl] gameplayStop");
      return Promise.resolve();
    },
    commercialBreak: _breakWithCb,
    rewardedBreak: _rewardedWithCb,
    measure: _pn,
    captureError: _pn,
    logError: _pn,
    customEvent: _pn,
    happyTime: _pn,
    roundStart: _pn,
    roundEnd: _pn,
    displayAd: _pn,
    destroyAd: _pn,
    muteAd: _pn,
    getURLParam: function() { return ""; },
    shareableURL: function() { return Promise.resolve(""); },
    isAdBlocked: function() { return false; },
    sendHighscore: _pn,
    togglePlayerAdvertisingConsent: _pn,
    disableDOMChangeObservation: _pn,
    movePill: _pn,
    openExternalLink: _pn,
    playtestSetCanvas: _pn,
    playtestCaptureHtmlOnce: _pn,
    playtestCaptureHtmlForce: _pn,
    playtestCaptureHtmlOn: _pn,
    playtestCaptureHtmlOff: _pn
  };

  var _pokiStub = new Proxy(_pokiBase, {
    get: function(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return _pn;
    }
  });

  try {
    Object.defineProperty(window, "PokiSDK", {
      value: _pokiStub,
      writable: false,
      configurable: false
    });
  } catch (e) {
    window.PokiSDK = _pokiStub;
  }
  console.log("[poki-dl] PokiSDK stub active (proxy)");

  var _origGBI = Document.prototype.getElementById;
  Document.prototype.getElementById = function(id) {
    var el = _origGBI.call(this, id);
    if (!el) {
      var sid = (id || "").toLowerCase();
      var isCanvasLike = sid.indexOf("canvas") >= 0 || sid === "gl" || sid === "webgl"
        || sid === "renderer" || sid === "three" || sid === "gl-canvas"
        || sid === "webgl-canvas";
      el = document.createElement(isCanvasLike ? "canvas" : "div");
      el.id = id;
      if (!isCanvasLike) el.style.display = "none";
      if (isCanvasLike) { el.width = 800; el.height = 600; el.style.display = "block"; }
      el.dataset.pokiPlaceholder = "1";
      if (document.body) document.body.appendChild(el);
    }
    return el;
  };
})();`;
}

function buildInterceptorContent() {
  const knownHosts = new Set();
  if (activeSession) {
    if (activeSession.gameHost) knownHosts.add(activeSession.gameHost);
    for (const f of activeSession.files) {
      if (f.status === "ok" && f.sourceUrl) {
        try { knownHosts.add(new URL(f.sourceUrl).host); } catch {}
      }
    }
  }

  const gameHost = activeSession?.gameHost || "";
  let gameBasePath = "/";
  if (activeSession?.gameBaseUrl) {
    try { gameBasePath = new URL(activeSession.gameBaseUrl).pathname; } catch {}
  }

  return `(function() {
  var KH = ${JSON.stringify(Array.from(knownHosts))};
  var GH = ${JSON.stringify(gameHost)};
  var GBP = ${JSON.stringify(gameBasePath)};

  function rw(u) {
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return u;
    if (u.includes("poki-sdk-core") || u.includes("poki-sdk-hoist")
      || u.includes("/scripts/v2/poki-sdk") || u.includes("/scripts/v3/poki-sdk"))
      return "data:text/javascript,console.log('[poki-dl] sdk blocked')";
    try {
      var o = new URL(u, location.href);
      if (o.protocol !== "http:" && o.protocol !== "https:") return u;
      if (o.host !== location.host) {
        if (KH.indexOf(o.host) >= 0) {
          var p = o.pathname;
          if (o.host === GH && p.startsWith(GBP)) p = p.substring(GBP.length);
          else if (p.startsWith("/")) p = p.substring(1);
          return "./" + p;
        }
      }
    } catch (e) {}
    return u;
  }

  var F = window.fetch;
  window.fetch = function(i, o) {
    if (typeof i === "string") i = rw(i);
    else if (i && i.url) { var n = rw(i.url); if (n !== i.url) i = new Request(n, i); }
    return F.call(this, i, o);
  };

  var X = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var a = [].slice.call(arguments);
    if (typeof a[1] === "string") a[1] = rw(a[1]);
    return X.apply(this, a);
  };

  var SA = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n, v) {
    if ((n === "src" || n === "href") && typeof v === "string") v = rw(v);
    return SA.call(this, n, v);
  };

  function patchSrc(P) {
    try {
      var d = Object.getOwnPropertyDescriptor(P, "src");
      if (d && d.set) Object.defineProperty(P, "src", {
        set: function(v) { d.set.call(this, rw(v)); },
        get: d.get,
        configurable: true
      });
    } catch (e) {}
  }
  patchSrc(HTMLScriptElement.prototype);
  patchSrc(HTMLImageElement.prototype);
  patchSrc(HTMLIFrameElement.prototype);
  patchSrc(HTMLSourceElement.prototype);
  patchSrc(HTMLMediaElement.prototype);

  function rwCss(s) {
    return s.replace(/url\\(\\s*(["']?)([^"')]+?)\\1\\s*\\)/gi, function(m, q, p) {
      return "url(" + q + rw(p) + q + ")";
    });
  }

  if (window.FontFace) {
    var OF = window.FontFace;
    window.FontFace = function(f, s, d) {
      if (typeof s === "string") s = rwCss(s);
      return new OF(f, s, d);
    };
    window.FontFace.prototype = OF.prototype;
  }

  try {
    var IR = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function(r, i) {
      return IR.call(this, rwCss(r), i);
    };
  } catch (e) {}

  try {
    var dI = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (dI && dI.set) Object.defineProperty(Element.prototype, "innerHTML", {
      set: function(v) {
        if (this.tagName === "STYLE" && typeof v === "string") v = rwCss(v);
        dI.set.call(this, v);
      },
      get: dI.get,
      configurable: true
    });
  } catch (e) {}

  try {
    var dT = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (dT && dT.set) {
      var origTC = dT.set;
      Object.defineProperty(Node.prototype, "textContent", {
        set: function(v) {
          if (this.tagName === "STYLE" && typeof v === "string") v = rwCss(v);
          origTC.call(this, v);
        },
        get: dT.get,
        configurable: true
      });
    }
  } catch (e) {}

  console.log("[poki-dl] interceptor active, knownHosts:", KH.length, "gameHost:", GH);
})();`;
}

/* ── URL rewriting ─────────────────────────────────────────── */

function buildUrlToLocalMap() {
  const map = new Map();
  if (!activeSession) return map;
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl || !file.localPath) continue;
    const localRef = `./${file.localPath}`;
    map.set(file.sourceUrl, localRef);
    const noQuery = file.sourceUrl.split("?")[0];
    if (noQuery !== file.sourceUrl && !map.has(noQuery)) {
      map.set(noQuery, localRef);
    }
  }
  return map;
}

function rewriteAllUrls(html, urlToLocal) {
  const allReplacements = [];
  for (const [sourceUrl, localPath] of urlToLocal) {
    if (!sourceUrl) continue;
    allReplacements.push({ from: sourceUrl, to: localPath });
    if (sourceUrl.includes("://")) {
      const jsEsc = sourceUrl.replace(/\//g, "\\/");
      if (jsEsc !== sourceUrl) {
        allReplacements.push({ from: jsEsc, to: localPath });
      }
    }
  }
  allReplacements.sort((a, b) => b.from.length - a.from.length);

  const markers = [];
  let result = html;
  for (let i = 0; i < allReplacements.length; i++) {
    const { from, to } = allReplacements[i];
    const marker = `\x00UM${i}\x00`;
    if (result.includes(from)) {
      markers.push({ marker, to });
      result = result.split(from).join(marker);
    }
  }
  for (const { marker, to } of markers) {
    result = result.split(marker).join(to);
  }
  return result;
}

function rewriteRemainingAbsoluteUrls(html, gameBaseUrl) {
  if (!activeSession) return html;
  const hosts = new Set();
  if (activeSession.gameHost) hosts.add(activeSession.gameHost);
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl) continue;
    try { hosts.add(new URL(file.sourceUrl).host); } catch {}
  }

  let gameBasePathname = "";
  let gameHost = "";
  if (gameBaseUrl) {
    try {
      const u = new URL(gameBaseUrl);
      gameHost = u.host;
      gameBasePathname = u.pathname;
    } catch {}
  }

  for (const host of hosts) {
    for (const proto of ["https://", "http://"]) {
      const origin = proto + host;
      const originSlash = origin + "/";
      if (
        !html.includes(originSlash) &&
        !html.includes(origin.replace(/\//g, "\\/"))
      )
        continue;

      const basePath = host === gameHost ? gameBasePathname : "/";

      if (html.includes(originSlash)) {
        html = html.split(origin + basePath).join("./");
        if (basePath !== "/") {
          html = html.split(originSlash).join("./");
        }
      }
      const esc = origin.replace(/\//g, "\\/");
      const escBase = (origin + basePath).replace(/\//g, "\\/");
      if (html.includes(esc)) {
        html = html.split(escBase).join(".\\/");
        if (basePath !== "/") {
          html = html.split(esc + "\\/").join(".\\/");
        }
      }
    }
  }
  return html;
}

function neutralizePokiSdk(html) {
  html = html
    .replace(/<script[^>]*src="[^"]*poki-sdk-hoist[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*src="[^"]*\/poki-sdk\.js"[^>]*><\/script>/gi, "")
    .replace(
      /<script[^>]*src="https?:\/\/game-cdn\.poki\.com\/loaders\/v\d+\/master-loader\.js"[^>]*><\/script>/gi,
      '<script src="./master-loader.js"></script>'
    );
  return stripPokiAdapterScript(html);
}

function stripPokiAdapterScript(html) {
  const re = /<script>(?=[\s\S]{5000})([\s\S]*?)<\/script>/gi;
  return html.replace(re, (match, content) => {
    if (
      content.includes("_createForOfIteratorHelper") ||
      content.includes("PokiSDK") ||
      content.includes("poki-sdk") ||
      content.includes("commercialBreak") ||
      content.includes("rewardedBreak")
    ) {
      return "<!-- poki-adapter removed -->";
    }
    return match;
  });
}

function removeDynamicLoaderContent(html, engine) {
  html = html.replace(
    /<script[^>]*src="[^"]*loaders\/v\d+\/(?!master-loader)[^"]*"[^>]*><\/script>/gi,
    ""
  );
  html = html.replace(
    /<!--\s*will\s+(be\s+copied|also\s+be\s+copied)\s+to\s+the\s+resulting\s+body\s*\/?\/?-->/gi,
    ""
  );
  html = html.replace(/<script[^>]*src="[^"]*sw\.js"[^>]*><\/script>/gi, "");
  if (engine === "godot") {
    html = html.replace(
      /<script[^>]*src="[^"]*godot\.tools\.js"[^>]*><\/script>/gi,
      ""
    );
  }
  return html;
}

function detectGameEngine() {
  if (!activeSession) return "unknown";
  const paths = activeSession.files.map((f) => (f.localPath || "").toLowerCase());
  const urls = activeSession.files.map((f) => (f.sourceUrl || "").toLowerCase());
  const all = paths.concat(urls).join("\n");

  if (
    (all.includes("/build/") || all.includes("\\build\\")) &&
    (all.includes(".loader.js") || all.includes(".framework.js") || all.includes(".wasm"))
  )
    return "unity";
  if (all.includes("dmloader") || all.includes(".arcd") || all.includes(".dmanifest"))
    return "defold";
  if (all.includes("c3runtime") || all.includes("c2runtime")) return "construct";
  if (all.includes(".pck") || all.includes("/godot")) return "godot";
  if (all.includes("html5game/")) return "gamemaker";
  if (all.includes("phaser")) return "phaser";
  if (all.includes("pixi")) return "pixi";
  if (all.includes("playcanvas")) return "playcanvas";
  if (all.includes("createjs") || all.includes("easeljs")) return "createjs";
  return "unknown";
}

/* ── Path utilities ────────────────────────────────────────── */

function urlToLocalPath(urlString) {
  const url = new URL(urlString);
  let pathname = url.pathname;

  if (activeSession?.gameBaseUrl) {
    try {
      const baseU = new URL(activeSession.gameBaseUrl);
      if (url.host === baseU.host && pathname.startsWith(baseU.pathname)) {
        pathname = pathname.slice(baseU.pathname.length);
      }
    } catch {}
  }

  if (pathname === url.pathname) {
    const segs = pathname.split("/").filter(Boolean);
    const sameGameHost = activeSession?.gameHost && isSameGameHost(url.host, activeSession.gameHost);
    const fromGdnPoki = url.host.endsWith(".gdn.poki.com");
    if (segs.length >= 2 && (sameGameHost || fromGdnPoki)) {
      pathname = "/" + segs.slice(1).join("/");
    }
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => sanitizeName(s));
  return segments.join("/") || "index";
}

function getBaseUrl(url) {
  if (!url) return "";
  const noQuery = url.split("?")[0];
  const lastSlash = noQuery.lastIndexOf("/");
  return lastSlash >= 0 ? noQuery.slice(0, lastSlash + 1) : noQuery + "/";
}

function appendSuffix(path, suffix) {
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return `${dir}${file}${suffix}`;
  return `${dir}${file.slice(0, dot)}${suffix}${file.slice(dot)}`;
}

function sanitizeName(input) {
  return String(input)
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function simpleHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

function safePathname(urlString) {
  try {
    return new URL(urlString).pathname;
  } catch {
    return "";
  }
}

function safeHost(urlString) {
  try {
    return new URL(urlString).host;
  } catch {
    return "";
  }
}

function isTrackerUrl(url) {
  const lower = url.toLowerCase();
  return TRACKER_KEYWORDS.some((kw) => lower.includes(kw));
}

async function scanMissingGames(tabId, sinkSettings = {}) {
  if (tabId == null || !Number.isInteger(tabId) || tabId < 1) {
    throw new Error("无效的标签页");
  }

  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url || "";
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    throw new Error("无法解析当前页 URL");
  }
  if (host !== "poki.com" && !host.endsWith(".poki.com")) {
    throw new Error("请在 Poki 游戏页（poki.com/.../g/...）使用此功能");
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapePokiGameTiles
  });
  const scraped = injected?.[0]?.result;
  if (!scraped?.tiles?.length) {
    throw new Error("未在页面找到推荐游戏列表（请滚动到下方游戏区后重试）");
  }

  await localSink.loadSettings(sinkSettings);
  if (!localSink.isEnabled()) {
    throw new Error("请启用「本地服务写盘」并填写输出根目录");
  }
  await localSink.ensureReady(sinkSettings);
  const health = await localSink.healthCheck();
  if (!health?.features?.listGameDirs) {
    throw new Error(
      "本地服务版本过旧，请停止旧进程后重新执行 npm run poki-server，再点击检查"
    );
  }
  const outputRoot = localSink.getSettings()?.outputRoot || "";
  const listed = await localSink.listOutputGameDirs(outputRoot);
  const existing = new Set((listed.dirs || []).map((name) => sanitizeName(name)));

  const missing = [];
  const downloaded = [];
  for (const tile of scraped.tiles) {
    const folder = sanitizeName(tile.slug);
    const item = { ...tile, folder };
    if (existing.has(folder)) {
      downloaded.push(item);
    } else {
      missing.push(item);
    }
  }

  return {
    ok: true,
    outputRoot,
    pageUrl: scraped.pageUrl,
    currentSlug: scraped.currentSlug || "",
    totalOnPage: scraped.tiles.length,
    downloadedCount: downloaded.length,
    missingCount: missing.length,
    missing,
    downloaded
  };
}

function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    const dotIdx = lastSegment.lastIndexOf(".");
    if (dotIdx > 0) return lastSegment.slice(dotIdx).toLowerCase();
  } catch {}
  return "";
}

/** 按 CDP 资源类型返回扩展名（URL 无扩展名时用） */
function extensionForCdpType(cdpType) {
  switch (cdpType) {
    case "Script": return ".js";
    case "Stylesheet": return ".css";
    case "Document": return ".html";
    case "Image": return ".png";
    case "Media": return ".mp4";
    case "Font": return ".woff2";
    default: return "";
  }
}

/** 按 CDP 类型和扩展名返回 data URL 的 MIME，避免被 Chrome 存成 .txt */
function mimeForCdpSave(cdpType, ext, isBinary) {
  if (isBinary) return "application/octet-stream";
  switch (cdpType) {
    case "Script": return "application/javascript";
    case "Stylesheet": return "text/css";
    case "Document":
      if (ext === ".json") return "application/json";
      if (ext === ".html" || ext === "") return "text/html";
      return "application/octet-stream";
    case "Image":
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      if (ext === ".svg") return "image/svg+xml";
      return "image/png";
    case "Font":
      if (ext === ".woff2") return "font/woff2";
      if (ext === ".woff") return "font/woff";
      if (ext === ".ttf") return "font/ttf";
      return "font/woff2";
    case "Media":
      if (ext === ".mp4") return "video/mp4";
      if (ext === ".webm") return "video/webm";
      if (ext === ".mp3") return "audio/mpeg";
      return "application/octet-stream";
    default:
      if (ext === ".json") return "application/json";
      if (ext === ".js") return "application/javascript";
      if (ext === ".css") return "text/css";
      if (ext === ".html") return "text/html";
      if (ext === ".zip") return "application/zip";
      if (ext === ".wasm") return "application/wasm";
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return "application/octet-stream";
  }
}

/* ── Download helpers ──────────────────────────────────────── */

async function ensureLocalSinkSession() {
  if (!localSink.isEnabled() || !activeSession) return;
  await localSink.loadSettings();
  if (localSink.getSessionId()) return;
  const started = await localSink.resumeSession({
    gameName: activeSession.gameName,
    relPrefix: activeSession.folder,
    pageUrl: activeSession.pageUrl,
    gameUrl: activeSession.gameUrl || ""
  });
  activeSession.localSessionId = started.sessionId;
  console.log("[poki-dl] 本地会话已恢复:", started.sessionId);
}

function toRelPath(filename) {
  const folder = activeSession?.folder;
  if (folder && filename.startsWith(`${folder}/`)) {
    return filename.slice(folder.length + 1);
  }
  const slash = filename.indexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

function applyIngestResult(result, sourceUrl, localPath, requestType) {
  if (!activeSession || !result) return;
  const alreadyTracked = activeSession.downloadedLocalPaths.has(localPath);
  const existing = activeSession.files.find((f) => f.localPath === localPath);
  const resolvedSourceUrl = sourceUrl || existing?.sourceUrl || "";

  if (result.status === "skipped") {
    if (!alreadyTracked) activeSession.stats.skipped += 1;
    activeSession.downloadedLocalPaths.add(localPath);
    upsertFile({
      type: "asset",
      sourceUrl: resolvedSourceUrl,
      localPath,
      status: "ok",
      requestType,
      skipped: true
    });
    return;
  }
  if (result.status === "ok") {
    if (!alreadyTracked) activeSession.stats.downloaded += 1;
    activeSession.downloadedLocalPaths.add(localPath);
    upsertFile({
      type: "asset",
      sourceUrl: resolvedSourceUrl,
      localPath,
      status: "ok",
      requestType
    });
    return;
  }
  if (!alreadyTracked) activeSession.stats.failed += 1;
  upsertFile({
    type: "asset",
    sourceUrl: resolvedSourceUrl,
    localPath,
    status: "failed",
    requestType,
    error: result.error || "ingest failed"
  });
}

function applyAllIngestResults(data) {
  if (!activeSession || !data?.results?.length) return;
  for (const result of data.results) {
    const relPath = result.relPath;
    if (!relPath) continue;
    const sourceUrl = result._sourceUrl ?? result.sourceUrl ?? "";
    const requestType = result._requestType ?? "url";
    applyIngestResult(result, sourceUrl, relPath, requestType);
  }
  schedulePersist();
  scheduleManifest();
  void updateBadgeCount();
}

async function flushLocalSinkAndApply() {
  if (!localSink.isEnabled()) return { results: [] };
  return localSink.flushQueue();
}

async function saveDataUrl(localPath, dataUrl, sourceUrl = "", requestType = "data-url") {
  if (!localSink.isEnabled()) {
    return downloadUrl(dataUrl, `${activeSession.folder}/${localPath}`, requestType);
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("invalid data URL");
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const encoding = meta.includes(";base64") ? "base64" : "utf8";
  await ensureLocalSinkSession();
  await flushLocalSinkAndApply();
  const result = await localSink.ingestImmediate({
    relPath: localPath,
    body,
    encoding,
    overwrite: true
  });
  applyIngestResult(result, sourceUrl, localPath, requestType);
  if (result?.status === "failed") {
    throw new Error(result.error || "ingest failed");
  }
  if (result?.status === "skipped") {
    throw new Error(`生成文件未写入（已跳过）: ${localPath}`);
  }
}

async function downloadUrl(url, filename, requestType = "url") {
  const localPath = toRelPath(filename);
  if (localSink.isEnabled()) {
    await ensureLocalSinkSession();
    localSink.enqueueUrl(url, localPath, requestType);
    const data = await flushLocalSinkAndApply();
    const result = data?.results?.find((r) => r.relPath === localPath);
    if (result?.status === "failed") {
      throw new Error(result.error || "ingest failed");
    }
    return;
  }
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, ...DOWNLOAD_OPTS },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

async function downloadText(filename, textContent, mimeType) {
  const localPath = toRelPath(filename);
  if (localSink.isEnabled()) {
    await ensureLocalSinkSession();
    await flushLocalSinkAndApply();
    const result = await localSink.saveText(localPath, textContent, { overwrite: true });
    applyIngestResult(result, "", localPath, "text");
    if (result?.status === "failed") {
      throw new Error(result.error || `写入失败: ${localPath}`);
    }
    if (result?.status === "skipped") {
      throw new Error(`生成文件未写入（已跳过）: ${localPath}`);
    }
    return;
  }
  const bytes = new TextEncoder().encode(textContent);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, ...DOWNLOAD_OPTS },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function upsertFile(record) {
  if (!activeSession) return;
  const idx = activeSession.files.findIndex(
    (f) => f.localPath === record.localPath || f.sourceUrl === record.sourceUrl
  );
  if (idx >= 0) {
    activeSession.files[idx] = { ...activeSession.files[idx], ...record };
  } else {
    activeSession.files.push(record);
  }
}

/* ── Status & badge ────────────────────────────────────────── */

function buildStatusPayload() {
  if (!activeSession) return { status: "idle" };
  return {
    status: activeSession.status,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    portalSlug: activeSession.portalSlug || "",
    stats: activeSession.stats,
    fileCount: activeSession.files.length,
    gameDetected: !!activeSession.gameHost,
    gameHost: activeSession.gameHost || "",
    htmlCaptured: activeSession.htmlCaptured,
    networkCacheSize: networkHtmlCache.size,
    debuggerAttached,
    bufferSize: requestBuffer.length,
    sinkMode: activeSession.sinkMode || "chrome-downloads",
    portalInfoSaved: !!activeSession.portalInfo
  };
}

async function updateBadgeCount() {
  if (!activeSession) return;
  const count = activeSession.stats.downloaded;
  const text = count > 999 ? "999+" : String(count);
  await chrome.action.setBadgeText({ tabId: activeSession.tabId, text });
}

/* ── Session persistence ───────────────────────────────────── */

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistSession();
  }, 5000);
}

function scheduleManifest() {
  if (manifestTimer) return;
  manifestTimer = setTimeout(() => {
    manifestTimer = null;
    void writeManifest();
  }, 3000);
}

function buildManifestPayloadFromSession() {
  if (!activeSession) return null;
  return {
    manifestVersion: 1,
    gameName: activeSession.gameName,
    pageUrl: activeSession.pageUrl,
    gameUrl: activeSession.gameUrl || "",
    portalInfo: activeSession.portalInfo || null,
    engine: detectGameEngine(),
    startedAt: activeSession.startedAt,
    stoppedAt: activeSession.stoppedAt || "",
    status: activeSession.status,
    stats: activeSession.stats,
    files: activeSession.files
  };
}

async function readExistingManifestFromDisk() {
  if (!activeSession) return null;
  if (localSink.isEnabled()) {
    try {
      await ensureLocalSinkSession();
      const text = await localSink.readText(MANIFEST_REL_PATH);
      if (text) return JSON.parse(text);
    } catch (e) {
      console.warn("[poki-dl] 读取 manifest 失败:", e.message);
    }
    return null;
  }
  return null;
}

async function saveManifestJson(merged) {
  if (!activeSession) return;
  const json = JSON.stringify(merged, null, 2);
  if (localSink.isEnabled()) {
    await ensureLocalSinkSession();
    await flushLocalSinkAndApply();
    await localSink.saveText(MANIFEST_REL_PATH, json, { overwrite: true });
    return;
  }
  const filename = `${activeSession.folder}/${MANIFEST_REL_PATH}`;
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const dataUrl = `data:application/json;charset=utf-8;base64,${btoa(binary)}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, ...DOWNLOAD_OPTS },
      (downloadId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      }
    );
  });
}

async function hydrateSessionFromManifestOnDisk() {
  const existing = await readExistingManifestFromDisk();
  if (existing) hydrateSessionFiles(activeSession, existing);
}

async function persistSession() {
  if (!activeSession) return;
  const serializable = {
    tabId: activeSession.tabId,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    portalSlug: activeSession.portalSlug || "",
    pageUrl: activeSession.pageUrl,
    startedAt: activeSession.startedAt,
    status: activeSession.status,
    gameHost: activeSession.gameHost,
    gameUrl: activeSession.gameUrl,
    gameBaseUrl: activeSession.gameBaseUrl,
    stats: activeSession.stats,
    seenUrlsList: Array.from(activeSession.seenUrls),
    files: activeSession.files,
    htmlCaptured: activeSession.htmlCaptured,
    fontDataUrls: activeSession.fontDataUrls || {},
    sinkMode: activeSession.sinkMode,
    localSessionId: activeSession.localSessionId
  };
  await chrome.storage.local.set({ activeSession: serializable });
}

async function restoreSession() {
  try {
    const stored = await chrome.storage.local.get("activeSession");
    const saved = stored.activeSession;
    if (!saved || saved.status !== "listening") return;

    const files = saved.files || [];
    const downloadedPaths = new Set(
      files.filter((f) => f.status === "ok" && f.localPath).map((f) => f.localPath)
    );
    activeSession = {
      ...saved,
      seenUrls: new Set(saved.seenUrlsList || []),
      pending: new Set(),
      downloadedLocalPaths: downloadedPaths,
      fontDataUrls: saved.fontDataUrls || {},
      sinkMode: saved.sinkMode || "chrome-downloads",
      localSessionId: saved.localSessionId || null
    };
    delete activeSession.seenUrlsList;

    await localSink.loadSettings();
    if (localSink.isEnabled() && activeSession.folder) {
      try {
        const started = await localSink.startSession({
          gameName: activeSession.gameName,
          relPrefix: activeSession.folder,
          pageUrl: activeSession.pageUrl,
          gameUrl: activeSession.gameUrl || ""
        });
        activeSession.localSessionId = started.sessionId;
        activeSession.sinkMode = "local-server";
      } catch (e) {
        console.warn("[poki-dl] 恢复本地会话失败:", e.message);
      }
    }

    if (activeSession.htmlCaptured || (await isIndexHtmlOnDisk())) {
      activeSession.htmlCaptured = true;
    }

    await hydrateSessionFromManifestOnDisk();

    if (activeSession.tabId) {
      void attachDebugger(activeSession.tabId);
      if (!activeSession.gameHost) {
        startGameframeDetection(activeSession.tabId);
      } else if (!activeSession.htmlCaptured && activeSession.gameUrl) {
        scheduleAutoCaptureHtml(activeSession.tabId, "restore");
      }
    }

    await chrome.action.setBadgeBackgroundColor({
      tabId: activeSession.tabId,
      color: "#2563eb"
    });
    await updateBadgeCount();
  } catch {
    activeSession = null;
  }
}

async function writeManifest() {
  if (!activeSession) return;
  const incoming = buildManifestPayloadFromSession();
  if (!incoming) return;
  let existing = null;
  try {
    existing = await readExistingManifestFromDisk();
  } catch (e) {
    console.warn("[poki-dl] merge manifest read:", e.message);
  }
  const merged = mergeManifest(existing, incoming);
  await saveManifestJson(merged);
}

/* ── Portal info (Poki 游戏页 article / 元数据) ─────────────── */

function schedulePortalScrape(tabId) {
  const run = () => {
    if (!activeSession || activeSession.tabId !== tabId) return;
    void scrapeAndSavePortalInfo(tabId);
  };
  setTimeout(run, 1500);
  setTimeout(run, 5000);
}

async function scrapeAndSavePortalInfo(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) return { ok: false };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapePokiPortalPage
    });
    const scraped = results?.[0]?.result;
    if (!scraped?.meta) {
      console.warn("[poki-dl] portal scrape: 无结果（可能 article 未加载）");
      return { ok: false, error: "empty scrape" };
    }

    const folder = activeSession.folder;
    const base = `${folder}/${INFO_ASSETS_DIR}`;

    await downloadText(
      `${base}/meta.json`,
      JSON.stringify(scraped.meta, null, 2),
      "application/json;charset=utf-8"
    );

    if (scraped.articleHtml) {
      await downloadText(
        `${base}/article.html`,
        scraped.articleHtml,
        "text/html;charset=utf-8"
      );
    }

    for (const asset of scraped.assets || []) {
      try {
        await downloadUrl(
          asset.url,
          `${base}/${asset.filename}`,
          "portal-asset"
        );
      } catch (e) {
        console.warn("[poki-dl] portal asset:", asset.url, e.message);
      }
    }

    activeSession.portalInfo = scraped.meta;
    upsertFile({
      type: "portal-info",
      sourceUrl: scraped.meta.portalUrl,
      localPath: `${INFO_ASSETS_DIR}/meta.json`,
      status: "ok"
    });
    schedulePersist();
    scheduleManifest();

    console.log(
      "[poki-dl] portal info:",
      scraped.meta.title,
      `→ ${base}/`
    );
    return { ok: true, meta: scraped.meta };
  } catch (e) {
    console.warn("[poki-dl] portal scrape failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/* ── Page info ─────────────────────────────────────────────── */

async function getPageInfoFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pathMatch = window.location.pathname.match(/\/g\/([^/?#]+)/);
      return {
        pageUrl: window.location.href,
        gameName: pathMatch
          ? decodeURIComponent(pathMatch[1])
          : document.title || "poki-game"
      };
    }
  });
  return results?.[0]?.result || null;
}
