/**
 * Fix Game Resources - Popup（与 download-poki-game 共用 pokiSinkSettings）
 */

const domainEl = document.getElementById("domain");
const gameNameEl = document.getElementById("gameName");
const list404El = document.getElementById("list404");
const failedSection = document.getElementById("failedSection");
const failedListEl = document.getElementById("failedList");
const statusEl = document.getElementById("status");
const saveSettingsBtn = document.getElementById("saveSettings");
const toggleListenBtn = document.getElementById("toggleListen");
const clear404Btn = document.getElementById("clear404");
const useLocalSinkEl = document.getElementById("useLocalSink");
const sinkServerUrlEl = document.getElementById("sinkServerUrl");
const sinkOutputRootEl = document.getElementById("sinkOutputRoot");
const testSinkBtn = document.getElementById("testSinkBtn");
const importManifestBtn = document.getElementById("importManifestBtn");
const loadLocalGamesBtn = document.getElementById("loadLocalGamesBtn");
const localGamesSummaryEl = document.getElementById("localGamesSummary");
const localGamesGridEl = document.getElementById("localGamesGrid");
const localGamesEmptyEl = document.getElementById("localGamesEmpty");

const SINK_SETTINGS_KEY = "pokiSinkSettings";
const STORAGE_SETTINGS = "fixGameResources_settings";
const DEFAULT_SERVER_URL = "http://127.0.0.1:22222";
const LEGACY_DOWNLOAD_DIR = "downloaded-games";

let currentTabId = null;
let current404List = [];
let isListening = false;
/** @type {{ origin: string, pathPrefix: string }} */
let previewContext = { origin: "", pathPrefix: "/" };
let lastLocalGamesOutputRoot = "";

function showStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status-msg " + (type || "info");
  statusEl.style.display = "block";
}

function hideStatus() {
  statusEl.style.display = "none";
}

async function capturePreviewContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith("http")) {
      const u = new URL(tab.url);
      previewContext = {
        origin: u.origin,
        pathPrefix: u.pathname || "/"
      };
      return previewContext;
    }
  } catch {
    /* ignore */
  }
  previewContext = { origin: "", pathPrefix: "/" };
  return previewContext;
}

/**
 * 根据当前预览页 origin + 输出根目录名，拼本地 http 游戏地址。
 * 例：服务在 downloaded-games 根目录 → /games-test/foo/
 *     服务在 games-test 目录内 → /foo/
 */
function buildLocalPreviewUrl(outputRoot, folder) {
  const origin = (previewContext.origin || "").replace(/\/$/, "");
  const folderName = String(folder || "").trim();
  if (!origin || !folderName) return "";

  const rootName =
    String(outputRoot || "")
      .replace(/\\/g, "/")
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean)
      .pop() || "";

  const pathPrefix = previewContext.pathPrefix || "/";
  let urlPath = folderName;
  if (
    rootName &&
    (pathPrefix === `/${rootName}` ||
      pathPrefix.startsWith(`/${rootName}/`) ||
      pathPrefix.includes(`/${rootName}/`))
  ) {
    urlPath = `${rootName}/${folderName}`;
  }

  const segments = urlPath.split("/").filter(Boolean).map(encodeURIComponent);
  return `${origin}/${segments.join("/")}/`;
}

async function openLocalGameInCurrentTab(outputRoot, folder) {
  await capturePreviewContext();
  const url = buildLocalPreviewUrl(outputRoot, folder);
  if (!url) {
    showStatus("无法构建本地预览地址，请先在浏览器打开本地 http 服务页面", "error");
    setTimeout(hideStatus, 3000);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus("未找到当前标签页", "error");
    setTimeout(hideStatus, 2500);
    return;
  }
  await chrome.tabs.update(tab.id, { url });
}

