/**
 * Fix Game Resources - 监听 404 并从游戏域名下载到本地
 * 适用于本地运行的游戏（如 download-mini-games/jelly-crush、poki 等）
 */

const STORAGE_404 = "fixGameResources_404";
const STORAGE_SETTINGS = "fixGameResources_settings";

/* ── 404 收集：webRequest ───────────────────────────────────── */

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.statusCode !== 404 || details.tabId < 0) return;
    const url = details.url;
    if (!url || !url.startsWith("http")) return;

    try {
      const tab = await chrome.tabs.get(details.tabId);
      const pageUrl = tab.url || "";
      if (!pageUrl || !pageUrl.startsWith("http")) return;

      const pageUrlObj = new URL(pageUrl);
      const reqUrlObj = new URL(url);
      // 仅处理与当前页同源的 404（同 host）
      if (pageUrlObj.host !== reqUrlObj.host) return;

      const basePath = getBasePath(pageUrlObj.pathname);
      let relativePath = reqUrlObj.pathname;
      if (basePath && relativePath.startsWith(basePath)) {
        relativePath = relativePath.slice(basePath.length).replace(/^\//, "") || relativePath.slice(1);
      } else {
        relativePath = relativePath.replace(/^\//, "");
      }

      await append404(details.tabId, pageUrl, {
        url,
        relativePath,
        statusCode: details.statusCode,
        time: new Date().toISOString()
      });
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
  const tabData = data[tabId] || { pageUrl, list: [] };
  tabData.pageUrl = pageUrl;
  const exists = tabData.list.some((e) => e.url === entry.url);
  if (!exists) {
    tabData.list.push(entry);
  }
  data[tabId] = tabData;
  await chrome.storage.local.set({ [STORAGE_404]: data });
}

/* ── Tab 关闭时清理 ─────────────────────────────────────────── */

chrome.tabs.onRemoved.addListener(async (tabId) => {
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
          list: tabData?.list || []
        });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
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
    chrome.storage.local
      .set({
        [STORAGE_SETTINGS]: {
          domain: String(domain).trim(),
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
