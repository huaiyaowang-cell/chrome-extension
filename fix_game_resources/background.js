/**
 * Fix Game Resources - 监听 404 并从游戏域名下载到本地
 * 与 download-poki-game 共用 poki-dl-server / pokiSinkSettings
 */

import * as localSink from "./local-sink.js";
import { mergeManifest } from "./assets-manifest-lib.js";

const MANIFEST_REL_PATH = "assets-manifest.json";

const STORAGE_404 = "fixGameResources_404";
const STORAGE_SETTINGS = "fixGameResources_settings";
const STORAGE_LISTENING = "fixGameResources_listeningTabId";
/** @deprecated 旧版 storage 可能含 downloadDir，已忽略 */
const LEGACY_DOWNLOAD_DIR = "downloaded-games";

void localSink.loadSettings();
chrome.runtime.onStartup.addListener(() => {
  void localSink.loadSettings();
});

/** @type {{ relPrefix: string, gameName: string, domain: string, pageUrl: string, pageKey: string } | null} */
let activeFixSession = null;

let syncDebounceTimer = null;
/** @type {string} */
let lastSyncedPageKey = "";
/** @type {string} 当前监听页面对应的游戏目录名（URL 最后一段） */
let lastSyncedGameSlug = "";

/** 串行化 404 下载，避免并发 startSession / flush 竞态 */
let downloadQueue = Promise.resolve();
/** 当前正在执行的 404 下载任务数（用于避免在任务内 await downloadQueue 死锁） */
let downloadJobsInFlight = 0;

/** 串行化 manifest 同步（与 404 下载队列配合，避免竞态） */
let settingsSyncChain = Promise.resolve();

/** 同一游戏+相对路径的 404 补全合并为一次（刷新连发时避免排队压垮） */
/** @type {Map<string, Promise<void>>} */
const inflight404ByKey = new Map();

function normalize404Rel(encodedRel) {
  const rel = String(encodedRel || "").replace(/^\//, "");
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

function make404DownloadKey(pageUrl, encodedRel, gameName = "", relPrefix = "") {
  const slug =
    (relPrefix || "").trim() ||
    sanitizeName(gameName) ||
    sanitizeName(parseGameNameFromUrl(pageUrl)) ||
    "unknown";
  return `${slug}|${normalize404Rel(encodedRel)}`;
}

function clearInflight404Keys() {
  inflight404ByKey.clear();
}

function enqueueDownloadJob(fn) {
  const job = downloadQueue.then(async () => {
    downloadJobsInFlight += 1;
    try {
      return await fn();
    } finally {
      downloadJobsInFlight -= 1;
    }
  });
  downloadQueue = job.catch(() => {});
  return job;
}

/** 等待其它 404 下载结束；若当前就在下载任务内则跳过，避免死锁 */
async function waitForPendingDownloads() {
  if (downloadJobsInFlight <= 1) return;
  try {
    await downloadQueue;
  } catch {
    /* 队列中某项失败不影响后续会话重置 */
  }
}

function enqueueSettingsSync(fn) {
  const job = settingsSyncChain.then(() => fn());
  settingsSyncChain = job.catch(() => {});
  return job;
}

/* ── 监听状态 ───────────────────────────────────────────────── */

async function getListeningTabId() {
  const raw = await chrome.storage.local.get(STORAGE_LISTENING);
  const id = raw[STORAGE_LISTENING];
  return id != null && Number.isInteger(id) ? id : null;
}

async function setListeningTabId(tabId) {
  await chrome.storage.local.set({ [STORAGE_LISTENING]: tabId });
}

function getEncodedRelativePath(pageUrl, requestUrl) {
  try {
    const pageUrlObj = new URL(pageUrl);
    const reqUrlObj = new URL(requestUrl);
    if (pageUrlObj.host !== reqUrlObj.host) return null;
    const basePath = getBasePath(pageUrlObj.pathname);
    const fullPathEncoded = requestUrl.slice(reqUrlObj.origin.length).split("?")[0].split("#")[0];
    const pathEncoded = fullPathEncoded.startsWith("/") ? fullPathEncoded : "/" + fullPathEncoded;
    let relativePath = pathEncoded;
    if (basePath && pathEncoded.startsWith(basePath)) {
      relativePath = pathEncoded.slice(basePath.length).replace(/^\//, "") || pathEncoded.slice(1);
    } else {
      relativePath = pathEncoded.replace(/^\//, "");
    }
    return relativePath || null;
  } catch {
    return null;
  }
}

function getBasePath(pathname) {
  if (!pathname || pathname === "/") return "";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return pathname.slice(0, lastSlash + 1);
}

/* ── 404 收集 + 自动下载 ─────────────────────────────────────── */

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.statusCode !== 404 || details.tabId < 0) return;
    const listeningTabId = await getListeningTabId();
    if (listeningTabId === null || details.tabId !== listeningTabId) return;

    const url = details.url;
    if (!url || !url.startsWith("http")) return;

    try {
      const tab = await chrome.tabs.get(details.tabId);
      const pageUrl = tab.url || "";
      if (!pageUrl || !pageUrl.startsWith("http")) return;

      const relativePath = getEncodedRelativePath(pageUrl, url);
      if (!relativePath) return;

      const entry = {
        url,
        relativePath,
        statusCode: details.statusCode,
        time: new Date().toISOString()
      };
      await append404(details.tabId, pageUrl, entry);
      await autoDownloadOne(details.tabId, pageUrl, entry);
    } catch (e) {
      console.warn("[fix_game_resources] onCompleted:", e.message);
    }
  },
  { urls: ["http://*/*", "https://*/*"] }
);

async function get404Storage() {
  const raw = await chrome.storage.local.get(STORAGE_404);
  return raw[STORAGE_404] || {};
}

async function append404(tabId, pageUrl, entry) {
  const data = await get404Storage();
  const tabData = data[tabId] || { pageUrl, list: [], failed: [] };
  tabData.pageUrl = pageUrl;
  if (!tabData.list) tabData.list = [];
  if (!tabData.failed) tabData.failed = [];
  const exists = tabData.list.some((e) => e.url === entry.url);
  if (!exists) tabData.list.push(entry);
  data[tabId] = tabData;
  await chrome.storage.local.set({ [STORAGE_404]: data });
}

async function appendFailed(tabId, item) {
  const data = await get404Storage();
  const tabData = data[tabId] || { pageUrl: "", list: [], failed: [] };
  if (!tabData.failed) tabData.failed = [];
  tabData.failed.push(item);
  data[tabId] = tabData;
  await chrome.storage.local.set({ [STORAGE_404]: data });
}

async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_SETTINGS);
  const s = raw[STORAGE_SETTINGS] || {};
  return {
    domain: s.domain || "",
    gameName: s.gameName || "",
    relPrefix: s.relPrefix || ""
  };
}

