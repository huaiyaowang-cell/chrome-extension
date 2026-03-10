const OUTPUT_PREFIX = "downloaded-games";

const GAME_DOMAIN_SUFFIXES = [
  ".gdn.poki.com",
  ".poki-gdn.com",
  ".poki-cdn.com"
];
const GAME_DOMAIN_EXACT = [
  "games.poki.com",
  "game-cdn.poki.com",
  "img.poki-cdn.com",
  "a.poki-cdn.com"
];
const TRACKER_KEYWORDS = [
  "google-analytics", "googletagmanager", "doubleclick",
  "googlesyndication", "adservice.", "sentry.io",
  "hotjar", "intercom", "facebook.net",
  "mixpanel", "segment.io", "amplitude",
  "statsig", "branch.io", "adjust.com"
];
const GAME_EXTENSIONS = new Set([
  "js", "mjs", "css", "json", "wasm",
  "data", "unityweb", "bundle", "mem", "bin", "pck", "arcd", "dmanifest", "projectc",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif",
  "mp3", "ogg", "wav", "m4a", "aac", "webm", "mp4", "flac",
  "woff", "woff2", "ttf", "otf", "eot",
  "xml", "atlas", "fnt", "txt", "csv", "tsv", "tmx", "tsx",
  "glb", "gltf", "fbx", "obj",
  "spine", "skel", "ase", "aseprite",
  "map", "ldtk", "tiled"
]);

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
      .then(() => startMonitor(message.tabId))
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
    sessionReady.then(() => {
      sendResponse({ ok: true, ...getMonitorStatus(message.tabId) });
    });
    return true;
  }
  if (message?.type === "CAPTURE_HTML") {
    sessionReady
      .then(() => manualCaptureHtml(message.tabId))
      .then((r) => sendResponse({ ok: true, ...r }))
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
      void handleRequest(details);
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

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
    if (type !== "Document") return;
    const url = response.url || "";
    if (url && url.startsWith("http")) {
      pendingNetworkCaptures.set(requestId, { url });
      console.log(`[poki-dl] responseReceived: Document → ${url.slice(0, 120)}`);
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
        console.log("[poki-dl] debugger attached, Network.enable sent");
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

    const body = result.base64Encoded ? decodeBase64Body(result.body) : result.body;
    if (!body || body.length < 50) return;

    if (networkHtmlCache.size > 100) {
      const oldest = networkHtmlCache.keys().next().value;
      networkHtmlCache.delete(oldest);
    }

    networkHtmlCache.set(info.url, body);
    const baseUrl = info.url.split("?")[0];
    if (baseUrl !== info.url) {
      networkHtmlCache.set(baseUrl, body);
    }
    console.log(`[poki-dl] network HTML cached: ${info.url.slice(0, 120)} (${body.length} bytes, total=${networkHtmlCache.size})`);
  } catch (e) {
    console.warn("[poki-dl] getResponseBody failed:", e.message);
  }
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

async function resolveFrameUrls(tabId) {
  const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!allFrames || allFrames.length === 0) return { gameUrl: null, indexUrl: null };

  let gameUrl = null;
  let indexUrl = null;

  for (const frame of allFrames) {
    const url = frame.url || "";
    const host = safeHost(url);

    if (!gameUrl && GAME_DOMAIN_SUFFIXES.some((s) => host.endsWith(s))) {
      gameUrl = url;
    }

    if (!indexUrl && frame.parentFrameId === 0 && frame.frameId !== 0 && host !== "" &&
        (host === "games.poki.com" || host.endsWith(".poki.com")) && !url.includes("/g/")) {
      indexUrl = url;
    }
  }

  if (!indexUrl) {
    for (const frame of allFrames) {
      if (frame.parentFrameId === 0 && frame.frameId !== 0 && frame.url) {
        indexUrl = frame.url;
        break;
      }
    }
  }

  return { gameUrl, indexUrl };
}

