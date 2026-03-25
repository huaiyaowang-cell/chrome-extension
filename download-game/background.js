import {
  getPokiSdkStub,
  getMinigameSdkStub,
  getCrazyGamesSdkStub
} from "./stubs.js";

const DOWNLOAD_OPTS = { conflictAction: "overwrite", saveAs: false };

const TRACKER_KEYWORDS = [
  "google-analytics", "googletagmanager", "doubleclick",
  "googlesyndication", "adservice.", "sentry.io",
  "hotjar", "intercom", "facebook.net",
  "mixpanel", "segment.io", "amplitude",
  "statsig", "branch.io", "adjust.com",
  "gtag/js"
];

let activeSession = null;
let persistTimer = null;
let manifestTimer = null;
let debuggerAttached = false;
let pendingNetworkCaptures = new Map();
const networkHtmlCache = new Map();
const sessionReady = restoreSession();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_MONITOR") {
    sessionReady
      .then(() => startMonitor(message.tabId, message.config || {}))
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
  if (message?.type === "CAPTURE_HTML") {
    sessionReady
      .then(() => captureAndSaveHtml(message.tabId))
      .then((r) => sendResponse({ ok: true, ...r }))
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
  if (message?.type === "DOWNLOAD_ASSET") {
    sessionReady
      .then(() => downloadExtraAsset(message.tabId, message.url, message.assetKey))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "EXPORT_CONFIG") {
    sessionReady
      .then(() => exportConfigJson(message.config, message.folder))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    void sessionReady.then(() => {
      if (!activeSession || details.tabId !== activeSession.tabId) return;
      if (activeSession.status !== "listening") return;

      const url = details.url;
      if (!url.startsWith("http")) return;

      if (details.type === "main_frame" || details.type === "sub_frame") {
        if (shouldCaptureDocumentForCache(url)) {
          void fetchAndCacheHtmlFromUrl(url);
        }
        return;
      }

      activeSession.stats.totalSeen += 1;
      if (activeSession.seenUrls.has(url)) return;
      if (isTrackerUrl(url)) {
        activeSession.stats.skipped += 1;
        return;
      }

      if (!urlMatchesListen(url)) return;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSession?.tabId === tabId) {
    void detachDebugger(tabId);
    activeSession = null;
    chrome.storage.local.remove("activeSession");
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!activeSession || source.tabId !== activeSession.tabId) return;
  if (activeSession.status !== "listening") return;

  if (method === "Network.responseReceived") {
    const { response, requestId, type } = params;
    const url = response.url || "";
    if (!url || !url.startsWith("http")) return;

    if (type === "Document") {
      if (shouldCaptureDocumentForCache(url)) {
        pendingNetworkCaptures.set(requestId, { url, type: "Document" });
      }
      return;
    }
    if (
      urlMatchesListen(url) &&
      ["Script", "XHR", "Fetch", "Stylesheet", "Image", "Media", "Font", "Other"].includes(type)
    ) {
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
    console.warn(`[game-dl] debugger detached: ${reason}`);
  }
});

function normalizeListenPrefix(s) {
  if (!s || typeof s !== "string") return "";
  let t = s.trim().split("?")[0];
  while (t.length > 1 && t.endsWith("/")) t = t.slice(0, -1);
  return t;
}

function defaultListenUrlFromGameUrl(gameUrl) {
  try {
    const u = new URL(gameUrl);
    let p = u.pathname;
    if (/\.html?$/i.test(p)) p = p.replace(/\/[^/]+$/, "");
    p = p.replace(/\/+$/, "") || "/";
    return u.origin + (p === "/" ? "" : p);
  } catch {
    return "";
  }
}

function urlMatchesListen(urlString) {
  if (!activeSession?.listenPrefixes?.length) return false;
  const u = urlString.split("?")[0];
  return activeSession.listenPrefixes.some((prefix) => {
    if (!prefix) return false;
    return u === prefix || u.startsWith(prefix + "/");
  });
}

/** 游戏入口 URL 与某次导航/响应 URL 是否视为同一文档（用于 HTML 缓存键对齐） */
function isSameDocumentAsGame(gameUrl, docUrl) {
  if (!gameUrl || !docUrl) return false;
  const g = gameUrl.split("?")[0];
  const d = docUrl.split("?")[0];
  if (g === d) return true;
  try {
    const Gu = new URL(g);
    const Du = new URL(d);
    if (Gu.origin !== Du.origin) return false;
    const gp = Gu.pathname.replace(/\/$/, "") || "/";
    const dp = Du.pathname.replace(/\/$/, "") || "/";
    if (gp === dp) return true;
    const gNoIdx = gp.replace(/\/index\.html?$/i, "");
    const dNoIdx = dp.replace(/\/index\.html?$/i, "");
    if (gNoIdx === dNoIdx) return true;
    if (gp.endsWith(".html") && !dp.endsWith(".html")) {
      const dir = gp.slice(0, gp.lastIndexOf("/"));
      if (dp === dir || dp === gNoIdx) return true;
    }
    if (!gp.endsWith(".html") && dp.endsWith(".html")) {
      const dir = dp.slice(0, dp.lastIndexOf("/"));
      if (gp === dir || gp === dNoIdx) return true;
    }
  } catch {}
  return false;
}

function shouldCaptureDocumentForCache(urlString) {
  if (!activeSession || !urlString.startsWith("http")) return false;
  if (urlMatchesListen(urlString)) return true;
  if (isSameDocumentAsGame(activeSession.gameUrl, urlString)) return true;
  if (isUnderGameBase(urlString)) {
    try {
      const p = new URL(urlString).pathname.toLowerCase();
      if (p.endsWith(".html") || p.endsWith(".htm")) return true;
    } catch {}
  }
  return false;
}

function rememberHtmlCache(url, html) {
  if (!html || html.length < 20) return;
  if (networkHtmlCache.size > 120) {
    const oldest = networkHtmlCache.keys().next().value;
    networkHtmlCache.delete(oldest);
  }
  const base = url.split("?")[0];
  networkHtmlCache.set(url, html);
  networkHtmlCache.set(base, html);
  if (activeSession?.gameUrl) {
    const gu = activeSession.gameUrl;
    const gb = gu.split("?")[0];
    if (isSameDocumentAsGame(gu, url)) {
      networkHtmlCache.set(gu, html);
      networkHtmlCache.set(gb, html);
    }
  }
}

function resolveGameHtmlForGenerate() {
  const gameUrl = activeSession?.gameUrl;
  if (!gameUrl) return null;
  let h = findInNetworkCache(gameUrl);
  if (h) return h;
  for (const [u, body] of networkHtmlCache) {
    if (isSameDocumentAsGame(gameUrl, u)) return body;
  }
  return null;
}

async function fetchAndCacheHtmlFromUrl(url) {
  if (!activeSession) return;
  const base = url.split("?")[0];
  if (networkHtmlCache.has(url) || networkHtmlCache.has(base)) return;
  try {
    const resp = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!resp.ok) return;
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("html") && !ct.includes("xml") && !/\.html?(\?|$)/i.test(url)) return;
    const text = await resp.text();
    rememberHtmlCache(url, text);
    console.log("[game-dl] HTML cached (navigation fetch):", url.slice(0, 96));
  } catch (e) {
    console.warn("[game-dl] fetch HTML cache failed:", url.slice(0, 80), e.message);
  }
}

