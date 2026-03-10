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
  "data", "unityweb", "bundle", "mem", "bin", "pck",
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

chrome.webNavigation.onCompleted.addListener((details) => {
  void sessionReady.then(() => {
    if (!activeSession || details.tabId !== activeSession.tabId) return;
    if (activeSession.status !== "listening") return;
    void captureFrameHtml();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSession?.tabId === tabId) {
    activeSession = null;
    chrome.storage.local.remove("activeSession");
  }
});

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

  await persistSession();
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });

  return { gameName, folder, status: "listening" };
}

async function manualCaptureHtml(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    throw new Error("当前没有监听会话。");
  }

  activeSession.htmlCaptured.index = false;
  activeSession.htmlCaptured.game = false;

  await captureFrameHtml();

  const captured = [];
  if (activeSession.htmlCaptured.index) captured.push("index.html");
  if (activeSession.htmlCaptured.game) captured.push("game.html");

  if (captured.length === 0) {
    throw new Error("未能抓取到任何 HTML，请确认游戏已完全加载。");
  }

  await persistSession();
  return {
    captured,
    message: `已抓取: ${captured.join(", ")}`
  };
}

async function stopMonitor(tabId) {
  if (!activeSession || activeSession.tabId !== tabId) {
    return { status: "idle", debug: "no active session for this tab" };
  }

  const errors = [];

  try {
    await captureFrameHtml();
  } catch (e) {
    errors.push(`captureFrameHtml: ${e.message}`);
  }

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

    scheduleCaptureFrameHtml();
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

let captureFrameTimer = null;
function scheduleCaptureFrameHtml() {
  clearTimeout(captureFrameTimer);
  captureFrameTimer = setTimeout(() => {
    captureFrameTimer = null;
    void captureFrameHtml();
  }, 3000);
}

async function captureFrameHtml() {
  if (!activeSession) return;
  if (activeSession.htmlCaptured.index && activeSession.htmlCaptured.game) return;

  try {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId: activeSession.tabId });
    if (!allFrames || allFrames.length === 0) return;

    let gameElementFrameId = -1;
    let gameElementUrl = "";
    let gameFrameFrameId = -1;
    let gameFrameUrl = activeSession.htmlCaptured.gameUrl || "";

    for (const frame of allFrames) {
      const url = frame.url || "";
      const host = safeHost(url);

      if (frame.parentFrameId === 0 && frame.frameId !== 0 && host !== "" &&
          (host === "games.poki.com" || host.endsWith(".poki.com")) && !url.includes("/g/")) {
        gameElementFrameId = frame.frameId;
        gameElementUrl = url;
      }

      if (GAME_DOMAIN_SUFFIXES.some((s) => host.endsWith(s))) {
        gameFrameFrameId = frame.frameId;
        if (!gameFrameUrl) gameFrameUrl = url;
      }
    }

    if (gameElementFrameId < 0) {
      for (const frame of allFrames) {
        if (frame.parentFrameId === 0 && frame.frameId !== 0) {
          gameElementFrameId = frame.frameId;
          gameElementUrl = frame.url;
          break;
        }
      }
    }

    if (gameFrameFrameId < 0 && gameElementFrameId >= 0) {
      for (const frame of allFrames) {
        if (frame.parentFrameId === gameElementFrameId && frame.frameId !== gameElementFrameId) {
          gameFrameFrameId = frame.frameId;
          if (!gameFrameUrl) gameFrameUrl = frame.url;
          break;
        }
      }
    }

    const engine = detectGameEngine();
    const hostMap = buildHostMap();
    const gameFrameBaseUrl = getBaseUrl(gameFrameUrl);
    const gameRelativeMap = buildRelativeMap(gameFrameBaseUrl);
    const specialMap = buildSpecialUrlMap(gameFrameUrl);
    const relPrefixes = extractRelativePrefixes(gameFrameBaseUrl);
    const staleIds = getStaleElementIds(engine);

    let gameAssetPrefix = "";
    if (gameFrameBaseUrl) {
      try {
        const gfUrl = new URL(gameFrameBaseUrl);
        const dir = gfUrl.pathname.substring(0, gfUrl.pathname.lastIndexOf("/") + 1);
        gameAssetPrefix = "./assets/" + sanitizeName(gfUrl.host) + dir;
      } catch {}
    }

    console.log(`[poki-dl] engine=${engine}, relPrefixes=[${relPrefixes}], staleIds=[${staleIds}]`);

    if (!activeSession.htmlCaptured.game && gameFrameFrameId >= 0) {
      let gameHtml = await getFrameHtmlWithFallback(activeSession.tabId, gameFrameFrameId, gameFrameUrl);
      if (gameHtml && gameHtml.length > 50) {
        const gameUrlMap = buildUrlToLocalMap(gameFrameBaseUrl);
        gameHtml = rewriteAllUrls(gameHtml, gameUrlMap);
        gameHtml = rewriteRemainingGameUrls(gameHtml, hostMap, gameFrameBaseUrl, relPrefixes);
        gameHtml = neutralizePokiSdk(gameHtml);
        gameHtml = removeDynamicLoaderContent(gameHtml, engine);
        gameHtml = removeStaleGameDom(gameHtml, staleIds);
        gameHtml = rewriteAllRelativeGameUrls(gameHtml, gameAssetPrefix);
        gameHtml = injectInterceptor(gameHtml, hostMap, gameRelativeMap, specialMap, gameAssetPrefix, relPrefixes);
        await downloadText(`${activeSession.folder}/game.html`, gameHtml, "text/html;charset=utf-8");
        upsertFile({ type: "entry-html", sourceUrl: gameFrameUrl, localPath: "game.html", status: "ok" });
        activeSession.htmlCaptured.game = true;
        activeSession.stats.downloaded += 1;
      }
    }

    if (!activeSession.htmlCaptured.index && gameElementFrameId >= 0) {
      let indexHtml = await getFrameHtmlWithFallback(activeSession.tabId, gameElementFrameId, gameElementUrl);
      if (indexHtml && indexHtml.length > 50) {
        if (gameFrameUrl) {
          indexHtml = rewriteGameframeSrc(indexHtml, gameFrameUrl, "./game.html");
        }
        const indexUrlMap = buildUrlToLocalMap("");
        indexHtml = rewriteAllUrls(indexHtml, indexUrlMap);
        indexHtml = rewriteRemainingGameUrls(indexHtml, hostMap, "", []);
        indexHtml = neutralizePokiSdk(indexHtml);
        indexHtml = injectInterceptor(indexHtml, hostMap, {}, specialMap, "", []);
        await downloadText(`${activeSession.folder}/index.html`, indexHtml, "text/html;charset=utf-8");
        upsertFile({ type: "entry-html", sourceUrl: gameElementUrl, localPath: "index.html", status: "ok" });
        activeSession.htmlCaptured.index = true;
        activeSession.stats.downloaded += 1;
      }
    }
  } catch (error) {
    console.warn("captureFrameHtml error:", error);
  }
}