async function startMonitor(tabId) {
  const pageInfo = await getPageInfoFromTab(tabId);
  if (!pageInfo?.pageUrl) {
    throw new Error("无法读取页面信息。");
  }

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
    seenUrls: new Set(),
    pending: new Set(),
    stats: { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 },
    files: [],
    htmlCaptured: { index: false, game: false }
  };

  networkHtmlCache.clear();
  const dbgOk = await attachDebugger(tabId);
  if (!dbgOk) {
    console.warn("[poki-dl] debugger not available — cannot capture network HTML");
  }

  await persistSession();
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

  return { gameName, folder, status: "listening", debugger: dbgOk };
}

async function manualCaptureHtml(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    throw new Error("当前没有监听会话。");
  }

  const { gameUrl, indexUrl } = await resolveFrameUrls(tabId);
  console.log(`[poki-dl] resolveFrameUrls: gameUrl=${gameUrl?.slice(0, 100) || "null"}, indexUrl=${indexUrl?.slice(0, 100) || "null"}`);

  const captured = [];
  const errors = [];

  if (gameUrl) {
    const rawHtml = findInNetworkCache(gameUrl);
    if (rawHtml) {
      await generateAndSaveGameHtml(rawHtml, gameUrl);
      activeSession.htmlCaptured.game = true;
      activeSession.htmlCaptured.gameUrl = gameUrl;
      activeSession.stats.downloaded += 1;
      captured.push("game.html");
    } else {
      errors.push(`game.html: 未检测到 ${gameUrl.slice(0, 80)} 的网络缓存`);
    }
  } else {
    errors.push("game.html: 未发现游戏 iframe");
  }

  if (indexUrl) {
    const rawHtml = findInNetworkCache(indexUrl);
    if (rawHtml) {
      await generateAndSaveIndexHtml(rawHtml, indexUrl, gameUrl);
      activeSession.htmlCaptured.index = true;
      activeSession.htmlCaptured.indexUrl = indexUrl;
      activeSession.stats.downloaded += 1;
      captured.push("index.html");
    } else {
      errors.push(`index.html: 未检测到 ${indexUrl.slice(0, 80)} 的网络缓存`);
    }
  } else {
    errors.push("index.html: 未发现 index iframe");
  }

  await persistSession();

  if (captured.length === 0) {
    const detail = errors.join("\n");
    throw new Error(`未能抓取 HTML (网络缓存中有 ${networkHtmlCache.size} 条记录)\n${detail}`);
  }

  return {
    captured,
    errors: errors.length > 0 ? errors : undefined,
    message: captured.length > 0
      ? `已抓取: ${captured.join(", ")}` + (errors.length > 0 ? `\n警告: ${errors.join("; ")}` : "")
      : errors.join("; ")
  };
}

async function generateAndSaveGameHtml(rawHtml, gameUrl) {
  const engine = detectGameEngine();
  const gameFrameBaseUrl = getBaseUrl(gameUrl);
  const specialMap = buildSpecialUrlMap(gameUrl);
  const urlMap = buildUrlToLocalMap();

  let html = rawHtml;
  html = rewriteAllUrls(html, urlMap);
  html = rewriteRemainingAbsoluteUrls(html, gameFrameBaseUrl);
  html = neutralizePokiSdk(html);
  html = removeDynamicLoaderContent(html, engine);
  html = injectInterceptor(html, gameFrameBaseUrl, specialMap);

  await downloadText(`${activeSession.folder}/game.html`, html, "text/html;charset=utf-8");
  upsertFile({ type: "entry-html", sourceUrl: gameUrl, localPath: "game.html", status: "ok" });
  console.log("[poki-dl] game.html generated from network cache");
}

async function generateAndSaveIndexHtml(rawHtml, indexUrl, gameUrl) {
  const specialMap = buildSpecialUrlMap(gameUrl);
  const urlMap = buildUrlToLocalMap();

  let html = rawHtml;
  if (gameUrl) {
    html = rewriteGameframeSrc(html, gameUrl, "./game.html");
  }
  html = rewriteAllUrls(html, urlMap);
  html = rewriteRemainingAbsoluteUrls(html, "");
  html = neutralizePokiSdk(html);
  html = injectInterceptor(html, "", specialMap);

  await downloadText(`${activeSession.folder}/index.html`, html, "text/html;charset=utf-8");
  upsertFile({ type: "entry-html", sourceUrl: indexUrl, localPath: "index.html", status: "ok" });
  console.log("[poki-dl] index.html generated from network cache");
}