function normalizeGameDomainUrl(input) {
  if (!input || typeof input !== "string") return "";
  const raw = input.trim();
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

function parseGameNameFromUrl(url) {
  if (!url || !url.startsWith("http")) return "";
  try {
    let segments = new URL(url).pathname.split("/").filter(Boolean);
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

function getSinkSettings() {
  return {
    enabled: !!useLocalSinkEl?.checked,
    serverUrl: (sinkServerUrlEl?.value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, ""),
    outputRoot: (sinkOutputRootEl?.value || "").trim()
  };
}

async function saveSinkSettings() {
  const sink = getSinkSettings();
  await chrome.storage.local.set({ [SINK_SETTINGS_KEY]: sink });
  return sink;
}

async function loadSinkSettings() {
  const stored = await chrome.storage.local.get(SINK_SETTINGS_KEY);
  const sink = stored[SINK_SETTINGS_KEY] || {};
  if (useLocalSinkEl) useLocalSinkEl.checked = sink.enabled !== false;
  if (sinkServerUrlEl) sinkServerUrlEl.value = sink.serverUrl || DEFAULT_SERVER_URL;
  if (sinkOutputRootEl && sink.outputRoot) sinkOutputRootEl.value = sink.outputRoot;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function applySettingsToForm(settings) {
  if (!settings) return;
  domainEl.value =
    normalizeGameDomainUrl(settings.domain || "") || settings.domain || "";
  gameNameEl.value = settings.gameName || "";
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (res?.ok && res.settings) {
      applySettingsToForm(res.settings);
    }
  } catch (e) {
    console.warn("loadSettings", e);
  }
}

async function saveAllSettings() {
  const rawDomain = domainEl.value.trim();
  const domain = normalizeGameDomainUrl(rawDomain) || rawDomain;
  const gameName = gameNameEl.value.trim();
  await saveSinkSettings();
  const res = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    domain,
    gameName
  });
  return res;
}

async function suggestFromTab() {
  const tab = await getActiveTab();
  if (!tab?.url) return;
  const name = parseGameNameFromUrl(tab.url);
  if (name && !gameNameEl.value.trim()) {
    gameNameEl.value = name;
    gameNameEl.placeholder = "当前页: " + name;
  }
}

async function syncFromCurrentPage(force = true) {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url?.startsWith("http")) {
    throw new Error("请在本地游戏页打开（http://...）");
  }
  const res = await chrome.runtime.sendMessage({
    type: "SYNC_FROM_PAGE",
    tabId: tab.id,
    pageUrl: tab.url,
    force
  });
  if (!res?.ok) throw new Error(res?.error || "同步失败");
  if (res.settings) applySettingsToForm(res.settings);
  return res;
}

async function importFromManifest() {
  try {
    const res = await syncFromCurrentPage(true);
    showStatus(
      `已从 manifest 同步\nCDN: ${domainEl.value.slice(0, 72)}${domainEl.value.length > 72 ? "…" : ""}\n游戏: ${gameNameEl.value}`,
      "ok"
    );
    return res;
  } catch (e) {
    showStatus("读取 manifest 失败: " + (e.message || e), "error");
  }
}

async function load404List() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    list404El.innerHTML = '<div class="empty-list">未获取到当前标签页。</div>';
    return;
  }
  currentTabId = tab.id;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_404_LIST", tabId: tab.id });
    if (!res?.ok) {
      list404El.innerHTML = '<div class="empty-list">获取 404 列表失败。</div>';
      return;
    }
    current404List = res.list || [];
    if (res.pageUrl && !gameNameEl.value.trim()) {
      const suggested = parseGameNameFromUrl(res.pageUrl);
      if (suggested) gameNameEl.value = suggested;
    }
    render404List(current404List);
    renderFailedList(res.failed || []);
  } catch (e) {
    list404El.innerHTML =
      '<div class="empty-list">请求失败: ' + (e.message || e) + "</div>";
  }
}

async function loadListenStatus() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_LISTEN_STATUS" });
    if (res?.ok) {
      isListening = res.listeningTabId === tab.id;
      if (res.settings) applySettingsToForm(res.settings);
      updateListenButton();
    }
  } catch {}
}

function updateListenButton() {
  if (isListening) {
    toggleListenBtn.textContent = "停止监听";
    toggleListenBtn.classList.add("secondary");
  } else {
    toggleListenBtn.textContent = "开始监听";
    toggleListenBtn.classList.remove("secondary");
  }
}

function render404List(list) {
  if (!list.length) {
    list404El.innerHTML =
      '<div class="empty-list">暂无 404。开始监听后刷新游戏页，404 将自动补全到本地目录。</div>';
    return;
  }
  list404El.innerHTML = list
    .map(
      (item) =>
        '<div class="list-item">' +
        '<div class="path">' +
        escapeHtml(item.relativePath) +
        "</div>" +
        '<div class="url">' +
        escapeHtml(item.url) +
        "</div>" +
        "</div>"
    )
    .join("");
}