async function getFrameHtmlWithFallback(tabId, frameId, frameUrl) {
  let html = "";

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => document.documentElement?.outerHTML || ""
    });
    html = results?.[0]?.result || "";
  } catch { /* cross-origin might reject */ }

  if (html && html.length > 50) return html;

  if (frameUrl) {
    const baseUrl = frameUrl.split("?")[0];
    try {
      const resp = await fetch(baseUrl);
      if (resp.ok) html = await resp.text();
    } catch { /* fetch without params failed */ }

    if (html && html.length > 50) return html;

    try {
      const resp = await fetch(frameUrl, {
        headers: { "Referer": "https://games.poki.com/" }
      });
      if (resp.ok) html = await resp.text();
    } catch { /* fetch with referer failed */ }
  }

  return html || "";
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
  if (all.includes("c3runtime") || all.includes("c2runtime")) return "construct";
  if (all.includes(".pck") || all.includes("/godot")) return "godot";
  if (all.includes("html5game/")) return "gamemaker";
  if (all.includes("phaser")) return "phaser";
  if (all.includes("pixi")) return "pixi";
  if (all.includes("playcanvas")) return "playcanvas";
  if (all.includes("createjs") || all.includes("easeljs")) return "createjs";
  return "unknown";
}

function extractRelativePrefixes(gameFrameBaseUrl) {
  const prefixes = new Set();
  if (!activeSession || !gameFrameBaseUrl) return [];
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl) continue;
    const noQuery = file.sourceUrl.split("?")[0];
    if (noQuery.startsWith(gameFrameBaseUrl)) {
      const rel = noQuery.slice(gameFrameBaseUrl.length);
      const slash = rel.indexOf("/");
      if (slash > 0) {
        prefixes.add(rel.slice(0, slash + 1));
      }
    }
  }
  return Array.from(prefixes);
}