function isUnderGameBase(urlString) {
  if (!activeSession?.gameBaseUrl) return false;
  try {
    const u = new URL(urlString);
    const b = new URL(activeSession.gameBaseUrl);
    if (u.origin !== b.origin) return false;
    const up = u.pathname;
    const bp = b.pathname.endsWith("/") ? b.pathname.slice(0, -1) : b.pathname;
    return up === bp || up.startsWith(bp + "/");
  } catch {
    return false;
  }
}

async function attachDebugger(tabId) {
  if (debuggerAttached) return true;
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        console.warn("[game-dl] debugger attach failed:", chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          console.warn("[game-dl] Network.enable failed:", chrome.runtime.lastError.message);
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
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        }
      );
    });

    const type = info.type || "Document";
    const isDocument = type === "Document";
    let bodyDecoded = null;

    if (isDocument) {
      bodyDecoded = result.base64Encoded ? decodeBase64Body(result.body) : result.body;
      if (!bodyDecoded || bodyDecoded.length < 20) return;
      rememberHtmlCache(info.url, bodyDecoded);
    }

    if (!activeSession || activeSession.tabId !== tabId) return;
    const docOk =
      isDocument &&
      (shouldCaptureDocumentForCache(info.url) ||
        isSameDocumentAsGame(activeSession.gameUrl, info.url));
    if (!urlMatchesListen(info.url) && !docOk) {
      return;
    }

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
        schedulePersist();
        scheduleManifest();
        updateBadgeCount();
      } catch (e2) {
        console.warn("[game-dl] 直链下载失败:", info.url.slice(0, 60), e2.message);
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
    schedulePersist();
    scheduleManifest();
    updateBadgeCount();
  } catch (e) {
    console.warn("[game-dl] getResponseBody/save failed:", e.message);
    if (!activeSession || activeSession.tabId !== tabId) return;
    if (!urlMatchesListen(info.url)) return;
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
      schedulePersist();
      scheduleManifest();
      updateBadgeCount();
    } catch (e2) {
      console.warn("[game-dl] 直链回退也失败:", info.url.slice(0, 60), e2.message);
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

function isSameGameHost(requestHost, gameHost) {
  if (!requestHost || !gameHost) return false;
  if (requestHost === gameHost) return true;
  if (gameHost.endsWith(".gdn.poki.com") && requestHost.endsWith(".gdn.poki.com")) return true;
  return false;
}

async function processRequest(url, requestType) {
  if (!activeSession) return;
  if (!urlMatchesListen(url)) return;
  if (activeSession.seenUrls.has(url)) return;
  activeSession.seenUrls.add(url);

  const localPath = urlToLocalPath(url);
  if (activeSession.downloadedLocalPaths.has(localPath)) return;
  if (activeSession.pending.has(url)) return;
  activeSession.pending.add(url);

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

async function startMonitor(tabId, config) {
  const platform = config.platform || "crazygames";
  const gameUrl = (config.gameUrl || "").trim();
  if (!gameUrl.startsWith("http")) throw new Error("请填写有效的游戏 URL。");

  const gameName = sanitizeName(config.gameName || "game");
  const downloadDir = (config.downloadDir || "downloaded-games").trim().replace(/^\/+|\/+$/g, "");
  if (!downloadDir) throw new Error("请填写下载目录。");

  let listenPrefixes = (Array.isArray(config.listenUrls) ? config.listenUrls : [])
    .map((s) => normalizeListenPrefix(String(s || "")))
    .filter(Boolean);
  if (listenPrefixes.length === 0) {
    const d = defaultListenUrlFromGameUrl(gameUrl);
    if (d) listenPrefixes = [normalizeListenPrefix(d)];
  }
  if (listenPrefixes.length === 0) throw new Error("无法从游戏 URL 推导监听前缀，请添加监听 URL。");

  let gameHost;
  let gameBaseUrl;
  try {
    const u = new URL(gameUrl);
    gameHost = u.host;
    gameBaseUrl = getBaseUrl(gameUrl);
  } catch {
    throw new Error("游戏 URL 无法解析。");
  }

  const folder = `${downloadDir}/${gameName}`;

  activeSession = {
    tabId,
    platform,
    gameName,
    folder,
    downloadDir,
    gameUrl,
    gameHost,
    gameBaseUrl,
    listenPrefixes,
    pageUrl: "",
    startedAt: new Date().toISOString(),
    status: "listening",
    seenUrls: new Set(),
    pending: new Set(),
    downloadedLocalPaths: new Set(),
    stats: { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 },
    files: [],
    htmlCaptured: false,
    fontDataUrls: {}
  };

  networkHtmlCache.clear();

  const dbgOk = await attachDebugger(tabId);

  const manualResourceUrls = Array.isArray(config.manualResourceUrls)
    ? config.manualResourceUrls.filter((u) => u && String(u).startsWith("http"))
    : [];
  if (manualResourceUrls.length > 0) {
    void downloadManualResources(tabId, manualResourceUrls);
  }

  await persistSession();
  await chrome.storage.local.set({
    lastGameInfo: { gameName, folder, platform, downloadDir }
  });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#7c3aed" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

  setTimeout(() => {
    chrome.tabs.reload(tabId).catch((e) => console.warn("[game-dl] 自动刷新失败:", e?.message));
  }, 500);

  return { gameName, folder, status: "listening", debugger: dbgOk };
}

async function captureAndSaveHtml(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    throw new Error("当前没有监听会话。");
  }
  const gameUrl = activeSession.gameUrl;
  if (!gameUrl) throw new Error("缺少游戏 URL。");

  let rawHtml = resolveGameHtmlForGenerate();
  if (!rawHtml) {
    try {
      const resp = await fetch(gameUrl, { cache: "no-store", credentials: "omit" });
      if (resp.ok) {
        const t = await resp.text();
        if (t && t.length > 20) {
          rememberHtmlCache(gameUrl, t);
          rawHtml = t;
        }
      }
    } catch (_) {}
  }
  if (!rawHtml) {
    throw new Error(
      `未缓存到入口 HTML（${gameUrl.slice(0, 80)}…）。请保持监听并刷新/进入游戏，让主框架或 iframe 加载入口页后再试。`
    );
  }

  await generateIndexAndCompat(rawHtml, gameUrl);
  activeSession.htmlCaptured = true;
  await persistSession();
  return { message: "已生成本地入口与桩脚本" };
}

async function stopMonitor(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle" };
  }

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
  } catch {}

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
  } catch {}

  activeSession = null;
  await chrome.storage.local.remove("activeSession");
  return result;
}