function renderFailedList(failed) {
  if (!failed?.length) {
    failedSection.style.display = "none";
    return;
  }
  failedSection.style.display = "block";
  failedListEl.innerHTML = failed
    .map(
      (item) =>
        '<div class="list-item">' +
        '<div class="path">' +
        escapeHtml(item.relativePath) +
        "</div>" +
        '<div class="url">' +
        escapeHtml(item.url) +
        "</div>" +
        '<div class="error">' +
        escapeHtml(item.error || "") +
        "</div>" +
        "</div>"
    )
    .join("");
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

saveSettingsBtn.addEventListener("click", async () => {
  try {
    const res = await saveAllSettings();
    if (res?.ok) {
      showStatus("设置已保存（含本地服务配置）。", "ok");
      setTimeout(hideStatus, 2000);
    } else {
      showStatus(res?.error || "保存失败", "error");
    }
  } catch (e) {
    showStatus("保存失败: " + (e?.message || e), "error");
  }
});

toggleListenBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    showStatus("未获取到当前标签页。", "error");
    return;
  }
  const tabUrl = (tab.url || "").trim();
  if (!tabUrl.startsWith("http://") && !tabUrl.startsWith("https://")) {
    showStatus("请先打开本地游戏页（http://...）", "error");
    return;
  }

  if (isListening) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "STOP_LISTEN" });
      if (res?.ok) {
        isListening = false;
        updateListenButton();
        showStatus("已停止监听。", "ok");
        setTimeout(hideStatus, 1500);
      } else {
        showStatus(res?.error || "停止失败", "error");
      }
    } catch (e) {
      showStatus("停止失败: " + (e?.message || e), "error");
    }
    return;
  }

  const sinkSettings = getSinkSettings();
  if (sinkSettings.enabled && !sinkSettings.outputRoot) {
    showStatus("请填写「输出根目录」。", "error");
    return;
  }

  await saveAllSettings();
  toggleListenBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "START_LISTEN",
      tabId: tab.id,
      sinkSettings
    });
    if (res?.ok) {
      isListening = true;
      if (res.settings) applySettingsToForm(res.settings);
      updateListenButton();
      const mode = res.sinkMode === "local-server" ? "本地服务" : "Chrome 下载";
      const gameLine = res.settings?.gameName ? `\n游戏: ${res.settings.gameName}` : "";
      const cdnLine = res.settings?.domain
        ? `\nCDN: ${String(res.settings.domain).slice(0, 72)}`
        : "";
      showStatus(
        `已开始监听（${mode}）${gameLine}${cdnLine}\n切换游戏页 URL 时会自动更新配置。`,
        "ok"
      );
      setTimeout(hideStatus, 3500);
    } else {
      showStatus(res?.error || "开始监听失败", "error");
    }
  } catch (e) {
    const msg = e?.message || String(e);
    showStatus(
      msg.includes("Receiving end") || msg.includes("establish connection")
        ? "后台未就绪，请重新加载扩展。"
        : "开始失败: " + msg,
      "error"
    );
  }
  toggleListenBtn.disabled = false;
});

clear404Btn.addEventListener("click", async () => {
  if (!currentTabId) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "CLEAR_404_LIST",
      tabId: currentTabId
    });
    if (res?.ok) {
      current404List = [];
      render404List([]);
      renderFailedList([]);
      showStatus("已清空 404 列表。", "ok");
      setTimeout(hideStatus, 1500);
    } else {
      showStatus(res?.error || "清空失败", "error");
    }
  } catch (e) {
    showStatus("清空失败: " + (e.message || e), "error");
  }
});

