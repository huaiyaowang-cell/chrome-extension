/**
 * Fix Game Resources - 监听 404 并从游戏域名下载到本地
 * 适用于本地运行的游戏（如 download-mini-games/jelly-crush、poki 等）
 */

const STORAGE_404 = "fixGameResources_404";
const STORAGE_SETTINGS = "fixGameResources_settings";
const STORAGE_LISTENING = "fixGameResources_listeningTabId";

/* ── 监听状态 ───────────────────────────────────────────────── */

async function getListeningTabId() {
  const raw = await chrome.storage.local.get(STORAGE_LISTENING);
  const id = raw[STORAGE_LISTENING];
  return id != null && Number.isInteger(id) ? id : null;
}

async function setListeningTabId(tabId) {
  await chrome.storage.local.set({ [STORAGE_LISTENING]: tabId });
}

/**
 * 从请求 URL 取「编码后的相对路径」（保留 %20 等），保证保存的文件名与请求一致，避免仍 404。
 */
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

/* ── 404 收集 + 自动下载：仅在“开始监听”时 ────────────────────── */

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

function getBasePath(pathname) {
  if (!pathname || pathname === "/") return "";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return pathname.slice(0, lastSlash + 1);
}

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
  if (!exists) {
    tabData.list.push(entry);
  }
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

/** 监听到 404 时自动下载单个资源 */
async function autoDownloadOne(tabId, pageUrl, entry) {
  const settings = await getSettings();
  const domain = (settings.domain || "").trim();
  const downloadDir = (settings.downloadDir || "").trim();
  if (!domain || !downloadDir) return;

  let gameName = (settings.gameName || "").trim();
  if (!gameName) gameName = parseGameNameFromUrl(pageUrl);
  if (!gameName) return;

  const rel = (entry.relativePath || "").replace(/^\//, "");
  if (!rel) return;

  const baseDomain = normalizeGameDomainUrl(domain).replace(/\/+$/, "");
  const sourceUrl = `${baseDomain}/${rel}`;
  let relForFile = rel;
  try {
    relForFile = decodeURIComponent(rel);
  } catch {
    /* 非合法编码则用原路径 */
  }
  const filename = `${downloadDir}/${gameName}/${relForFile}`;

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: sourceUrl, filename, conflictAction: "overwrite", saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(downloadId);
        }
      );
    });
  } catch (e) {
    await appendFailed(tabId, {
      url: sourceUrl,
      relativePath: rel,
      error: e && e.message ? e.message : String(e)
    });
  }
}

/* ── Tab 关闭时清理 ─────────────────────────────────────────── */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const listening = await getListeningTabId();
  if (listening === tabId) await setListeningTabId(null);
  const data = await get404Storage();
  if (data[tabId]) {
    delete data[tabId];
    await chrome.storage.local.set({ [STORAGE_404]: data });
  }
});

/* ── 设置读写 ────────────────────────────────────────────────── */

async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_SETTINGS);
  return raw[STORAGE_SETTINGS] || { domain: "", downloadDir: "", gameName: "" };
}

/* ── 从页面 URL 解析游戏名 ───────────────────────────────────── */

function parseGameNameFromUrl(pageUrl) {
  if (!pageUrl || !pageUrl.startsWith("http")) return "";
  try {
    const pathname = new URL(pageUrl).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments[0] || "";
  } catch {
    return "";
  }
}

/** 将完整游戏地址（含 /index.html）规范化为根地址，支持 minigame / Poki */
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
          sendResponse({ ok: false, error: "无效的标签页，请确保在游戏页再点扩展图标打开" });
          return;
        }
        await setListeningTabId(tabId);
        sendResponse({ ok: true });
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
        sendResponse({ ok: true, listeningTabId: id });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
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
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
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
    chrome.tabs.get(tabId)
      .then((tab) => sendResponse({ ok: true, url: tab.url || "" }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    const { domain = "", downloadDir = "", gameName = "" } = message;
    const normalizedDomain = normalizeGameDomainUrl(String(domain).trim()) || String(domain).trim();
    chrome.storage.local
      .set({
        [STORAGE_SETTINGS]: {
          domain: normalizedDomain,
          downloadDir: String(downloadDir).trim(),
          gameName: String(gameName).trim()
        }
      })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    getSettings()
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message?.type === "DOWNLOAD_404") {
    const { tabId, items, domain, downloadDir, gameName } = message;
    if (!items?.length || !domain || !downloadDir) {
      sendResponse({ ok: false, error: "缺少 domain、downloadDir 或 items" });
      return true;
    }

    (async () => {
      let resolvedGameName = String(gameName || "").trim();
      if (!resolvedGameName && tabId != null) {
        try {
          const tab = await chrome.tabs.get(tabId);
          resolvedGameName = parseGameNameFromUrl(tab.url || "");
        } catch {}
      }
      if (!resolvedGameName) {
        return { ok: false, error: "无法解析游戏名，请填写「游戏名」或确保当前页 URL 含路径（如 /jelly-crush/）" };
      }

      const baseDomain = domain.replace(/\/+$/, "");
      const downloaded = [];
      const failed = [];

      for (const item of items) {
        const rel = (item.relativePath || item.path || "").replace(/^\//, "");
        if (!rel) continue;
        const sourceUrl = `${baseDomain}/${rel}`;
        const filename = `${downloadDir}/${resolvedGameName}/${rel}`;

        try {
          await new Promise((resolve, reject) => {
            chrome.downloads.download(
              { url: sourceUrl, filename, conflictAction: "overwrite", saveAs: false },
              (downloadId) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(downloadId);
                }
              }
            );
          });
          downloaded.push({ url: sourceUrl, relativePath: rel, filename });
        } catch (e) {
          failed.push({
            url: sourceUrl,
            relativePath: rel,
            error: e && e.message ? e.message : String(e)
          });
        }
      }

      return { ok: true, downloaded, failed };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));

    return true;
  }

  return false;
});