function getStaleElementIds(engine) {
  const BASE = ["loader", "game-container", "spinner", "loading"];
  const ENGINE_IDS = {
    unity: ["loader", "game-container", "spinner", "slideshow",
            "progress-container", "progress-bar", "unity-container",
            "unity-canvas", "unity-loading-bar", "unity-progress-bar-full"],
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

function buildUrlToLocalMap(frameBaseUrl) {
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
    if (frameBaseUrl && noQuery.startsWith(frameBaseUrl)) {
      const rel = noQuery.slice(frameBaseUrl.length);
      if (rel && !rel.startsWith("http") && !map.has(rel)) {
        map.set(rel, localRef);
      }
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

function rewriteRemainingGameUrls(html, hostMap, gameFrameBaseUrl, relPrefixes) {
  for (const [host, prefix] of Object.entries(hostMap)) {
    for (const proto of ["https://", "http://"]) {
      const origin = proto + host + "/";
      if (html.includes(origin)) {
        html = html.split(origin).join("./" + prefix + "/");
      }
      const esc = origin.replace(/\//g, "\\/");
      if (html.includes(esc)) {
        html = html.split(esc).join(("./" + prefix + "/").replace(/\//g, "\\/"));
      }
    }
  }

  if (gameFrameBaseUrl && relPrefixes && relPrefixes.length > 0) {
    try {
      const u = new URL(gameFrameBaseUrl);
      const dir = u.pathname.substring(0, u.pathname.lastIndexOf("/") + 1);
      const localBase = "./assets/" + sanitizeName(u.host) + dir;
      for (const rp of relPrefixes) {
        const safeRp = rp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(["'])${safeRp}`, "g");
        html = html.replace(re, (m, q) => q + localBase + rp);
      }
    } catch {}
  }

  return html;
}

function rewriteAllRelativeGameUrls(html, gameAssetPrefix) {
  if (!gameAssetPrefix) return html;
  const skip = /^(?:data:|blob:|https?:|\/\/|\.\/|\.\.\/|javascript:|#|$)/i;
  const assetExt = /\.(?:js|css|json|wasm|data|png|jpe?g|gif|svg|webp|ico|bmp|avif|mp3|ogg|wav|m4a|aac|webm|mp4|ttf|otf|woff2?|eot|bin|bundle|atlas|fnt|xml|pck|glb|gltf|spine|skel|mem|unityweb)(?:[?#]|$)/i;

  html = html.replace(
    /url\(\s*(["']?)([^"')]+?)\1\s*\)/gi,
    (match, q, path) => {
      path = path.trim();
      if (skip.test(path)) return match;
      return `url(${q}${gameAssetPrefix}${path}${q})`;
    }
  );

  html = html.replace(
    /((?:src|href)\s*=\s*)(["'])([^"']+?)\2/gi,
    (match, attr, q, path) => {
      if (skip.test(path)) return match;
      if (!assetExt.test(path)) return match;
      return `${attr}${q}${gameAssetPrefix}${path}${q}`;
    }
  );

  return html;
}

function buildHostMap() {
  const hostMap = {};
  for (const d of GAME_DOMAIN_EXACT) {
    hostMap[d] = `assets/${sanitizeName(d)}`;
  }
  if (!activeSession) return hostMap;
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl) continue;
    try {
      const url = new URL(file.sourceUrl);
      if (url.host && !hostMap[url.host]) {
        hostMap[url.host] = `assets/${sanitizeName(url.host)}`;
      }
    } catch {}
  }
  return hostMap;
}

function buildRelativeMap(frameBaseUrl) {
  const map = {};
  if (!activeSession || !frameBaseUrl) return map;
  for (const file of activeSession.files) {
    if (file.status !== "ok" || !file.sourceUrl || !file.localPath) continue;
    const noQuery = file.sourceUrl.split("?")[0];
    if (noQuery.startsWith(frameBaseUrl)) {
      const rel = noQuery.slice(frameBaseUrl.length);
      if (rel && !rel.startsWith("http")) {
        map[rel] = `./${file.localPath}`;
      }
    }
  }
  return map;
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

function buildInterceptorScript(hostMap, relativeMap, specialMap, gameAssetPrefix, relPrefixes) {
  const sdkStub =
    `var _pn=function(){};var _pp=function(){return Promise.resolve()};` +
    `window.PokiSDK={init:_pp,gameplayStart:_pn,gameplayStop:_pn,` +
      `commercialBreak:_pp,rewardedBreak:function(){return Promise.resolve(!0)},` +
      `displayAd:_pn,destroyAd:_pn,setDebug:_pn,` +
      `getURLParam:function(){return""},shareableURL:function(){return Promise.resolve("")},` +
      `isAdBlocked:function(){return!1},gameLoadingStart:_pn,gameLoadingFinished:_pn,` +
      `gameLoadingProgress:_pn,gameInteractive:_pn,customEvent:_pn,happyTime:_pn,` +
      `logError:_pn,roundStart:_pn,roundEnd:_pn,muteAd:_pn,` +
      `sendHighscore:_pn,togglePlayerAdvertisingConsent:_pn,disableDOMChangeObservation:_pn};` +
    `console.log("[poki-dl] PokiSDK stub active");`;

  return `<script>(function(){` +
    sdkStub +
    `var H=${JSON.stringify(hostMap)};` +
    `var R=${JSON.stringify(relativeMap)};` +
    `var S=${JSON.stringify(specialMap)};` +
    `var GP=${JSON.stringify(gameAssetPrefix || "")};` +
    `var GRP=${JSON.stringify(relPrefixes || [])};` +
    `var PD=location.pathname.substring(0,location.pathname.lastIndexOf("/")+1);` +
    `function rw(u){` +
      `if(!u||u.startsWith("data:")||u.startsWith("blob:"))return u;` +
      `if(u.includes("poki-sdk-core")||u.includes("poki-sdk-hoist"))` +
        `return"data:text/javascript,console.log('[poki-dl] sdk blocked')";` +
      `try{var o=new URL(u,location.href);` +
        `if(o.protocol!=="http:"&&o.protocol!=="https:")return u;` +
        `if(o.host!==location.host){` +
          `var sk=o.host+o.pathname;if(S[sk])return S[sk];` +
          `var p=H[o.host];if(p)return"./"+p+o.pathname;}` +
        `else{var rel=o.pathname;if(rel.startsWith(PD))rel=rel.substring(PD.length);` +
          `var lc=R[rel];if(lc)return lc;` +
          `if(GP){for(var gi=0;gi<GRP.length;gi++){` +
            `if(rel.startsWith(GRP[gi]))return GP+rel;}` +
          `if(/\\.(?:js|css|json|wasm|data|png|jpe?g|gif|svg|webp|ico|mp3|ogg|wav|m4a|ttf|otf|woff2?|eot|bin|bundle|atlas|fnt|xml|pck|glb|gltf|mem|unityweb)(?:[?#]|$)/i.test(rel))` +
            `return GP+rel;}}` +
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
    `console.log("[poki-dl] interceptor active, hosts:",Object.keys(H).length,` +
      `"relatives:",Object.keys(R).length,"specials:",Object.keys(S).length,` +
      `"gamePrefix:",GP);` +
  `})();</script>`;
}

function neutralizePokiSdk(html) {
  return html
    .replace(/<script[^>]*src="[^"]*poki-sdk-hoist[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*src="[^"]*\/poki-sdk\.js"[^>]*><\/script>/gi, "");
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

function stripFirstDivById(html, id) {
  const marker = new RegExp(`<div\\b[^>]*\\bid\\s*=\\s*["']${id}["']`, "i");
  const match = marker.exec(html);
  if (!match) return html;

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
  return html;
}

function injectInterceptor(html, hostMap, relativeMap, specialMap, gameAssetPrefix, relPrefixes) {
  const script = buildInterceptorScript(hostMap, relativeMap || {}, specialMap || {}, gameAssetPrefix, relPrefixes);
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
  const host = sanitizeName(url.host);
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => sanitizeName(s));
  let filePath = segments.join("/") || "index";
  if (url.search) {
    const h = simpleHash(url.search).slice(0, 8);
    filePath = appendSuffix(filePath, `__q${h}`);
  }
  return `assets/${host}/${filePath}`;
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
    fileCount: activeSession.files.length
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
      pending: new Set(),
    };
    delete activeSession.seenUrlsList;

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