async function saveSettingsToStorage(settings) {
  const domain = gameUrlToCdnRoot(settings.domain) || normalizeGameDomainUrl(settings.domain);
  const gameName = String(settings.gameName || "").trim();
  const relPrefix = String(settings.relPrefix || "").trim() || gameName;
  const next = {
    domain,
    gameName,
    relPrefix
  };
  await chrome.storage.local.set({ [STORAGE_SETTINGS]: next });
  return next;
}

function sanitizeName(input) {
  return String(input)
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function isPokiPortalUrl(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    return host === "poki.com" || host.endsWith(".poki.com");
  } catch {
    return false;
  }
}

/** 本地静态服游戏页（localhost / 127.0.0.1 / 局域网 IP） */
function isLocalGamePageUrl(pageUrl) {
  if (!pageUrl) return false;
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "file:") return true;
    if (isPokiPortalUrl(pageUrl)) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Poki 门户路径误当作本地目录，如 en/g/cricket-world-cup */
function isPortalRelPrefix(relPrefix) {
  const p = String(relPrefix || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!p) return false;
  if (/\/g\/[^/]+/i.test(`/${p}/`)) return true;
  if (/^[a-z]{2}\/g\//i.test(p)) return true;
  return false;
}

function normalizeRelPrefix(relPrefix) {
  return String(relPrefix || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** 输出根目录下的游戏相对路径（仅从本地游戏页 URL 解析） */
function parseGameRelPrefixFromPageUrl(pageUrl) {
  if (!isLocalGamePageUrl(pageUrl)) return "";
  try {
    let segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (segments.length === 0) return "";
    if (/\.html?$/i.test(segments[segments.length - 1])) {
      segments = segments.slice(0, -1);
    }
    if (segments[0] === LEGACY_DOWNLOAD_DIR && segments.length > 1) {
      segments = segments.slice(1);
    }
    const prefix = segments.join("/");
    return isPortalRelPrefix(prefix) ? "" : prefix;
  } catch {
    return "";
  }
}

function resolveRelPrefix(settings, pageUrl) {
  const fromSettings = normalizeRelPrefix(settings?.relPrefix);
  if (fromSettings && !isPortalRelPrefix(fromSettings)) return fromSettings;
  const fromPage = parseGameRelPrefixFromPageUrl(pageUrl);
  if (fromPage) return fromPage;
  const slug = parseGameNameFromUrl(pageUrl);
  return slug ? sanitizeName(slug) : "";
}

function resolveRelPrefixFromManifest(manifest, localPageUrl) {
  const folder = normalizeRelPrefix(manifest?.folder);
  if (folder && !isPortalRelPrefix(folder)) return folder;

  const localPrefix = parseGameRelPrefixFromPageUrl(localPageUrl);
  if (localPrefix) return localPrefix;

  if (manifest?.pageUrl && isLocalGamePageUrl(manifest.pageUrl)) {
    const fromManifestPage = parseGameRelPrefixFromPageUrl(manifest.pageUrl);
    if (fromManifestPage) return fromManifestPage;
  }

  return "";
}

function gameSlugMatchesManifest(slugFromUrl, manifestGame, relPrefix) {
  if (!slugFromUrl || !manifestGame) return true;
  const slugNorm = sanitizeName(slugFromUrl).toLowerCase();
  const manifestNorm = sanitizeName(manifestGame).toLowerCase();
  if (slugNorm === manifestNorm) return true;
  const relTail = (relPrefix || "").split("/").filter(Boolean).pop() || "";
  if (relTail && sanitizeName(relTail).toLowerCase() === slugNorm) return true;
  // manifest.gameName 可能是展示标题（含空格），不与 URL slug 做严格相等
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(manifestGame).trim())) return true;
  return false;
}

/** 从 manifest.gameUrl 得到无 query/hash 的 CDN 根地址 */
function gameUrlToCdnRoot(gameUrl) {
  if (!gameUrl || typeof gameUrl !== "string") return "";
  try {
    const u = new URL(gameUrl.trim());
    let path = u.pathname.replace(/\/index\.html$/i, "").replace(/\/+$/, "") || "";
    if (path && !path.startsWith("/")) path = "/" + path;
    return u.origin + path;
  } catch {
    return normalizeGameDomainUrl(gameUrl);
  }
}

async function fetchManifestForPage(pageUrl) {
  const manifestUrl = new URL("assets-manifest.json", pageUrl).href;
  const res = await fetch(manifestUrl, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

/**
 * 根据本地游戏页 URL 读取 assets-manifest.json，自动更新 CDN 根地址与游戏名
 * @returns {{ changed: boolean, settings: object, error?: string }}
 */
async function syncSettingsFromPageUrl(pageUrl, options = {}) {
  const { force = false } = options;
  if (!pageUrl || !pageUrl.startsWith("http")) {
    return { changed: false, settings: await getSettings(), error: "invalid pageUrl" };
  }

  const pageKey = pageUrl.split("#")[0];
  const gameNameFromUrl = parseGameNameFromUrl(pageUrl);
  const prev = await getSettings();
  const gameSwitched =
    !!gameNameFromUrl &&
    !!prev.gameName &&
    gameNameFromUrl !== prev.gameName;

  if (!force && pageKey === lastSyncedPageKey && !gameSwitched) {
    return { changed: false, settings: prev };
  }
  let domain = "";
  let gameName = gameNameFromUrl;
  let relPrefix = parseGameRelPrefixFromPageUrl(pageUrl);

  try {
    const manifest = await fetchManifestForPage(pageUrl);
    if (!manifest) {
      return {
        changed: false,
        settings: await getSettings(),
        error: "无法读取 assets-manifest.json（请确认在游戏目录页）"
      };
    }
    if (manifest.gameUrl) {
      domain = gameUrlToCdnRoot(manifest.gameUrl);
    }
    if (manifest.gameName) {
      gameName = String(manifest.gameName).trim();
    }
    const fromManifest = resolveRelPrefixFromManifest(manifest, pageUrl);
    if (fromManifest) relPrefix = fromManifest;
  } catch (e) {
    console.warn("[fix_game_resources] 读取 manifest 失败:", e.message);
    return {
      changed: false,
      settings: await getSettings(),
      error: e.message
    };
  }

  if (!domain) {
    return {
      changed: false,
      settings: await getSettings(),
      error: "assets-manifest.json 中缺少 gameUrl"
    };
  }

  const next = {
    domain,
    gameName: gameName || prev.gameName || gameNameFromUrl,
    relPrefix:
      relPrefix ||
      prev.relPrefix ||
      gameNameFromUrl ||
      parseGameRelPrefixFromPageUrl(pageUrl)
  };

  const valuesChanged =
    next.domain !== prev.domain ||
    next.gameName !== prev.gameName ||
    next.relPrefix !== prev.relPrefix;

  if (valuesChanged || force) {
    await saveSettingsToStorage(next);
    if (valuesChanged) {
      await waitForPendingDownloads();
      if (await localSink.isLocalSinkRequested()) {
        try {
          await localSink.flushQueue();
        } catch (e) {
          console.warn("[fix_game_resources] flush before session reset:", e.message);
        }
      }
      localSink.clearSession();
      activeFixSession = null;
      clearInflight404Keys();
    }
    lastSyncedPageKey = pageKey;
    if (valuesChanged) {
      console.log("[fix_game_resources] 自动同步设置:", next.gameName, next.domain);
    }
    return { changed: valuesChanged, settings: next };
  }

  lastSyncedPageKey = pageKey;
  return { changed: false, settings: next };
}

function notifySettingsSynced(sync) {
  try {
    chrome.runtime.sendMessage({
      type: "SETTINGS_AUTO_SYNCED",
      settings: sync.settings,
      changed: !!sync.changed,
      error: sync.error || null
    });
  } catch {
    /* popup 未打开时无接收方 */
  }
}

async function reset404ListForTab(tabId, pageUrl) {
  const data = await get404Storage();
  data[tabId] = { pageUrl, list: [], failed: [] };
  await chrome.storage.local.set({ [STORAGE_404]: data });
}

async function runSyncFromTab(tabId, pageUrl, options = {}) {
  return enqueueSettingsSync(async () => {
    const listening = await getListeningTabId();
    if (listening === null || listening !== tabId) return null;

    const gameSlug = parseGameNameFromUrl(pageUrl);
    const gameChanged = !!gameSlug && gameSlug !== lastSyncedGameSlug;

    if (gameChanged) {
      await waitForPendingDownloads();
      clearInflight404Keys();
      await reset404ListForTab(tabId, pageUrl);
      console.log("[fix_game_resources] 已切换游戏，404 列表已清空:", gameSlug);
    }

    const sync = await syncSettingsFromPageUrl(pageUrl, {
      force: !!options.force || gameChanged
    });

    if (gameSlug) lastSyncedGameSlug = gameSlug;

    notifySettingsSynced(sync);
    return sync;
  });
}

function scheduleSyncFromTab(tabId, pageUrl, options = {}) {
  const gameSlug = parseGameNameFromUrl(pageUrl);
  const gameChanged = !!gameSlug && gameSlug !== lastSyncedGameSlug;

  if (options.immediate || gameChanged) {
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }
    void runSyncFromTab(tabId, pageUrl, options);
    return;
  }

  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    syncDebounceTimer = null;
    void runSyncFromTab(tabId, pageUrl, options);
  }, 350);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void (async () => {
    const listening = await getListeningTabId();
    if (listening === null || tabId !== listening) return;
    const pageUrl = changeInfo.url || tab?.url || "";
    if (!pageUrl.startsWith("http")) return;
    if (changeInfo.url || changeInfo.status === "complete") {
      scheduleSyncFromTab(tabId, pageUrl, { immediate: !!changeInfo.url });
    }
  })();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    const listening = await getListeningTabId();
    if (listening === null || activeInfo.tabId !== listening) return;
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      const pageUrl = tab.url || "";
      if (!pageUrl.startsWith("http")) return;
      scheduleSyncFromTab(activeInfo.tabId, pageUrl, { immediate: true });
    } catch {
      /* tab 可能已关闭 */
    }
  })();
});

