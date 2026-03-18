const OUTPUT_PREFIX = "downloaded-games";

/** 下载选项：重名直接覆盖，不弹「另存为」对话框 */
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

const sessionReady = restoreSession();

/* ── Chrome message listener ───────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_MONITOR") {
    sessionReady
      .then(() =>
        startMonitor(message.tabId, {
          manualGameUrl: message.manualGameUrl || null,
          manualResourceUrls: message.manualResourceUrls || []
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
  if (message?.type === "EXPORT_CONFIG") {
    sessionReady
      .then(() => exportConfig(message.config, message.folder))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "DOWNLOAD_MANUAL_RESOURCES") {
    sessionReady
      .then(() => downloadManualResources(message.tabId, message.urls))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "CAPTURE_HTML") {
    sessionReady
      .then(() => captureAndSaveHtml(message.tabId))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "DOWNLOAD_ASSET") {
    sessionReady
      .then(() => downloadExtraAsset(message.tabId, message.url, message.assetKey))
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!activeSession || activeSession.tabId !== tabId) return;
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
        await downloadUrl(info.url, filename);
        activeSession.downloadedLocalPaths.add(localPath);
        activeSession.seenUrls.add(info.url);
        activeSession.stats.downloaded += 1;
        activeSession.files.push({
          type: "asset",
          sourceUrl: info.url,
          localPath,
          status: "ok",
          requestType: type
        });
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
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: dataUrl, filename, ...DOWNLOAD_OPTS },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        }
      );
    });
    activeSession.downloadedLocalPaths.add(localPath);
    activeSession.seenUrls.add(info.url);
    activeSession.stats.downloaded += 1;
    activeSession.files.push({
      type: "asset",
      sourceUrl: info.url,
      localPath,
      status: "ok",
      requestType: type
    });
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
      await downloadUrl(info.url, filename);
      activeSession.downloadedLocalPaths.add(localPath);
      activeSession.seenUrls.add(info.url);
      activeSession.stats.downloaded += 1;
      activeSession.files.push({
        type: "asset",
        sourceUrl: info.url,
        localPath,
        status: "ok",
        requestType: type
      });
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
      stopGameframeDetection();
      await onGameframeDetected(tabId, src);
    }
  } catch {
    /* frame might not be ready yet */
  }
}

async function onGameframeDetected(tabId, src) {
  if (!activeSession || activeSession.tabId !== tabId) return;
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
    await downloadUrl(url, `${activeSession.folder}/${localPath}`);
    activeSession.downloadedLocalPaths.add(localPath);
    activeSession.stats.downloaded += 1;
    activeSession.files.push({
      type: "asset",
      sourceUrl: url,
      localPath,
      status: "ok",
      requestType
    });
    await updateBadgeCount();
  } catch (error) {
    activeSession.stats.failed += 1;
    activeSession.files.push({
      type: "asset",
      sourceUrl: url,
      localPath,
      status: "failed",
      requestType,
      error: String(error?.message || error)
    });
  } finally {
    activeSession.pending.delete(url);
    schedulePersist();
    scheduleManifest();
  }
}

/* ── Monitor lifecycle ─────────────────────────────────────── */

