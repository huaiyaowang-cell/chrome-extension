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
const refresh404Btn = document.getElementById("refresh404");
const downloadAllBtn = document.getElementById("downloadAll");

let currentTabId = null;
let current404List = [];

function showStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status-msg " + (type || "info");
  statusEl.style.display = "block";
}

function hideStatus() {
  statusEl.style.display = "none";
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
      domainEl.value = res.settings.domain || "";
      downloadDirEl.value = res.settings.downloadDir || "";
      gameNameEl.value = res.settings.gameName || "";
    }
  } catch (e) {
    console.warn("loadSettings", e);
  }
}

async function suggestGameName() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const name = parseGameNameFromUrl(tab.url);
  if (name && !gameNameEl.value.trim()) {
    gameNameEl.placeholder = "当前页解析: " + name;
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
  } catch (e) {
    list404El.innerHTML = '<div class="empty-list">请求失败: ' + (e.message || e) + "</div>";
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
  const domain = domainEl.value.trim();
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

refresh404Btn.addEventListener("click", () => {
  load404List();
  showStatus("已刷新 404 列表。", "info");
  setTimeout(hideStatus, 1500);
});

downloadAllBtn.addEventListener("click", async () => {
  const domain = domainEl.value.trim();
  const downloadDir = downloadDirEl.value.trim();
  const gameName = gameNameEl.value.trim();
  if (!domain || !downloadDir) {
    showStatus("请先填写「游戏域名」和「下载目录」并保存。", "error");
    return;
  }
  if (!current404List.length) {
    showStatus("当前没有 404 资源可下载，请先刷新列表或刷新游戏页。", "error");
    return;
  }

  downloadAllBtn.disabled = true;
  showStatus("正在下载 " + current404List.length + " 个资源…", "info");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_404",
      tabId: currentTabId,
      items: current404List.map((e) => ({ url: e.url, relativePath: e.relativePath })),
      domain,
      downloadDir,
      gameName
    });

    if (!res?.ok) {
      showStatus(res?.error || "下载请求失败", "error");
      downloadAllBtn.disabled = false;
      return;
    }

    const downloaded = res.downloaded || [];
    const failed = res.failed || [];
    if (failed.length) {
      renderFailedList(failed);
      showStatus(
        "已下载 " + downloaded.length + " 个，失败 " + failed.length + " 个。失败列表见下方。",
        "error"
      );
    } else {
      renderFailedList([]);
      showStatus("已成功下载 " + downloaded.length + " 个资源到 " + downloadDir + "/&lt;游戏名&gt;/…", "ok");
    }
  } catch (e) {
    showStatus("下载失败: " + (e.message || e), "error");
  }
  downloadAllBtn.disabled = false;
});

// 初始化
(async () => {
  await loadSettings();
  await suggestGameName();
  await load404List();
})();