function parseGameNameFromUrl(pageUrl) {
  if (!pageUrl || !pageUrl.startsWith("http")) return "";
  try {
    let segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (segments.length === 0) return "";
    if (/\.html?$/i.test(segments[segments.length - 1])) {
      segments = segments.slice(0, -1);
    }
    if (segments[0] === LEGACY_DOWNLOAD_DIR && segments.length > 1) {
      segments = segments.slice(1);
    }
    return segments[segments.length - 1] || "";
  } catch {
    return "";
  }
}

function normalizeGameDomainUrl(input) {
  if (!input || typeof input !== "string") return "";
  const raw = String(input).trim();
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return raw;
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/\/index\.html$/i, "").replace(/\/+$/, "") || "";
    if (path && !path.startsWith("/")) path = "/" + path;
    return u.origin + path;
  } catch {
    return raw;
  }
}

function relPathForFile(encodedRel) {
  try {
    return decodeURIComponent(encodedRel);
  } catch {
    return encodedRel;
  }
}

function buildRemoteAndLocal(settings, pageUrl, encodedRel) {
  const domain = normalizeGameDomainUrl(settings.domain).replace(/\/+$/, "");
  const relPrefix = resolveRelPrefix(settings, pageUrl);
  let gameName = (settings.gameName || "").trim();
  if (!gameName) gameName = parseGameNameFromUrl(pageUrl);
  const rel = (encodedRel || "").replace(/^\//, "");
  if (!domain || !relPrefix || !rel) {
    throw new Error("缺少游戏域名、游戏目录或相对路径");
  }
  const sourceUrl = `${domain}/${rel}`;
  const relForFile = relPathForFile(rel);
  return { sourceUrl, relPath: relForFile, relPrefix, gameName, domain };
}

function buildFixSessionOpts(settings, pageUrl) {
  const relPrefix = resolveRelPrefix(settings, pageUrl);
  let gameName = (settings.gameName || "").trim();
  if (!gameName) gameName = parseGameNameFromUrl(pageUrl);
  if (!relPrefix) {
    throw new Error("无法确定游戏目录（请确认在游戏目录页或 manifest 中有 pageUrl）");
  }
  if (!gameName) {
    const tail = relPrefix.split("/").filter(Boolean).pop();
    gameName = tail || relPrefix;
  }
  return {
    gameName: sanitizeName(gameName),
    relPrefix,
    pageUrl,
    referer: normalizeGameDomainUrl(settings.domain),
    gameUrl: settings.domain
  };
}

/**
 * @returns {Promise<object | null>} sessionOpts（本地模式）或 null（chrome 下载模式）
 */
async function ensureFixSession(settings, pageUrl) {
  const ready = await localSink.ensureLocalSinkReady();
  if (ready.mode !== "local-server") return null;

  const sessionOpts = buildFixSessionOpts(settings, pageUrl);
  const { gameName, relPrefix } = sessionOpts;
  const domainNorm = normalizeGameDomainUrl(settings.domain);
  const pageKey = pageUrl.split("#")[0];

  if (
    activeFixSession &&
    (activeFixSession.relPrefix !== relPrefix ||
      activeFixSession.domain !== domainNorm ||
      activeFixSession.pageKey !== pageKey)
  ) {
    await localSink.flushQueue();
    localSink.clearSession();
    activeFixSession = null;
  }

  if (!localSink.getSessionId()) {
    const started = await localSink.startSession(sessionOpts);
    activeFixSession = {
      relPrefix,
      gameName,
      domain: domainNorm,
      pageUrl,
      pageKey
    };
    console.log("[fix_game_resources] 本地会话:", started.sessionId, started.gameDir);
  }

  return sessionOpts;
}

/**
 * 确保 CDN / 游戏名与当前页一致；manifest 未就绪时 ready=false，禁止用旧配置下载
 */
async function ensureSettingsForPage(pageUrl) {
  const pageKey = pageUrl.split("#")[0];
  if (!pageKey.startsWith("http")) {
    return { settings: await getSettings(), error: "无效页面 URL", ready: false };
  }

  return enqueueSettingsSync(async () => {
    const slugFromUrl = parseGameNameFromUrl(pageUrl);
    const prev = await getSettings();
    const needForce =
      pageKey !== lastSyncedPageKey ||
      !(prev.domain || "").trim() ||
      (!!slugFromUrl && !!prev.gameName && slugFromUrl !== prev.gameName);

    const sync = await syncSettingsFromPageUrl(pageUrl, { force: needForce });
    const settings = sync.settings;

    if (sync.error) {
      return { settings, error: sync.error, ready: false };
    }
    if (!(settings.domain || "").trim()) {
      return {
        settings,
        error: "assets-manifest.json 中缺少 gameUrl",
        ready: false
      };
    }
    const manifestGame = (settings.gameName || "").trim();
    const relPrefix = resolveRelPrefix(settings, pageUrl);
    if (!gameSlugMatchesManifest(slugFromUrl, manifestGame, relPrefix)) {
      return {
        settings,
        error: `manifest 游戏名 (${manifestGame}) 与当前页 (${slugFromUrl}) 不一致`,
        ready: false
      };
    }
    return { settings, error: null, ready: true };
  });
}

async function readManifestForMerge(pageUrl) {
  try {
    return await fetchManifestForPage(pageUrl);
  } catch {
    return null;
  }
}

async function saveManifestMerged(settings, pageUrl, merged) {
  const json = JSON.stringify(merged, null, 2);
  const relPrefix = resolveRelPrefix(settings, pageUrl);
  if (!relPrefix) return;

  const sessionOpts = await ensureFixSession(settings, pageUrl);
  if (sessionOpts) {
    await localSink.saveTextWithSessionRecovery(
      MANIFEST_REL_PATH,
      json,
      sessionOpts,
      { overwrite: true }
    );
    return;
  }

  const filename = `${relPrefix}/${MANIFEST_REL_PATH}`;
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  const dataUrl = "data:application/json;charset=utf-8;base64," + btoa(binary);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, conflictAction: "overwrite", saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      }
    );
  });
}

