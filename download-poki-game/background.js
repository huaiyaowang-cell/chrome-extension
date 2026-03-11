const OUTPUT_PREFIX = "downloaded-games";

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

      void processRequest(url, details.type);
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

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
    if (type !== "Document") return;
    const url = response.url || "";
    if (url && url.startsWith("http")) {
      pendingNetworkCaptures.set(requestId, { url });
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

    const body = result.base64Encoded ? decodeBase64Body(result.body) : result.body;
    if (!body || body.length < 50) return;

    if (networkHtmlCache.size > 100) {
      const oldest = networkHtmlCache.keys().next().value;
      networkHtmlCache.delete(oldest);
    }

    networkHtmlCache.set(info.url, body);
    const baseUrl = info.url.split("?")[0];
    if (baseUrl !== info.url) networkHtmlCache.set(baseUrl, body);
    console.log(`[poki-dl] HTML cached: ${info.url.slice(0, 100)} (${body.length} bytes, total=${networkHtmlCache.size})`);
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

async function processRequest(url, requestType) {
  if (!activeSession?.gameHost) return;
  const host = safeHost(url);
  if (host !== activeSession.gameHost) return;
  if (activeSession.seenUrls.has(url)) return;
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

async function startMonitor(tabId) {
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
    stats: { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 },
    files: [],
    htmlCaptured: false
  };

  requestBuffer = [];
  networkHtmlCache.clear();

  const dbgOk = await attachDebugger(tabId);
  startGameframeDetection(tabId);

  await persistSession();
  await chrome.storage.local.set({ lastGameInfo: { gameName, folder } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

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

async function generateIndexHtml(rawHtml, gameUrl) {
  const gameBaseUrl = getBaseUrl(gameUrl);
  const urlMap = buildUrlToLocalMap();

  let html = rawHtml;
  html = rewriteAllUrls(html, urlMap);
  html = rewriteRemainingAbsoluteUrls(html, gameBaseUrl);
  html = neutralizePokiSdk(html);
  html = removeDynamicLoaderContent(html, detectGameEngine());

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
      el = document.createElement("div");
      el.id = id;
      el.style.display = "none";
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

  if (pathname === url.pathname && activeSession?.gameHost === url.host) {
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length >= 2) {
      pathname = "/" + segs.slice(1).join("/");
    }
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => sanitizeName(s));
  let filePath = segments.join("/") || "index";
  if (url.search) {
    const h = simpleHash(url.search).slice(0, 8);
    filePath = appendSuffix(filePath, `__q${h}`);
  }
  return filePath;
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

function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    const dotIdx = lastSegment.lastIndexOf(".");
    if (dotIdx > 0) return lastSegment.slice(dotIdx).toLowerCase();
  } catch {}
  return "";
}

/* ── Download helpers ──────────────────────────────────────── */

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