async function stopMonitor(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle", debug: "no active session for this tab" };
  }

  const errors = [];

  if (!activeSession.htmlCaptured.game || !activeSession.htmlCaptured.index) {
    try {
      await manualCaptureHtml(tabId);
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
  if (errors.length > 0) {
    result.warnings = errors;
  }

  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch { /* badge might fail if tab closed */ }

  activeSession = null;
  await chrome.storage.local.remove("activeSession");

  return result;
}

function getMonitorStatus(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle" };
  }
  return buildStatusPayload();
}

async function handleRequest(details) {
  activeSession.stats.totalSeen += 1;

  const url = details.url;
  if (!url.startsWith("http")) return;
  if (activeSession.seenUrls.has(url)) return;

  if (details.type === "sub_frame") {
    const host = safeHost(url);

    if (!activeSession.htmlCaptured.gameUrl && GAME_DOMAIN_SUFFIXES.some((s) => host.endsWith(s))) {
      activeSession.htmlCaptured.gameUrl = url;
    }

    if (!activeSession.htmlCaptured.indexUrl && host !== "" && (host === "games.poki.com" || host.endsWith(".poki.com")) && !url.includes("/g/")) {
      activeSession.htmlCaptured.indexUrl = url;
    }

    return;
  }

  if (details.type === "main_frame") {
    return;
  }

  if (isTrackerUrl(url)) {
    activeSession.stats.skipped += 1;
    return;
  }

  if (!isGameRelated(url, details)) {
    activeSession.stats.skipped += 1;
    return;
  }

  activeSession.seenUrls.add(url);

  if (activeSession.pending.has(url)) return;
  activeSession.pending.add(url);

  const localPath = urlToLocalPath(url);
  try {
    await downloadUrl(url, `${activeSession.folder}/${localPath}`);
    activeSession.stats.downloaded += 1;
    activeSession.files.push({
      type: "asset",
      sourceUrl: url,
      localPath,
      status: "ok",
      requestType: details.type
    });
    await updateBadgeCount();
  } catch (error) {
    activeSession.stats.failed += 1;
    activeSession.files.push({
      type: "asset",
      sourceUrl: url,
      localPath,
      status: "failed",
      requestType: details.type,
      error: String(error?.message || error)
    });
  } finally {
    activeSession.pending.delete(url);
    schedulePersist();
    scheduleManifest();
  }
}

function isGameRelated(url, details) {
  if (isGameDomain(url)) return true;

  const pathname = safePathname(url).toLowerCase();

  if (pathname.includes("/build/") || pathname.includes("/release/") || pathname.includes("/templatedata/")) {
    return true;
  }

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("poki-sdk") || lowerUrl.includes("master-loader") || lowerUrl.includes("unity-2020") || lowerUrl.includes("unity-loader") || lowerUrl.includes("/loaders/")) {
    return true;
  }

  if (["script", "stylesheet"].includes(details.type)) {
    if (isGameDomainInitiator(details)) return true;
  }

  const ext = getCoreExtension(pathname);
  if (GAME_EXTENSIONS.has(ext)) {
    if (isGameDomainInitiator(details)) return true;
    if (details.type === "xmlhttprequest" || details.type === "fetch" || details.type === "other") return true;
  }

  return false;
}