/** 将补全资源合并写入 assets-manifest.json（不覆盖已有条目） */
async function appendToAssetsManifest(settings, pageUrl, fileEntry) {
  const gameName = (settings.gameName || "").trim();
  const domain = (settings.domain || "").trim();
  if (!gameName || !domain) return;

  const existing = await readManifestForMerge(pageUrl);
  const merged = mergeManifest(existing, {
    gameName,
    gameUrl: domain,
    pageUrl,
    status: "fixing",
    files: [fileEntry]
  });
  await saveManifestMerged(settings, pageUrl, merged);
}

/**
 * 保存单个 404 资源（本地服务写入输出目录；仅用户关闭本地服务时用 chrome.downloads）
 */
async function saveOneResource(settings, pageUrl, encodedRel) {
  const { sourceUrl, relPath, relPrefix } = buildRemoteAndLocal(settings, pageUrl, encodedRel);

  const sessionOpts = await ensureFixSession(settings, pageUrl);
  if (sessionOpts) {
    await localSink.flushQueue();
    if (await localSink.fileExists(relPath)) {
      try {
        await appendToAssetsManifest(settings, pageUrl, {
          type: "asset",
          sourceUrl,
          localPath: relPath,
          status: "ok",
          requestType: "404-fix",
          fixedAt: new Date().toISOString(),
          skipped: true
        });
      } catch (e) {
        console.warn("[fix_game_resources] 写入 manifest:", e.message);
      }
      return {
        sourceUrl,
        relativePath: encodedRel,
        relPath,
        status: "skipped",
        reason: "exists"
      };
    }
    const result = await localSink.ingestWithSessionRecovery(
      { sourceUrl, relPath, overwrite: true },
      sessionOpts
    );
    if (result?.status === "failed") {
      throw new Error(result.error || "ingest failed");
    }
    try {
      await appendToAssetsManifest(settings, pageUrl, {
        type: "asset",
        sourceUrl,
        localPath: relPath,
        status: "ok",
        requestType: "404-fix",
        fixedAt: new Date().toISOString(),
        skipped: result?.status === "skipped"
      });
    } catch (e) {
      console.warn("[fix_game_resources] 写入 manifest:", e.message);
    }
    return { sourceUrl, relativePath: encodedRel, relPath, status: result?.status || "ok" };
  }

  const filename = `${relPrefix}/${relPath}`;
  await fetchAndSaveChrome(sourceUrl, filename);
  try {
    await appendToAssetsManifest(settings, pageUrl, {
      type: "asset",
      sourceUrl,
      localPath: relPath,
      status: "ok",
      requestType: "404-fix",
      fixedAt: new Date().toISOString()
    });
  } catch (e) {
    console.warn("[fix_game_resources] 写入 manifest:", e.message);
  }
  return { sourceUrl, relativePath: encodedRel, filename, status: "ok" };
}