async function startMonitor(tabId, options = {}) {
  const { manualGameUrl, manualResourceUrls = [] } = options;

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

  const gameName = sanitizeName(pageInfo.gameName || "poki-game");
  const folder = `${OUTPUT_PREFIX}/${gameName}`;

  activeSession = {
    tabId,
    gameName,
    folder,
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
    fontDataUrls: {}
  };

  requestBuffer = [];
  networkHtmlCache.clear();

  const dbgOk = await attachDebugger(tabId);

  if (manualGameUrl && manualGameUrl.startsWith("http")) {
    try {
      const url = new URL(manualGameUrl);
      activeSession.gameHost = url.host;
      activeSession.gameUrl = manualGameUrl;
      activeSession.gameBaseUrl = getBaseUrl(manualGameUrl);
      console.log(`[poki-dl] 使用手动游戏地址: ${url.host}, base: ${activeSession.gameBaseUrl}`);
      await flushRequestBuffer();
    } catch (e) {
      console.warn("[poki-dl] 手动游戏地址解析失败:", e.message);
    }
  }

  if (!activeSession.gameHost) startGameframeDetection(tabId);

  if (manualResourceUrls.length > 0) {
    void downloadManualResources(tabId, manualResourceUrls);
  }

  await persistSession();
  await chrome.storage.local.set({ lastGameInfo: { gameName, folder } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

  // 使用手动游戏地址时，资源请求往往已在之前完成，只有刷新页面才会再次发起请求。
  // 延迟刷新，确保 session 已写入 storage（否则 SW 被终止后恢复时可能读不到 gameHost）
  if (manualGameUrl && manualGameUrl.startsWith("http") && activeSession.gameHost) {
    setTimeout(() => {
      chrome.tabs.reload(tabId).catch((e) => console.warn("[poki-dl] 自动刷新失败:", e?.message));
    }, 500);
  }

  return { gameName, folder, status: "listening", debugger: dbgOk };
}

async function captureAndSaveHtml(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    throw new Error("当前没有监听会话。");
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

  activeSession.htmlCaptured = true;
  await persistSession();

  return { message: "已生成 index.html、poki-sdk-stub.js" };
}

async function stopMonitor(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle" };
  }

  stopGameframeDetection();
  const errors = [];

  if (!activeSession.htmlCaptured && activeSession.gameUrl) {
    try {
      await captureAndSaveHtml(tabId);
    } catch (e) {
      errors.push(e.message);
    }
  }

  try {
    await detachDebugger(tabId);
  } catch { /* ignore */ }

  activeSession.status = "stopped";
  activeSession.stoppedAt = new Date().toISOString();

  try {
    await writeManifest();
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

  window.PokiSDK = {
    init: _pp,
    gameplayStart: _pn,
    gameplayStop: _pn,
    commercialBreak: _pp,
    rewardedBreak: function() { return Promise.resolve(true); },
    displayAd: _pn,
    destroyAd: _pn,
    setDebug: _pn,
    getURLParam: function() { return ""; },
    shareableURL: function() { return Promise.resolve(""); },
    isAdBlocked: function() { return false; },
    gameLoadingStart: _pn,
    gameLoadingFinished: _hideLoading,
    gameLoadingProgress: _pn,
    gameInteractive: _hideLoading,
    customEvent: _pn,
    happyTime: _pn,
    logError: _pn,
    roundStart: _pn,
    roundEnd: _pn,
    muteAd: _pn,
    sendHighscore: _pn,
    togglePlayerAdvertisingConsent: _pn,
    disableDOMChangeObservation: _pn
  };
  console.log("[poki-dl] PokiSDK stub active");

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
    if (u.includes("poki-sdk-core") || u.includes("poki-sdk-hoist"))
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
    .replace(/<script[^>]*src="[^"]*\/poki-sdk\.js"[^>]*><\/script>/gi, "");
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

/* ── Extra asset download ──────────────────────────────────── */

async function downloadExtraAsset(tabId, url, assetKey) {
  if (!url || !url.startsWith("http")) {
    throw new Error("请输入有效的 URL 地址。");
  }

  let gameName, folder;
  if (activeSession) {
    gameName = activeSession.gameName;
    folder = activeSession.folder;
  } else {
    const stored = await chrome.storage.local.get("lastGameInfo");
    const info = stored.lastGameInfo;
    if (!info?.gameName || !info?.folder) {
      throw new Error("无游戏信息，请先开始监听并下载一次游戏。");
    }
    gameName = info.gameName;
    folder = info.folder;
  }

  const ext = extractExtFromUrl(url);
  const filename = `${gameName}_${assetKey}${ext}`;
  const localPath = `__assets__/${filename}`;
  const fullPath = `${folder}/${localPath}`;

  await downloadUrl(url, fullPath);

  if (activeSession) {
    upsertFile({
      type: "extra-asset",
      sourceUrl: url,
      localPath,
      status: "ok",
      assetKey
    });
    activeSession.stats.downloaded += 1;
    schedulePersist();
    scheduleManifest();
  }

  console.log(`[poki-dl] extra asset downloaded: ${localPath}`);
  return { localPath, filename };
}

/** 手动指定的静态资源 URL 列表，下载到游戏目录 */
async function downloadManualResources(tabId, urls) {
  const list = Array.isArray(urls) ? urls.filter((u) => u && String(u).startsWith("http")) : [];
  if (list.length === 0) return { ok: true, downloaded: 0 };

  let folder, gameName;
  if (activeSession && activeSession.tabId === tabId) {
    folder = activeSession.folder;
    gameName = activeSession.gameName;
  } else {
    const stored = await chrome.storage.local.get("lastGameInfo");
    const info = stored.lastGameInfo;
    if (!info?.folder) throw new Error("无游戏目录，请先开始监听。");
    folder = info.folder;
    gameName = info.gameName || "poki-game";
  }

  let downloaded = 0;
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    const localPath = urlToLocalPath(url);
    if (activeSession && activeSession.downloadedLocalPaths.has(localPath)) {
      activeSession.seenUrls.add(url);
      continue;
    }
    try {
      await downloadUrl(url, `${folder}/${localPath}`);
      downloaded += 1;
      if (activeSession) {
        activeSession.downloadedLocalPaths.add(localPath);
        activeSession.seenUrls.add(url);
        activeSession.stats.downloaded += 1;
        upsertFile({ type: "asset", sourceUrl: url, localPath, status: "ok", requestType: "manual" });
        schedulePersist();
        scheduleManifest();
        updateBadgeCount();
      }
    } catch (err) {
      console.warn(`[poki-dl] manual resource failed: ${url}`, err.message);
      if (activeSession) {
        activeSession.stats.failed += 1;
        upsertFile({
          type: "asset",
          sourceUrl: url,
          localPath,
          status: "failed",
          requestType: "manual",
          error: String(err?.message || err)
        });
      }
    }
  }
  console.log(`[poki-dl] manual resources: ${downloaded}/${list.length} downloaded`);
  return { ok: true, downloaded, total: list.length };
}

/** 导出配置为 JSON 并下载到游戏目录（相对于浏览器默认下载目录） */
async function exportConfig(config, folder) {
  if (!folder) {
    const stored = await chrome.storage.local.get("lastGameInfo");
    folder = stored.lastGameInfo?.folder;
  }
  if (!folder) throw new Error("无游戏目录，请先开始监听。");

  const json = JSON.stringify(
    {
      gameName: config.gameName,
      folder: config.folder,
      manualGameUrl: config.manualGameUrl || null,
      manualResourceUrls: config.manualResourceUrls || []
    },
    null,
    2
  );

  const filename = `${folder}/poki-download-config.json`;
  await downloadText(filename, json, "application/json");
  return { ok: true, filename };
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

async function downloadUrl(url, filename) {
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
    stats: activeSession.stats,
    fileCount: activeSession.files.length,
    gameDetected: !!activeSession.gameHost,
    gameHost: activeSession.gameHost || "",
    htmlCaptured: activeSession.htmlCaptured,
    networkCacheSize: networkHtmlCache.size,
    debuggerAttached,
    bufferSize: requestBuffer.length
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
  }, 8000);
}

async function persistSession() {
  if (!activeSession) return;
  const serializable = {
    tabId: activeSession.tabId,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
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
    fontDataUrls: activeSession.fontDataUrls || {}
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
      fontDataUrls: saved.fontDataUrls || {}
    };
    delete activeSession.seenUrlsList;

    if (activeSession.tabId) {
      void attachDebugger(activeSession.tabId);
      if (!activeSession.gameHost) {
        startGameframeDetection(activeSession.tabId);
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
  const payload = {
    gameName: activeSession.gameName,
    pageUrl: activeSession.pageUrl,
    gameUrl: activeSession.gameUrl || "",
    engine: detectGameEngine(),
    startedAt: activeSession.startedAt,
    stoppedAt: activeSession.stoppedAt || "",
    status: activeSession.status,
    stats: activeSession.stats,
    files: activeSession.files
  };
  await downloadText(
    `${activeSession.folder}/assets-manifest.json`,
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8"
  );
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