function getMonitorStatus(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) return { status: "idle" };
  return buildStatusPayload();
}

function buildStatusPayload() {
  if (!activeSession) return { status: "idle" };
  return {
    status: activeSession.status,
    platform: activeSession.platform,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    stats: activeSession.stats,
    fileCount: activeSession.files.length,
    gameHost: activeSession.gameHost || "",
    htmlCaptured: activeSession.htmlCaptured,
    networkCacheSize: networkHtmlCache.size,
    debuggerAttached,
    listenCount: activeSession.listenPrefixes?.length || 0
  };
}

async function updateBadgeCount() {
  if (!activeSession) return;
  const count = activeSession.stats.downloaded;
  const text = count > 999 ? "999+" : String(count);
  await chrome.action.setBadgeText({ tabId: activeSession.tabId, text });
}

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

async function generateIndexAndCompat(rawHtml, gameUrl) {
  const gameBaseUrl = getBaseUrl(gameUrl);
  const urlMap = buildUrlToLocalMap();

  let html = rawHtml;
  html = rewriteAllUrls(html, urlMap);
  html = rewriteRemainingAbsoluteUrls(html, gameBaseUrl);
  html = neutralizeTrackersCommon(html);

  const plat = activeSession.platform;
  if (plat === "poki") {
    html = neutralizePokiSdk(html);
    html = removeDynamicLoaderContent(html, detectGameEngine());
    html = inlineFontDataUrls(html);
    html = html.replace(
      /<meta\s+name="apple-mobile-web-app-capable"\s+content="[^"]*"\s*\/?>/gi,
      '<meta name="mobile-web-app-capable" content="yes">'
    );
    const tags = '<script src="poki-sdk-stub.js"></script>\n<script src="interceptor.js"></script>';
    html = injectAfterHead(html, tags);
    await downloadText(`${activeSession.folder}/index.html`, html, "text/html;charset=utf-8");
    await downloadText(
      `${activeSession.folder}/poki-sdk-stub.js`,
      getPokiSdkStub(),
      "text/javascript;charset=utf-8"
    );
    await downloadText(
      `${activeSession.folder}/interceptor.js`,
      buildInterceptorContent("poki"),
      "text/javascript;charset=utf-8"
    );
    upsertFile({ type: "entry-html", sourceUrl: gameUrl, localPath: "index.html", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "poki-sdk-stub.js", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "interceptor.js", status: "ok" });
  } else if (plat === "minigame") {
    html = neutralizeMinigameSdk(html);
    html = removeDynamicLoaderContent(html, detectGameEngine());
    const tags = '<script src="minigame-sdk-stub.js"></script>\n<script src="interceptor.js"></script>';
    html = injectAfterHead(html, tags);
    await downloadText(`${activeSession.folder}/index.html`, html, "text/html;charset=utf-8");
    await downloadText(
      `${activeSession.folder}/minigame-sdk-stub.js`,
      getMinigameSdkStub(),
      "text/javascript;charset=utf-8"
    );
    await downloadText(
      `${activeSession.folder}/interceptor.js`,
      buildInterceptorContent("minigame"),
      "text/javascript;charset=utf-8"
    );
    upsertFile({ type: "entry-html", sourceUrl: gameUrl, localPath: "index.html", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "minigame-sdk-stub.js", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "interceptor.js", status: "ok" });
  } else {
    html = neutralizeCrazyGamesSdk(html);
    html = removeDynamicLoaderContent(html, detectGameEngine());
    const tags = '<script src="crazygames-sdk-stub.js"></script>\n<script src="interceptor.js"></script>';
    html = injectAfterHead(html, tags);
    await downloadText(`${activeSession.folder}/index.html`, html, "text/html;charset=utf-8");
    await downloadText(
      `${activeSession.folder}/crazygames-sdk-stub.js`,
      getCrazyGamesSdkStub(),
      "text/javascript;charset=utf-8"
    );
    await downloadText(
      `${activeSession.folder}/interceptor.js`,
      buildInterceptorContent("crazygames"),
      "text/javascript;charset=utf-8"
    );
    upsertFile({ type: "entry-html", sourceUrl: gameUrl, localPath: "index.html", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "crazygames-sdk-stub.js", status: "ok" });
    upsertFile({ type: "compat-script", sourceUrl: "", localPath: "interceptor.js", status: "ok" });
  }
}