async function fetchAndSaveChrome(sourceUrl, filename) {
  const resp = await fetch(sourceUrl);
  if (!resp.ok) throw new Error(`fetch ${resp.status} ${resp.statusText}`);
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  const dataUrl = "data:application/octet-stream;base64," + btoa(binary);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, conflictAction: "overwrite", saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      }
    );
  });
}

async function autoDownloadOne(tabId, pageUrl, entry) {
  const settings = await getSettings();
  const key = make404DownloadKey(
    pageUrl,
    entry.relativePath,
    settings.gameName,
    resolveRelPrefix(settings, pageUrl)
  );
  const existing = inflight404ByKey.get(key);
  if (existing) {
    return existing;
  }

  const task = enqueueDownloadJob(async () => {
    const { settings, error: syncError, ready } = await ensureSettingsForPage(pageUrl);
    const domain = (settings.domain || "").trim();
    if (!ready || !domain) {
      const errMsg =
        syncError ||
        "manifest 未就绪（请确认在游戏目录页且 assets-manifest.json 可访问）";
      console.warn("[fix_game_resources] 暂缓 404 下载:", entry.url, errMsg);
      await appendFailed(tabId, {
        url: entry.url,
        relativePath: entry.relativePath,
        error: errMsg
      });
      return;
    }

    try {
      await saveOneResource(settings, pageUrl, entry.relativePath);
    } catch (e) {
      await appendFailed(tabId, {
        url: entry.url,
        relativePath: entry.relativePath,
        error: e && e.message ? e.message : String(e)
      });
      throw e;
    }
  })
    .catch(() => {
      /* 已在上方 appendFailed */
    })
    .finally(() => {
      if (inflight404ByKey.get(key) === task) {
        inflight404ByKey.delete(key);
      }
    });

  inflight404ByKey.set(key, task);
  return task;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const listening = await getListeningTabId();
  if (listening === tabId) {
    await setListeningTabId(null);
    localSink.clearSession();
    activeFixSession = null;
    lastSyncedPageKey = "";
    lastSyncedGameSlug = "";
    clearInflight404Keys();
  }
  const data = await get404Storage();
  if (data[tabId]) {
    delete data[tabId];
    await chrome.storage.local.set({ [STORAGE_404]: data });
  }
});