async function probeLocalServer() {
  const sink = getSinkSettings();
  await saveSinkSettings();
  if (!sink.enabled) {
    return { ok: true, mode: "chrome-downloads", message: "已关闭本地服务" };
  }
  const base = sink.serverUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/health`, { method: "GET" });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  if (!data?.ok) {
    throw new Error("服务返回异常");
  }
  if (!sink.outputRoot) {
    return {
      ok: true,
      mode: "local-server",
      message: `服务正常（${base}），请填写「输出根目录」后开始监听`
    };
  }
  return {
    ok: true,
    mode: "local-server",
    message: `服务正常\n${base}\n输出: ${sink.outputRoot}`
  };
}

if (testSinkBtn) {
  testSinkBtn.addEventListener("click", async () => {
    testSinkBtn.disabled = true;
    testSinkBtn.textContent = "检测中...";
    try {
      const result = await probeLocalServer();
      showStatus(result.message || "本地服务正常", "ok");
    } catch (e) {
      const msg = e?.message || String(e);
      let hint = "请确认已执行: npm run poki-server";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
        hint += `\n并确认服务地址为 ${sinkServerUrlEl?.value || DEFAULT_SERVER_URL}`;
      }
      showStatus(`本地服务不可用: ${msg}\n${hint}`, "error");
    } finally {
      testSinkBtn.disabled = false;
      testSinkBtn.textContent = "检测服务";
    }
  });
}

if (importManifestBtn) {
  importManifestBtn.addEventListener("click", () => void importFromManifest());
}

function renderLocalGames(result) {
  const games = result?.games || [];
  if (!localGamesGridEl || !localGamesEmptyEl) return;
  lastLocalGamesOutputRoot = result?.outputRoot || "";

  if (games.length === 0) {
    if (localGamesSummaryEl) localGamesSummaryEl.style.display = "none";
    localGamesGridEl.style.display = "none";
    localGamesGridEl.innerHTML = "";
    localGamesEmptyEl.style.display = "block";
    localGamesEmptyEl.textContent = `输出目录暂无游戏文件夹（${result?.outputRoot || ""}）`;
    return;
  }

  if (localGamesSummaryEl) {
    localGamesSummaryEl.style.display = "block";
    localGamesSummaryEl.textContent = `共 ${games.length} 个游戏（${result.outputRoot || ""}）`;
  }
  localGamesEmptyEl.style.display = "none";
  localGamesGridEl.style.display = "grid";
  localGamesGridEl.innerHTML = games
    .map((game) => {
      const title = escapeHtml(game.title || game.folder);
      const folder = escapeHtml(game.folder || "");
      const icon = game.iconUrl
        ? `<img src="${escapeHtml(game.iconUrl)}" alt="${title}" loading="lazy" />`
        : `<div style="width:56px;height:56px;border-radius:10px;background:#e5e7eb"></div>`;
      return `<button type="button" class="local-game-card" data-folder="${folder}" title="${title}\n${escapeHtml(game.folder)}">${icon}<span>${title}</span></button>`;
    })
    .join("");

  localGamesGridEl.querySelectorAll(".local-game-card").forEach((card) => {
    card.addEventListener("click", () => {
      const folder = card.getAttribute("data-folder");
      if (!folder) return;
      void openLocalGameInCurrentTab(lastLocalGamesOutputRoot, folder);
    });
  });
}

async function loadLocalGames(options = {}) {
  const silent = !!options.silent;
  if (loadLocalGamesBtn) {
    loadLocalGamesBtn.disabled = true;
    loadLocalGamesBtn.textContent = "读取中...";
  }
  if (localGamesGridEl) localGamesGridEl.style.display = "none";
  if (localGamesSummaryEl) localGamesSummaryEl.style.display = "none";

  try {
    await capturePreviewContext();
    await saveSinkSettings();
    const sink = getSinkSettings();
    if (!sink.enabled) {
      throw new Error("请先启用本地服务");
    }
    if (!sink.outputRoot) {
      throw new Error("请填写输出根目录");
    }

    const result = await chrome.runtime.sendMessage({
      type: "LIST_LOCAL_GAMES",
      sinkSettings: sink
    });
    if (!result?.ok) throw new Error(result.error || "读取失败");
    renderLocalGames(result);
    if (!silent) {
      showStatus(`已读取 ${result.count ?? result.games?.length ?? 0} 个本地游戏`, "ok");
      setTimeout(hideStatus, 2500);
    }
  } catch (e) {
    if (localGamesEmptyEl) {
      localGamesEmptyEl.style.display = "block";
      localGamesEmptyEl.textContent = e?.message || String(e);
    }
    if (!silent) {
      showStatus(`读取本地游戏失败: ${e?.message || e}`, "error");
    }
  } finally {
    if (loadLocalGamesBtn) {
      loadLocalGamesBtn.disabled = false;
      loadLocalGamesBtn.textContent = "读取本地游戏";
    }
  }
}

if (loadLocalGamesBtn) {
  loadLocalGamesBtn.addEventListener("click", () => void loadLocalGames());
}

if (useLocalSinkEl) useLocalSinkEl.addEventListener("change", () => void saveSinkSettings());
if (sinkServerUrlEl) sinkServerUrlEl.addEventListener("blur", () => void saveSinkSettings());
if (sinkOutputRootEl) sinkOutputRootEl.addEventListener("blur", () => void saveSinkSettings());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_SETTINGS]?.newValue) return;
  applySettingsToForm(changes[STORAGE_SETTINGS].newValue);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "SETTINGS_AUTO_SYNCED") return;
  if (message.settings) applySettingsToForm(message.settings);
  if (message.changed && message.settings?.gameName) {
    showStatus(`已切换游戏，已从 manifest 同步: ${message.settings.gameName}`, "ok");
    setTimeout(hideStatus, 2500);
    void load404List();
  } else if (message.error) {
    showStatus("同步 manifest: " + message.error, "error");
    setTimeout(hideStatus, 3000);
  }
});

void (async () => {
  await loadSinkSettings();
  await loadSettings();
  await suggestFromTab();
  await loadListenStatus();
  await load404List();
  if (useLocalSinkEl?.checked && (sinkOutputRootEl?.value || "").trim()) {
    void loadLocalGames({ silent: true });
  }
})();