function injectAfterHead(html, scriptTags) {
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) return html.replace(headMatch[0], headMatch[0] + "\n" + scriptTags);
  return scriptTags + "\n" + html;
}

function neutralizeTrackersCommon(html) {
  html = html.replace(/<script[^>]*src="[^"]*googletagmanager[^"]*"[^>]*><\/script>/gi, "");
  html = html.replace(/<script[^>]*src="[^"]*google-analytics[^"]*"[^>]*><\/script>/gi, "");
  html = html.replace(/<script[^>]*src="[^"]*gtag\/js[^"]*"[^>]*><\/script>/gi, "");
  return html;
}

function neutralizePokiSdk(html) {
  html = html
    .replace(/<script[^>]*src="[^"]*poki-sdk-hoist[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*src="[^"]*\/poki-sdk\.js"[^>]*><\/script>/gi, "");
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

function neutralizeMinigameSdk(html) {
  html = html.replace(/<script[^>]*src="[^"]*minigame-sdk[^"]*"[^>]*><\/script>/gi, "");
  html = html.replace(/var\s+sdkName\s*=\s*["']FaceBook["']\s*;/g, `var sdkName = "FaceBookTest";`);
  html = html.replace(/<script[^>]*src="[^"]*\/minigame\.js[^"]*"[^>]*><\/script>/gi, "");
  html = html.replace(/<script[^>]*src="[^"]*sdk\.minigame\.vip[^"]*"[^>]*><\/script>/gi, "");
  if (html.includes("loadJs(\"./js/1.0/minigame-sdk.js\"") || html.includes("loadJs('./js/1.0/minigame-sdk.js'")) {
    html = html.replace(
      /loadJs\s*\(\s*["']\.\/js\/1\.0\/minigame-sdk\.js["'][\s\S]*?function\s*\(\s*\)\s*\{/g,
      "(function(){"
    );
    html = html.replace(
      /\}\s*\)\s*;\s*\}\s*\)\s*;\s*(\s*if\s*\(\s*sdkName\s*==\s*["']FaceBookTest["']\s*\)\s*\{)/g,
      "}); })();$1"
    );
  }
  const re = /<script>(?=[\s\S]{5000})([\s\S]*?)<\/script>/gi;
  return html.replace(re, (match, content) => {
    if (
      content.includes("FBInstant") ||
      content.includes("minigame-sdk") ||
      content.includes("minigameLoader") ||
      content.includes("MiniGameAds")
    ) {
      return "<!-- minigame-adapter removed -->";
    }
    return match;
  });
}

function neutralizeCrazyGamesSdk(html) {
  html = html.replace(
    /<script[^>]*src="[^"]*crazygames[^"]*sdk[^"]*\.js[^"]*"[^>]*><\/script>/gi,
    "<!-- crazygames sdk script removed -->"
  );
  html = html.replace(
    /<script[^>]*src="[^"]*sdk\.crazygames\.com[^"]*"[^>]*><\/script>/gi,
    "<!-- crazygames cdn sdk removed -->"
  );
  const re = /<script>(?=[\s\S]{2000})([\s\S]*?)<\/script>/gi;
  return html.replace(re, (match, content) => {
    if (
      content.includes("CrazyGames") &&
      (content.includes("CrazySDK") || content.includes("postMessage") || content.includes("GF_WINDOW"))
    ) {
      return "<!-- crazygames inline adapter removed -->";
    }
    return match;
  });
}

function buildInterceptorContent(platform) {
  const knownHosts = new Set();
  if (activeSession) {
    if (activeSession.gameHost) knownHosts.add(activeSession.gameHost);
    for (const f of activeSession.files) {
      if (f.status === "ok" && f.sourceUrl) {
        try {
          knownHosts.add(new URL(f.sourceUrl).host);
        } catch {}
      }
    }
  }
  if (platform === "minigame") {
    knownHosts.add("sdk.minigame.vip");
    knownHosts.add("apps.minigame.vip");
  }
  if (platform === "crazygames") {
    knownHosts.add("sdk.crazygames.com");
    knownHosts.add("games.crazygames.com");
  }

  const gameHost = activeSession?.gameHost || "";
  let gameBasePath = "/";
  if (activeSession?.gameBaseUrl) {
    try {
      gameBasePath = new URL(activeSession.gameBaseUrl).pathname;
    } catch {}
  }

  const blockPoki = platform === "poki"
    ? `if (u.includes("poki-sdk-core") || u.includes("poki-sdk-hoist"))
      return "data:text/javascript,console.log('[game-dl] poki sdk blocked')";`
    : "";
  const blockMini =
    platform === "minigame"
      ? `if (u.includes("minigame-sdk"))
      return "data:text/javascript,console.log('[game-dl] minigame sdk blocked')";
    try {
      var _rp = (new URL(u, location.href)).pathname;
      if (_rp.endsWith("/minigame.js") || _rp === "minigame.js")
        return "data:text/javascript,console.log('[game-dl] minigame loader blocked')";
    } catch (e) {}`
      : "";
  const blockCrazy =
    platform === "crazygames"
      ? `if (u.indexOf("sdk.crazygames.com") >= 0 || u.indexOf("crazygames-sdk") >= 0)
      return "data:text/javascript,console.log('[game-dl] crazygames sdk blocked')";`
      : "";

  return `(function() {
  var KH = ${JSON.stringify(Array.from(knownHosts))};
  var GH = ${JSON.stringify(gameHost)};
  var GBP = ${JSON.stringify(gameBasePath)};

  function rw(u) {
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return u;
    ${blockPoki}
    ${blockMini}
    ${blockCrazy}
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

  console.log("[game-dl] interceptor active", "hosts:", KH.length);
})();`;
}

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
    try {
      hosts.add(new URL(file.sourceUrl).host);
    } catch {}
  }
  if (activeSession.platform === "minigame") {
    hosts.add("sdk.minigame.vip");
    hosts.add("apps.minigame.vip");
  }
  if (activeSession.platform === "crazygames") {
    hosts.add("sdk.crazygames.com");
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
      if (!html.includes(originSlash) && !html.includes(origin.replace(/\//g, "\\/"))) continue;

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
  if (all.includes("dmloader") || all.includes(".arcd") || all.includes(".dmanifest")) return "defold";
  if (all.includes("c3runtime") || all.includes("c2runtime")) return "construct";
  if (all.includes(".pck") || all.includes("/godot")) return "godot";
  if (all.includes("html5game/")) return "gamemaker";
  if (all.includes("cocos2d") || all.includes("cocos-js") || all.includes("cc.game")) return "cocos";
  if (all.includes("phaser")) return "phaser";
  if (all.includes("pixi")) return "pixi";
  if (all.includes("playcanvas")) return "playcanvas";
  if (all.includes("createjs") || all.includes("easeljs")) return "createjs";
  return "unknown";
}

function urlToLocalPath(urlString) {
  const url = new URL(urlString);
  const platform = activeSession?.platform || "crazygames";

  if (platform === "poki") {
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

  if (isUnderGameBase(urlString)) {
    let pathname = url.pathname;
    if (activeSession?.gameBaseUrl) {
      try {
        const baseU = new URL(activeSession.gameBaseUrl);
        if (url.host === baseU.host && pathname.startsWith(baseU.pathname)) {
          pathname = pathname.slice(baseU.pathname.length);
        }
      } catch {}
    }
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map((s) => sanitizeName(s));
    let filePath = segments.join("/") || "index";
    if (platform === "minigame" && url.search) {
      const h = simpleHash(url.search).slice(0, 8);
      filePath = appendSuffix(filePath, `__q${h}`);
    }
    return filePath;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const baseName = segments.length ? sanitizeName(segments[segments.length - 1]) : "file";
  let rootName = baseName || "file";
  if (!extractExtFromUrl(urlString) && url.search) {
    rootName = `${rootName}__q${simpleHash(url.search).slice(0, 8)}`;
  } else if (url.search) {
    rootName = appendSuffix(rootName, `__q${simpleHash(url.search).slice(0, 8)}`);
  }
  return rootName;
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

function isTrackerUrl(url) {
  const lower = url.toLowerCase();
  return TRACKER_KEYWORDS.some((kw) => lower.includes(kw));
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

function extensionForCdpType(cdpType) {
  switch (cdpType) {
    case "Script":
      return ".js";
    case "Stylesheet":
      return ".css";
    case "Document":
      return ".html";
    case "Image":
      return ".png";
    case "Media":
      return ".mp4";
    case "Font":
      return ".woff2";
    default:
      return "";
  }
}

function mimeForCdpSave(cdpType, ext, isBinary) {
  if (isBinary) return "application/octet-stream";
  switch (cdpType) {
    case "Script":
      return "application/javascript";
    case "Stylesheet":
      return "text/css";
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
      if (ext === ".wasm") return "application/wasm";
      return "application/octet-stream";
  }
}

async function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, ...DOWNLOAD_OPTS },
      (downloadId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
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
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
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
    await updateBadgeCount();
  }

  return { localPath, filename };
}

async function downloadManualResources(tabId, urls) {
  const list = Array.isArray(urls) ? urls.filter((u) => u && String(u).startsWith("http")) : [];
  if (list.length === 0) return { ok: true, downloaded: 0 };

  let folder;
  if (activeSession && activeSession.tabId === tabId) {
    folder = activeSession.folder;
  } else {
    const stored = await chrome.storage.local.get("lastGameInfo");
    if (!stored.lastGameInfo?.folder) throw new Error("无游戏目录，请先开始监听。");
    folder = stored.lastGameInfo.folder;
  }

  let downloaded = 0;
  for (const url of list) {
    if (!activeSession) break;
    const localPath = urlToLocalPath(url);
    if (activeSession.downloadedLocalPaths.has(localPath)) {
      activeSession.seenUrls.add(url);
      continue;
    }
    try {
      await downloadUrl(url, `${folder}/${localPath}`);
      downloaded += 1;
      activeSession.downloadedLocalPaths.add(localPath);
      activeSession.seenUrls.add(url);
      activeSession.stats.downloaded += 1;
      upsertFile({ type: "asset", sourceUrl: url, localPath, status: "ok", requestType: "manual" });
      schedulePersist();
      scheduleManifest();
      updateBadgeCount();
    } catch (err) {
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
  return { ok: true, downloaded, total: list.length };
}

async function exportConfigJson(config, folder) {
  if (!folder) {
    const stored = await chrome.storage.local.get("lastGameInfo");
    folder = stored.lastGameInfo?.folder;
  }
  if (!folder) throw new Error("无游戏目录，请先开始监听。");

  const json = JSON.stringify(config, null, 2);
  const filename = `${folder}/game-download-config.json`;
  await downloadText(filename, json, "application/json");
  return { ok: true, filename };
}

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
    platform: activeSession.platform,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    downloadDir: activeSession.downloadDir,
    gameUrl: activeSession.gameUrl,
    gameHost: activeSession.gameHost,
    gameBaseUrl: activeSession.gameBaseUrl,
    listenPrefixes: activeSession.listenPrefixes,
    startedAt: activeSession.startedAt,
    status: activeSession.status,
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
    }

    await chrome.action.setBadgeBackgroundColor({
      tabId: activeSession.tabId,
      color: "#7c3aed"
    });
    await updateBadgeCount();
  } catch {
    activeSession = null;
  }
}

async function writeManifest() {
  if (!activeSession) return;
  const payload = {
    platform: activeSession.platform,
    gameName: activeSession.gameName,
    gameUrl: activeSession.gameUrl || "",
    listenPrefixes: activeSession.listenPrefixes,
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
