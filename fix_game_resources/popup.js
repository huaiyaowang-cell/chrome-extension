/**
 * Fix Game Resources - Popup（与 download-poki-game 共用 pokiSinkSettings）
 */

const domainEl = document.getElementById("domain");
const downloadDirEl = document.getElementById("downloadDir");
const gameNameEl = document.getElementById("gameName");
const list404El = document.getElementById("list404");
const failedSection = document.getElementById("failedSection");
const failedListEl = document.getElementById("failedList");
const statusEl = document.getElementById("status");
const saveSettingsBtn = document.getElementById("saveSettings");
const toggleListenBtn = document.getElementById("toggleListen");
const clear404Btn = document.getElementById("clear404");
const useLocalSinkEl = document.getElementById("useLocalSink");
const sinkServerInfoEl = document.getElementById("sinkServerInfo");
const sinkOutputInfoEl = document.getElementById("sinkOutputInfo");
const testSinkBtn = document.getElementById("testSinkBtn");
const importManifestBtn = document.getElementById("importManifestBtn");

const SINK_SETTINGS_KEY = "pokiSinkSettings";
const STORAGE_SETTINGS = "fixGameResources_settings";
const DEFAULT_DOWNLOAD_DIR = "downloaded-games";
const DEFAULT_SERVER_URL = "http://127.0.0.1:22222";

let currentTabId = null;
let current404List = [];
let isListening = false;

function showStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status-msg " + (type || "info");
  statusEl.style.display = "block";
}

function hideStatus() {
  statusEl.style.display = "none";
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
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments[0] === DEFAULT_DOWNLOAD_DIR && segments[1]) return segments[1];
    return segments[0] || "";
  } catch {
    return "";
  }
}

function getSinkSettings() {
  return { enabled: !!useLocalSinkEl?.checked };
}

async function saveSinkSettings() {
  const sink = getSinkSettings();
  await chrome.storage.local.set({ [SINK_SETTINGS_KEY]: sink });
  return sink;
}

async function refreshSinkInfoDisplay() {
  if (sinkServerInfoEl) sinkServerInfoEl.textContent = DEFAULT_SERVER_URL;
  if (!useLocalSinkEl?.checked) {
    if (sinkOutputInfoEl) sinkOutputInfoEl.textContent = "（未启用）";
    return null;
  }
  try {
    const res = await fetch(`${DEFAULT_SERVER_URL}/health`);
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    const root = data.defaultOutputRoot || "—";
    if (sinkOutputInfoEl) sinkOutputInfoEl.textContent = root;
    return data;
  } catch {
    if (sinkOutputInfoEl) {
      sinkOutputInfoEl.textContent = "无法连接，请先执行 npm run poki-server";
    }
    return null;
  }
}

async function loadSinkSettings() {
  const stored = await chrome.storage.local.get(SINK_SETTINGS_KEY);
  const sink = stored[SINK_SETTINGS_KEY] || {};
  if (useLocalSinkEl) useLocalSinkEl.checked = sink.enabled !== false;
  await refreshSinkInfoDisplay();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function applySettingsToForm(settings) {
  if (!settings) return;
  domainEl.value =
    normalizeGameDomainUrl(settings.domain || "") || settings.domain || "";
  downloadDirEl.value = settings.downloadDir || DEFAULT_DOWNLOAD_DIR;
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
  const downloadDir = downloadDirEl.value.trim() || DEFAULT_DOWNLOAD_DIR;
  const gameName = gameNameEl.value.trim();
  await saveSinkSettings();
  const res = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    domain,
    downloadDir,
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
    showStatus("保存失败: " + (e.message || e), "error");
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

  const downloadDir = downloadDirEl.value.trim() || DEFAULT_DOWNLOAD_DIR;
  downloadDirEl.value = downloadDir;

  const sinkSettings = getSinkSettings();

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

/** 弹窗内直接请求 /health（不依赖 Service Worker，避免误报「检测失败」） */
async function probeLocalServer() {
  await saveSinkSettings();
  if (!useLocalSinkEl?.checked) {
    return { ok: true, mode: "chrome-downloads", message: "已关闭本地服务" };
  }
  const data = await refreshSinkInfoDisplay();
  if (!data?.defaultOutputRoot) {
    throw new Error("无法获取输出目录，请确认 npm run poki-server 已从仓库根目录启动");
  }
  return {
    ok: true,
    mode: "local-server",
    message: `服务正常\n${DEFAULT_SERVER_URL}\n输出: ${data.defaultOutputRoot}`
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
        hint += `\n并确认服务地址为 ${DEFAULT_SERVER_URL}`;
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

if (useLocalSinkEl) {
  useLocalSinkEl.addEventListener("change", () => {
    void saveSinkSettings().then(() => refreshSinkInfoDisplay());
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_SETTINGS]?.newValue) return;
  applySettingsToForm(changes[STORAGE_SETTINGS].newValue);
});

void (async () => {
  await loadSinkSettings();
  await loadSettings();
  await suggestFromTab();
  await loadListenStatus();
  await load404List();
})();