/* ── 消息处理 ────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_404_LIST") {
    get404Storage()
      .then((data) => {
        const tabId = message.tabId;
        const tabData = tabId != null ? data[tabId] : null;
        sendResponse({
          ok: true,
          pageUrl: tabData?.pageUrl || "",
          list: tabData?.list || [],
          failed: tabData?.failed || []
        });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "START_LISTEN") {
    (async () => {
      try {
        const tabId = message.tabId;
        if (tabId == null || !Number.isInteger(tabId) || tabId < 1) {
          sendResponse({ ok: false, error: "无效的标签页" });
          return;
        }
        const tab = await chrome.tabs.get(tabId);
        const pageUrl = tab.url || "";
        if (!pageUrl.startsWith("http")) {
          sendResponse({ ok: false, error: "请在本地游戏页（http://...）开启监听" });
          return;
        }
        await localSink.loadSettings(message.sinkSettings || {});
        const sinkReady = await localSink.ensureLocalSinkReady(message.sinkSettings || {});
        if (sinkReady.mode === "local-server") {
          console.log("[fix_game_resources] 输出目录:", sinkReady.outputRoot);
        }
        localSink.clearSession();
        activeFixSession = null;
        lastSyncedPageKey = "";
        lastSyncedGameSlug = "";
        clearInflight404Keys();
        const sync = await syncSettingsFromPageUrl(pageUrl, { force: true });
        if (sync.error || !sync.settings?.domain) {
          sendResponse({
            ok: false,
            error:
              sync.error ||
              "无法从 assets-manifest.json 读取 gameUrl，请确认当前页在游戏目录下"
          });
          return;
        }
        lastSyncedGameSlug = parseGameNameFromUrl(pageUrl) || sync.settings.gameName || "";
        await setListeningTabId(tabId);
        notifySettingsSynced(sync);
        sendResponse({
          ok: true,
          sinkMode:
            (await localSink.isLocalSinkRequested()) ? "local-server" : "chrome-downloads",
          settings: sync.settings,
          settingsChanged: sync.changed
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "STOP_LISTEN") {
    (async () => {
      try {
        await setListeningTabId(null);
        if (localSink.isEnabled()) await localSink.flushQueue();
        localSink.clearSession();
        activeFixSession = null;
        lastSyncedPageKey = "";
        lastSyncedGameSlug = "";
        clearInflight404Keys();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "GET_LISTEN_STATUS") {
    (async () => {
      try {
        const id = await getListeningTabId();
        await localSink.loadSettings();
        const settings = await getSettings();
        const sinkMode = (await localSink.isLocalSinkRequested())
          ? "local-server"
          : "chrome-downloads";
        sendResponse({
          ok: true,
          listeningTabId: id,
          sinkMode,
          settings
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "CLEAR_404_LIST") {
    const tabId = message.tabId;
    if (tabId == null) {
      sendResponse({ ok: false, error: "missing tabId" });
      return true;
    }
    (async () => {
      try {
        const data = await get404Storage();
        const tabData = data[tabId];
        data[tabId] = { pageUrl: (tabData && tabData.pageUrl) || "", list: [], failed: [] };
        await chrome.storage.local.set({ [STORAGE_404]: data });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "GET_TAB_URL") {
    const tabId = message.tabId;
    if (tabId == null) {
      sendResponse({ ok: false, error: "missing tabId" });
      return true;
    }
    chrome.tabs
      .get(tabId)
      .then((tab) => sendResponse({ ok: true, url: tab.url || "" }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "SYNC_FROM_PAGE") {
    (async () => {
      try {
        const tabId = message.tabId;
        let pageUrl = message.pageUrl || "";
        if (!pageUrl && tabId != null) {
          const tab = await chrome.tabs.get(tabId);
          pageUrl = tab.url || "";
        }
        const sync = await syncSettingsFromPageUrl(pageUrl, { force: true });
        sendResponse({ ok: true, ...sync });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    const { domain = "", gameName = "" } = message;
    saveSettingsToStorage({ domain, gameName })
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    getSettings()
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "LIST_LOCAL_GAMES") {
    (async () => {
      try {
        await localSink.loadSettings(message.sinkSettings || {});
        if (!(await localSink.isLocalSinkRequested())) {
          sendResponse({
            ok: false,
            error: "请先启用本地服务并填写输出根目录"
          });
          return;
        }
        await localSink.ensureLocalSinkReady(message.sinkSettings || {});
        const r = await localSink.listLocalGames(
          message.sinkSettings?.outputRoot
        );
        sendResponse({ ok: true, ...r });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "CHECK_SINK_HEALTH") {
    (async () => {
      try {
        await localSink.loadSettings(message.sinkSettings || {});
        if (!localSink.isEnabled()) {
          sendResponse({ ok: true, mode: "chrome-downloads" });
          return;
        }
        const r = await localSink.pingServer(message.sinkSettings || {});
        sendResponse({ ok: true, ...r });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "DOWNLOAD_404") {
    const { tabId, items, domain, gameName } = message;
    if (!items?.length || !domain) {
      sendResponse({ ok: false, error: "缺少 domain 或 items" });
      return true;
    }

    (async () => {
      try {
        let pageUrl = "";
        if (tabId != null) {
          try {
            const tab = await chrome.tabs.get(tabId);
            pageUrl = tab.url || "";
          } catch {}
        }
        const settings = {
          domain: normalizeGameDomainUrl(domain),
          gameName: String(gameName || "").trim()
        };
        await localSink.loadSettings(message.sinkSettings || {});
        if (await localSink.isLocalSinkRequested()) {
          await localSink.ensureLocalSinkReady(message.sinkSettings || {});
          localSink.clearSession();
          activeFixSession = null;
        }

        const downloaded = [];
        const failed = [];
        await enqueueDownloadJob(async () => {
          const { settings: synced, error: syncError, ready } =
            await ensureSettingsForPage(pageUrl);
          const useSettings =
            ready && (synced.domain || "").trim() ? synced : settings;
          if (!ready || !(useSettings.domain || "").trim()) {
            throw new Error(syncError || "无法同步游戏 CDN 配置（manifest 未就绪）");
          }
          for (const item of items) {
            const rel = item.relativePath || item.path || "";
            if (!rel) continue;
            try {
              const r = await saveOneResource(useSettings, pageUrl, rel);
              downloaded.push(r);
            } catch (e) {
              const built = buildRemoteAndLocal(useSettings, pageUrl, rel);
              failed.push({
                url: built.sourceUrl,
                relativePath: rel,
                error: e && e.message ? e.message : String(e)
              });
            }
          }
        });
        return { ok: true, downloaded, failed };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));

    return true;
  }

  return false;
});
