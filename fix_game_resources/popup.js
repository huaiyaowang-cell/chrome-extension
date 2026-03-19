/**
 * Fix Game Resources - Popup 逻辑
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

/**
 * 将完整游戏地址规范化为根地址（用于下载拼接）
 * 例如 …/254297e9-e0ef-4650-9c0d-8b5459d5c927/index.html → …/254297e9-e0ef-4650-9c0d-8b5459d5c927
 */
function normalizeGameDomainUrl(input) {
  if (!input || typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return raw;
  try {
    const u = new URL(raw);
    let path = u.pathname
      .replace(/\/index\.html$/i, "")
      .replace(/\/+$/, "") || "";
    if (path && !path.startsWith("/")) path = "/" + path;
    return u.origin + path;
  } catch {
    return raw;
  }
}

/** 当前页是否为 Poki 游戏地址（用于自动填充） */
function isPokiGameUrl(url) {
  if (!url || !url.startsWith("http")) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return host.includes("poki.com") || host.includes("gdn.poki.com");
  } catch {
    return false;
  }
}

function parseGameNameFromUrl(url) {
  if (!url || !url.startsWith("http")) return "";
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments[0] || "";
  } catch {
    return "";
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (res?.ok && res.settings) {
      domainEl.value = normalizeGameDomainUrl(res.settings.domain || "") || res.settings.domain || "";
      downloadDirEl.value = res.settings.downloadDir || "";
      gameNameEl.value = res.settings.gameName || "";
    }
  } catch (e) {
    console.warn("loadSettings", e);
  }
}

async function suggestFromTab() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return;
  const url = tab.url.trim();
  const name = parseGameNameFromUrl(url);
  if (name && !gameNameEl.value.trim()) {
    gameNameEl.placeholder = "当前页解析: " + name;
  }
  if (isPokiGameUrl(url) && !domainEl.value.trim()) {
    domainEl.value = normalizeGameDomainUrl(url);
    if (name) gameNameEl.placeholder = "当前页解析: " + name;
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
    const res = await chrome.runtime.sendMessage({
      type: "GET_404_LIST",
      tabId: tab.id
    });
    if (!res?.ok) {
      list404El.innerHTML = '<div class="empty-list">获取 404 列表失败。</div>';
      return;
    }
    current404List = res.list || [];
    if (res.pageUrl && !gameNameEl.value.trim()) {
      const suggested = parseGameNameFromUrl(res.pageUrl);
      if (suggested) gameNameEl.placeholder = "当前页解析: " + suggested;
    }
    render404List(current404List);
    renderFailedList(res.failed || []);
  } catch (e) {
    list404El.innerHTML = '<div class="empty-list">请求失败: ' + (e.message || e) + "</div>";
  }
}

async function loadListenStatus() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_LISTEN_STATUS"
    });
    if (res?.ok) {
      isListening = res.listeningTabId === tab.id;
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
      '<div class="empty-list">暂无 404 记录。请在游戏页面刷新或操作，使页面发起请求，插件会监听同源 404。</div>';
    return;
  }
  list404El.innerHTML = list
    .map(
      (item) =>
        '<div class="list-item">' +
        '<div class="path">' + escapeHtml(item.relativePath) + "</div>" +
        '<div class="url">' + escapeHtml(item.url) + "</div>" +
        "</div>"
    )
    .join("");
}

function renderFailedList(failed) {
  if (!failed || !failed.length) {
    failedSection.style.display = "none";
    return;
  }
  failedSection.style.display = "block";
  failedListEl.innerHTML = failed
    .map(
      (item) =>
        '<div class="list-item">' +
        '<div class="path">' + escapeHtml(item.relativePath) + "</div>" +
        '<div class="url">' + escapeHtml(item.url) + "</div>" +
        '<div class="error">' + escapeHtml(item.error || "") + "</div>" +
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
  const rawDomain = domainEl.value.trim();
  const domain = normalizeGameDomainUrl(rawDomain) || rawDomain;
  const downloadDir = downloadDirEl.value.trim();
  const gameName = gameNameEl.value.trim();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      domain,
      downloadDir,
      gameName
    });
    if (res?.ok) {
      showStatus("设置已保存。", "ok");
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
    showStatus("未获取到当前标签页。请先在游戏页激活该标签，再点击扩展图标打开。", "error");
    return;
  }
  const tabUrl = (tab.url || "").trim();
  if (!tabUrl.startsWith("http://") && !tabUrl.startsWith("https://")) {
    showStatus("当前页不是网页。请先打开游戏页（如 http://localhost:8083/jelly-crush/）再点「开始监听」。", "error");
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
  } else {
    const domain = domainEl.value.trim();
    const downloadDir = downloadDirEl.value.trim();
    if (!domain || !downloadDir) {
      showStatus("请先填写并保存「游戏域名」和「下载目录」，监听期间将自动下载 404 资源。", "error");
      return;
    }
    toggleListenBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "START_LISTEN",
        tabId: tab.id
      });
      if (res?.ok) {
        isListening = true;
        updateListenButton();
        showStatus("已开始监听当前标签页，检测到 404 将自动下载补全。", "ok");
        setTimeout(hideStatus, 2500);
      } else {
        showStatus(res?.error || "开始监听失败", "error");
      }
    } catch (e) {
      const msg = e?.message || String(e);
      showStatus(
        msg.indexOf("Receiving end") !== -1 || msg.indexOf("establish connection") !== -1
          ? "后台未就绪，请关闭弹窗后重新点击扩展图标再试。"
          : "开始失败: " + msg,
        "error"
      );
    }
    toggleListenBtn.disabled = false;
  }
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

// 初始化
(async () => {
  await loadSettings();
  await suggestFromTab();
  await loadListenStatus();
  await load404List();
})();