function isGameDomain(url) {
  try {
    const host = new URL(url).host;
    if (GAME_DOMAIN_EXACT.includes(host)) return true;
    return GAME_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function isGameDomainInitiator(details) {
  const initiator = details.initiator || details.documentUrl || "";
  if (!initiator) return false;
  return isGameDomain(initiator);
}

function isTrackerUrl(url) {
  const lower = url.toLowerCase();
  return TRACKER_KEYWORDS.some((kw) => lower.includes(kw));
}

function getCoreExtension(pathname) {
  const lastSegment = pathname.split("/").pop() || "";
  const stripped = lastSegment
    .replace(/\.br$/i, "")
    .replace(/\.gz$/i, "");
  const dotIndex = stripped.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return stripped.slice(dotIndex + 1).toLowerCase();
}

function rewriteGameframeSrc(html, gameFrameUrl, localPath) {
  const escaped = gameFrameUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let result = html.replace(new RegExp(escaped, "g"), localPath);

  const urlNoParams = gameFrameUrl.split("?")[0];
  if (urlNoParams !== gameFrameUrl) {
    const escapedBase = urlNoParams.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`(<iframe[^>]*\\bid\\s*=\\s*["']gameframe["'][^>]*\\bsrc\\s*=\\s*["'])${escapedBase}[^"']*["']`, "i"),
      `$1${localPath}"`
    );
  }

  result = result.replace(
    /(<iframe[^>]*\bid\s*=\s*["']gameframe["'][^>]*\bsrc\s*=\s*["'])https?:\/\/[^"']+?(["'])/i,
    `$1${localPath}$2`
  );

  return result;
}

function getBaseUrl(url) {
  if (!url) return "";
  const noQuery = url.split("?")[0];
  const lastSlash = noQuery.lastIndexOf("/");
  return lastSlash >= 0 ? noQuery.slice(0, lastSlash + 1) : noQuery + "/";
}

function detectGameEngine() {
  if (!activeSession) return "unknown";
  const paths = activeSession.files.map(f => (f.localPath || "").toLowerCase());
  const urls = activeSession.files.map(f => (f.sourceUrl || "").toLowerCase());
  const all = paths.concat(urls).join("\n");

  if ((all.includes("/build/") || all.includes("\\build\\")) &&
      (all.includes(".loader.js") || all.includes(".framework.js") || all.includes(".wasm"))) {
    return "unity";
  }
  if (all.includes("dmloader") || all.includes(".arcd") || all.includes(".dmanifest")) return "defold";
  if (all.includes("c3runtime") || all.includes("c2runtime")) return "construct";
  if (all.includes(".pck") || all.includes("/godot")) return "godot";
  if (all.includes("html5game/")) return "gamemaker";
  if (all.includes("phaser")) return "phaser";
  if (all.includes("pixi")) return "pixi";
  if (all.includes("playcanvas")) return "playcanvas";
  if (all.includes("createjs") || all.includes("easeljs")) return "createjs";
  return "unknown";
}

function getStaleElementIds(engine) {
  const BASE = ["loader", "game-container", "spinner", "loading"];
  const ENGINE_IDS = {
    unity: ["loader", "game-container", "spinner", "slideshow",
            "progress-container", "progress-bar", "unity-container",
            "unity-canvas", "unity-loading-bar", "unity-progress-bar-full"],
    defold: ["loading-screen-container", "running-from-file-warning"],
    construct: ["loading", "loader"],
    godot: ["status", "status-progress", "status-notice"],
    gamemaker: ["loader"],
    phaser: [],
    pixi: [],
    playcanvas: ["application-splash-wrapper", "progress-bar", "progress"],
    createjs: ["loader"]
  };
  const ids = new Set(BASE);
  for (const id of (ENGINE_IDS[engine] || [])) ids.add(id);
  return Array.from(ids);
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

function rewriteRemainingAbsoluteUrls(html, gameFrameBaseUrl) {
  if (!activeSession) return html;
  const hosts = new Set();
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl) continue;
    try { hosts.add(new URL(file.sourceUrl).host); } catch {}
  }
  for (const d of GAME_DOMAIN_EXACT) hosts.add(d);

  let gameBasePathname = "";
  let gameHost = "";
  if (gameFrameBaseUrl) {
    try {
      const u = new URL(gameFrameBaseUrl);
      gameHost = u.host;
      gameBasePathname = u.pathname;
    } catch {}
  }

  for (const host of hosts) {
    for (const proto of ["https://", "http://"]) {
      const origin = proto + host;
      const originSlash = origin + "/";
      if (!html.includes(originSlash) && !html.includes(origin.replace(/\//g, "\\/"))) continue;

      const basePath = (host === gameHost) ? gameBasePathname : "/";

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

function buildSpecialUrlMap(gameFrameUrl) {
  const map = {};
  if (!gameFrameUrl) return map;
  try {
    const url = new URL(gameFrameUrl.split("?")[0]);
    map[url.host + url.pathname] = "./game.html";
  } catch {}
  return map;
}

function buildInterceptorScript(gameFrameBaseUrl, specialMap) {
  const knownHosts = new Set(GAME_DOMAIN_EXACT);
  if (activeSession) {
    for (const f of activeSession.files) {
      if (f.status === "ok" && f.sourceUrl) {
        try { knownHosts.add(new URL(f.sourceUrl).host); } catch {}
      }
    }
  }

  let gameHost = "", gameBasePath = "/";
  if (gameFrameBaseUrl) {
    try {
      const u = new URL(gameFrameBaseUrl);
      gameHost = u.host;
      gameBasePath = u.pathname;
    } catch {}
  }

  const sdkStub = `
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
  `;

  const domSafety = `
    var _origGBI = Document.prototype.getElementById;
    Document.prototype.getElementById = function(id) {
      var el = _origGBI.call(this, id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.style.display = "none";
        el.dataset.pokiPlaceholder = "1";
        if (document.body) document.body.appendChild(el);
      }
      return el;
    };
  `;

  const onerrorSafety = `
    (function() {
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
    })();
  `;

  return `<script>(function(){` +
    onerrorSafety +
    sdkStub +
    domSafety +
    `var KH=${JSON.stringify(Array.from(knownHosts))};` +
    `var GH=${JSON.stringify(gameHost)};` +
    `var GBP=${JSON.stringify(gameBasePath)};` +
    `var S=${JSON.stringify(specialMap || {})};` +
    `var PD=location.pathname.substring(0,location.pathname.lastIndexOf("/")+1);` +
    `function rw(u){` +
      `if(!u||u.startsWith("data:")||u.startsWith("blob:"))return u;` +
      `if(u.includes("poki-sdk-core")||u.includes("poki-sdk-hoist"))` +
        `return"data:text/javascript,console.log('[poki-dl] sdk blocked')";` +
      `try{var o=new URL(u,location.href);` +
        `if(o.protocol!=="http:"&&o.protocol!=="https:")return u;` +
        `if(o.host!==location.host){` +
          `var sk=o.host+o.pathname;if(S[sk])return S[sk];` +
          `if(KH.indexOf(o.host)>=0){` +
            `var p=o.pathname;` +
            `if(o.host===GH&&p.startsWith(GBP))p=p.substring(GBP.length);` +
            `else if(p.startsWith("/"))p=p.substring(1);` +
            `return"./"+p;}}` +
      `}catch(e){}return u;}` +
    `var F=window.fetch;` +
    `window.fetch=function(i,o){` +
      `if(typeof i==="string")i=rw(i);` +
      `else if(i&&i.url){var n=rw(i.url);if(n!==i.url)i=new Request(n,i);}` +
      `return F.call(this,i,o);};` +
    `var X=XMLHttpRequest.prototype.open;` +
    `XMLHttpRequest.prototype.open=function(){` +
      `var a=[].slice.call(arguments);` +
      `if(typeof a[1]==="string")a[1]=rw(a[1]);` +
      `return X.apply(this,a);};` +
    `var SA=Element.prototype.setAttribute;` +
    `Element.prototype.setAttribute=function(n,v){` +
      `if((n==="src"||n==="href")&&typeof v==="string")v=rw(v);` +
      `return SA.call(this,n,v);};` +
    `function patchSrc(P){try{var d=Object.getOwnPropertyDescriptor(P,"src");` +
      `if(d&&d.set)Object.defineProperty(P,"src",{` +
        `set:function(v){d.set.call(this,rw(v));},get:d.get,configurable:true});}catch(e){}}` +
    `patchSrc(HTMLScriptElement.prototype);` +
    `patchSrc(HTMLImageElement.prototype);` +
    `patchSrc(HTMLIFrameElement.prototype);` +
    `patchSrc(HTMLSourceElement.prototype);` +
    `patchSrc(HTMLMediaElement.prototype);` +
    `function rwCss(s){return s.replace(/url\\(\\s*(["']?)([^"')]+?)\\1\\s*\\)/gi,` +
      `function(m,q,p){return"url("+q+rw(p)+q+")";});}` +
    `if(window.FontFace){var OF=window.FontFace;` +
      `window.FontFace=function(f,s,d){` +
        `if(typeof s==="string")s=rwCss(s);` +
        `return new OF(f,s,d);};` +
      `window.FontFace.prototype=OF.prototype;}` +
    `try{var IR=CSSStyleSheet.prototype.insertRule;` +
      `CSSStyleSheet.prototype.insertRule=function(r,i){` +
        `return IR.call(this,rwCss(r),i);};}catch(e){}` +
    `try{var dI=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");` +
      `if(dI&&dI.set)Object.defineProperty(Element.prototype,"innerHTML",{` +
        `set:function(v){if(this.tagName==="STYLE"&&typeof v==="string")v=rwCss(v);` +
          `dI.set.call(this,v);},get:dI.get,configurable:true});}catch(e){}` +
    `try{var dT=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");` +
      `if(dT&&dT.set){var origTC=dT.set;Object.defineProperty(Node.prototype,"textContent",{` +
        `set:function(v){if(this.tagName==="STYLE"&&typeof v==="string")v=rwCss(v);` +
          `origTC.call(this,v);},get:dT.get,configurable:true});}}catch(e){}` +
    `console.log("[poki-dl] interceptor active, knownHosts:",KH.length,"gameHost:",GH);` +
  `})();</script>`;
}

function neutralizePokiSdk(html) {
  html = html
    .replace(/<script[^>]*src="[^"]*poki-sdk-hoist[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*src="[^"]*\/poki-sdk\.js"[^>]*><\/script>/gi, "");

  html = stripPokiAdapterScript(html);
  return html;
}

function stripPokiAdapterScript(html) {
  const re = /<script>(?=[\s\S]{5000})([\s\S]*?)<\/script>/gi;
  return html.replace(re, (match, content) => {
    if (content.includes("_createForOfIteratorHelper") ||
        content.includes("PokiSDK") ||
        content.includes("poki-sdk") ||
        content.includes("commercialBreak") ||
        content.includes("rewardedBreak")) {
      return "<!-- poki-adapter removed -->";
    }
    return match;
  });
}

function removeDynamicLoaderContent(html, engine) {
  html = html.replace(/<script[^>]*src="[^"]*loaders\/v\d+\/(?!master-loader)[^"]*"[^>]*><\/script>/gi, "");
  html = html.replace(/<!--\s*will\s+(be\s+copied|also\s+be\s+copied)\s+to\s+the\s+resulting\s+body\s*\/?\/?-->/gi, "");

  if (engine === "construct") {
    html = html.replace(/<script[^>]*src="[^"]*sw\.js"[^>]*><\/script>/gi, "");
  }

  if (engine === "godot") {
    html = html.replace(/<script[^>]*src="[^"]*godot\.tools\.js"[^>]*><\/script>/gi, "");
  }

  return html;
}

function removeStaleGameDom(html, staleIds) {
  for (const id of staleIds) {
    let safety = 20;
    while (safety-- > 0) {
      const next = stripFirstDivById(html, id);
      if (next === html) break;
      html = next;
    }
  }
  return html;
}

function isInsideScriptBlock(html, pos) {
  const before = html.slice(0, pos);
  const lastOpen = before.lastIndexOf("<script");
  if (lastOpen < 0) return false;
  const lastClose = before.lastIndexOf("</script");
  return lastOpen > lastClose;
}

function stripFirstDivById(html, id) {
  const marker = new RegExp(`<div\\b[^>]*\\bid\\s*=\\s*["']${id}["']`, "ig");
  let match;
  while ((match = marker.exec(html)) !== null) {
    if (isInsideScriptBlock(html, match.index)) continue;

    const start = match.index;
    let depth = 0;
    let i = start;

    while (i < html.length) {
      if (html[i] !== "<") { i++; continue; }
      const chunk = html.slice(i, i + 6).toLowerCase();
      if (chunk.startsWith("<div")) {
        depth++;
        i = html.indexOf(">", i);
        if (i < 0) return html;
        i++;
      } else if (chunk.startsWith("</div")) {
        depth--;
        const end = html.indexOf(">", i);
        if (end < 0) return html;
        if (depth === 0) return html.slice(0, start) + html.slice(end + 1);
        i = end + 1;
      } else {
        i++;
      }
    }
  }
  return html;
}

function injectInterceptor(html, gameFrameBaseUrl, specialMap) {
  const script = buildInterceptorScript(gameFrameBaseUrl, specialMap);
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], headMatch[0] + script);
  }
  return script + html;
}

async function getPageInfoFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pathMatch = window.location.pathname.match(/\/g\/([^/?#]+)/);
      return {
        pageUrl: window.location.href,
        gameName: pathMatch ? decodeURIComponent(pathMatch[1]) : document.title || "poki-game"
      };
    }
  });
  return results?.[0]?.result || null;
}

function urlToLocalPath(urlString) {
  const url = new URL(urlString);
  let pathname = url.pathname;

  if (activeSession?.htmlCaptured?.gameUrl) {
    try {
      const gameBase = getBaseUrl(activeSession.htmlCaptured.gameUrl);
      const gameU = new URL(gameBase);
      if (url.host === gameU.host && pathname.startsWith(gameU.pathname)) {
        pathname = pathname.slice(gameU.pathname.length);
      }
    } catch {}
  }

  const segments = pathname.split("/").filter(Boolean).map((s) => sanitizeName(s));
  let filePath = segments.join("/") || "index";
  if (url.search) {
    const h = simpleHash(url.search).slice(0, 8);
    filePath = appendSuffix(filePath, `__q${h}`);
  }
  return filePath;
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
  try { return new URL(urlString).pathname; } catch { return ""; }
}

function safeHost(urlString) {
  try { return new URL(urlString).host; } catch { return ""; }
}

async function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "overwrite", saveAs: false },
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
      { url: dataUrl, filename, conflictAction: "overwrite", saveAs: false },
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

function buildStatusPayload() {
  if (!activeSession) return { status: "idle" };
  return {
    status: activeSession.status,
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    stats: activeSession.stats,
    fileCount: activeSession.files.length,
    htmlStatus: {
      gameHtml: activeSession.htmlCaptured.game,
      indexHtml: activeSession.htmlCaptured.index,
      networkCacheSize: networkHtmlCache.size,
      debuggerAttached
    }
  };
}

async function updateBadgeCount() {
  if (!activeSession) return;
  const count = activeSession.stats.downloaded;
  const text = count > 999 ? "999+" : String(count);
  await chrome.action.setBadgeText({ tabId: activeSession.tabId, text });
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
    gameName: activeSession.gameName,
    folder: activeSession.folder,
    pageUrl: activeSession.pageUrl,
    startedAt: activeSession.startedAt,
    status: activeSession.status,
    stats: activeSession.stats,
    seenUrlsList: Array.from(activeSession.seenUrls),
    files: activeSession.files,
    htmlCaptured: activeSession.htmlCaptured
  };
  await chrome.storage.local.set({ activeSession: serializable });
}

async function restoreSession() {
  try {
    const stored = await chrome.storage.local.get("activeSession");
    const saved = stored.activeSession;
    if (!saved || saved.status !== "listening") return;

    activeSession = {
      ...saved,
      seenUrls: new Set(saved.seenUrlsList || []),
      pending: new Set()
    };
    delete activeSession.seenUrlsList;

    if (activeSession.tabId) {
      void attachDebugger(activeSession.tabId);
    }

    await chrome.action.setBadgeBackgroundColor({ tabId: activeSession.tabId, color: "#2563eb" });
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
