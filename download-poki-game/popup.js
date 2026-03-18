const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const manualGameUrlEl = document.getElementById("manualGameUrl");
const manualResourceListEl = document.getElementById("manualResourceList");
const addResourceBtn = document.getElementById("addResourceBtn");
const exportConfigBtn = document.getElementById("exportConfigBtn");
const importConfigBtn = document.getElementById("importConfigBtn");
const importFileEl = document.getElementById("importFile");
const clearConfigBtn = document.getElementById("clearConfigBtn");

const POPUP_CONFIG_KEY = "popupConfig";

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("error");
}

function setError(text) {
  statusEl.textContent = text;
  statusEl.classList.add("error");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function updateButtons(state) {
  const isListening = state === "listening";
  const isIdle = state === "idle" || state === "stopped";

  startBtn.textContent = isListening ? "监听中..." : "开始监听当前标签页";
  startBtn.disabled = isListening;
  captureBtn.disabled = !isListening;
  stopBtn.disabled = !isListening;
}

function renderStatus(result) {
  if (!result || result.status === "idle" || result.status === "stopped") {
    if (result?.status === "stopped") {
      const s = result.stats || {};
      setStatus(
        `已停止\n游戏: ${result.gameName}\n已下载: ${s.downloaded || 0}\n文件数: ${result.fileCount || 0}\n目录: ${result.folder}/`
      );
    } else {
      setStatus("当前未监听。\n点击「开始监听」后刷新页面并进入游戏。");
    }
    updateButtons("idle");
    return;
  }

  const s = result.stats || {};
  const gameLine = result.gameDetected
    ? `游戏域名: ${result.gameHost}`
    : "游戏检测: 等待中...";
  const htmlLine = result.htmlCaptured ? "index.html ✓" : "index.html ✗";
  const lines = [
    "状态: 监听中",
    `游戏: ${result.gameName}`,
    gameLine,
    `已下载: ${s.downloaded || 0}`,
    `失败: ${s.failed || 0}`,
    `总请求: ${s.totalSeen || 0}`,
    `文件数: ${result.fileCount || 0}`,
    `HTML: ${htmlLine}`,
    `网络缓存: ${result.networkCacheSize || 0} 条${result.debuggerAttached ? "" : " (调试器未连接!)"}`,
    result.gameDetected ? "" : `缓冲队列: ${result.bufferSize || 0} 条`,
    `目录: ${result.folder}/`
  ];
  setStatus(lines.filter(Boolean).join("\n"));
  updateButtons("listening");
}

async function refreshStatus() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("未找到当前标签页。");
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({
      type: "GET_MONITOR_STATUS",
      tabId: tab.id
    });
    if (result?.ok) {
      renderStatus(result);
    }
  } catch {
    setError("无法获取状态，请重新加载插件。");
  }
}

function getManualResourceUrls() {
  const inputs = manualResourceListEl.querySelectorAll(".resource-row input");
  return Array.from(inputs)
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function savePopupConfig() {
  const manualGameUrl = manualGameUrlEl.value.trim() || null;
  const manualResourceUrls = getManualResourceUrls();
  chrome.storage.local.set({
    [POPUP_CONFIG_KEY]: { manualGameUrl, manualResourceUrls }
  });
}

async function loadPopupConfig() {
  const stored = await chrome.storage.local.get(POPUP_CONFIG_KEY);
  const config = stored[POPUP_CONFIG_KEY];
  if (config) {
    manualGameUrlEl.value = config.manualGameUrl || "";
    manualResourceListEl.innerHTML = "";
    const urls = Array.isArray(config.manualResourceUrls) ? config.manualResourceUrls : [];
    if (urls.length === 0) addResourceRow();
    else urls.forEach((u) => addResourceRow(typeof u === "string" ? u : ""));
  } else {
    if (manualResourceListEl.children.length === 0) addResourceRow();
  }
}

function addResourceRow(value = "") {
  const row = document.createElement("div");
  row.className = "resource-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://...";
  input.value = value;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary remove-btn";
  removeBtn.textContent = "删除";
  removeBtn.addEventListener("click", () => {
    row.remove();
    savePopupConfig();
  });
  row.appendChild(input);
  row.appendChild(removeBtn);
  manualResourceListEl.appendChild(row);
}

addResourceBtn.addEventListener("click", () => {
  addResourceRow();
  savePopupConfig();
});

manualGameUrlEl.addEventListener("blur", () => savePopupConfig());
manualResourceListEl.addEventListener("blur", (e) => {
  if (e.target.matches("input")) savePopupConfig();
}, true);

/* 初始化：从 storage 恢复配置，若无则至少一行 */
void loadPopupConfig();

clearConfigBtn.addEventListener("click", () => {
  manualGameUrlEl.value = "";
  manualResourceListEl.innerHTML = "";
  addResourceRow();
  savePopupConfig();
  setStatus("配置已清空。");
});

startBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在开启监听...");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");

    const manualGameUrl = manualGameUrlEl.value.trim() || null;
    const manualResourceUrls = getManualResourceUrls();

    const result = await chrome.runtime.sendMessage({
      type: "START_MONITOR",
      tabId: tab.id,
      manualGameUrl,
      manualResourceUrls
    });

    if (!result) throw new Error("后台无响应，请在 chrome://extensions/ 重新加载插件。");
    if (!result.ok) throw new Error(result.error || "开启监听失败。");

    const usedManualUrl = !!manualGameUrl && manualGameUrl.startsWith("http");
    let statusMsg = usedManualUrl
      ? `监听已开启！\n游戏: ${result.gameName}\n目录: ${result.folder}/\n\n已使用游戏地址，页面将自动刷新，资源会通过 CDP 抓取并保存。`
      : `监听已开启！\n游戏: ${result.gameName}\n目录: ${result.folder}/\n\n请现在刷新页面，进入游戏。\n检测到游戏后资源将自动下载。\n\n若刷新后仍无下载：可填写上方「游戏地址」和「指定下载的静态资源」后重新开始监听。`;
    if (usedManualUrl) {
      try {
        const port = chrome.runtime.connect({ name: "keepalive" });
        window._keepAlivePort = port;
        statusMsg += "\n\n请勿关闭本弹窗，直至控制台出现多行「CDP 保存」后再关闭。";
      } catch (_) {}
    }
    setStatus(statusMsg);
    updateButtons("listening");
    savePopupConfig();
  } catch (error) {
    setError(`错误: ${error.message}`);
    updateButtons("idle");
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "正在生成...";

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");

    const result = await chrome.runtime.sendMessage({
      type: "CAPTURE_HTML",
      tabId: tab.id
    });

    if (!result) throw new Error("后台无响应。");
    if (!result.ok) throw new Error(result.error || "生成失败。");

    setStatus(`生成成功！\n${result.message}`);
  } catch (error) {
    setError(`生成失败: ${error.message}`);
  } finally {
    captureBtn.textContent = "生成 HTML（游戏加载后点）";
    captureBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在停止监听...");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");

    const result = await chrome.runtime.sendMessage({
      type: "STOP_MONITOR",
      tabId: tab.id
    });

    if (!result) throw new Error("后台无响应，请在 chrome://extensions/ 重新加载插件。");
    if (!result.ok) throw new Error(result.error || "停止监听失败。");

    if (result.warnings?.length) {
      renderStatus(result);
      setStatus(statusEl.textContent + "\n\n警告:\n" + result.warnings.join("\n"));
    } else {
      renderStatus(result);
    }
  } catch (error) {
    setError(`错误: ${error.message}`);
    updateButtons("idle");
  }
});

/* ── Asset download buttons ── */

const assetButtons = [
  { btn: "dlGameIcon", input: "gameIconUrl", key: "game_icon" },
  { btn: "dlThumbnailVideo", input: "thumbnailVideoUrl", key: "thumbnail_video" },
  { btn: "dlGameCover", input: "gameCoverUrl", key: "game_cover" }
];

for (const { btn, input, key } of assetButtons) {
  document.getElementById(btn).addEventListener("click", async () => {
    const url = document.getElementById(input).value.trim();
    if (!url) return;
    const button = document.getElementById(btn);
    button.disabled = true;
    button.textContent = "...";
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error("未找到标签页");
      const result = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_ASSET",
        tabId: tab.id,
        url,
        assetKey: key
      });
      if (!result) throw new Error("后台无响应");
      if (!result.ok) throw new Error(result.error || "下载失败");
      button.textContent = "✓";
      setTimeout(() => { button.textContent = "下载"; button.disabled = false; }, 1500);
    } catch (e) {
      button.textContent = "✗";
      setError(`资源下载失败: ${e.message}`);
      setTimeout(() => { button.textContent = "下载"; button.disabled = false; }, 2000);
    }
  });
}

/* ── 配置导出 / 导入 ── */

exportConfigBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");
    const statusResult = await chrome.runtime.sendMessage({
      type: "GET_MONITOR_STATUS",
      tabId: tab.id
    });
    if (!statusResult?.ok) throw new Error("无法获取状态。");
    const folder = statusResult.folder;
    const gameName = statusResult.gameName || "poki-game";
    if (!folder) throw new Error("无游戏目录信息，请先开始监听一次。");

    const config = {
      gameName,
      folder,
      manualGameUrl: manualGameUrlEl.value.trim() || null,
      manualResourceUrls: getManualResourceUrls()
    };

    const result = await chrome.runtime.sendMessage({
      type: "EXPORT_CONFIG",
      config,
      folder
    });
    if (!result?.ok) throw new Error(result?.error || "导出失败。");
    setStatus(`配置已导出到：${result.filename}`);
  } catch (e) {
    setError(`导出失败: ${e.message}`);
  }
});

importConfigBtn.addEventListener("click", () => importFileEl.click());

importFileEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = "";
  try {
    const text = await file.text();
    const config = JSON.parse(text);
    if (config.manualGameUrl != null) manualGameUrlEl.value = config.manualGameUrl || "";
    const urls = Array.isArray(config.manualResourceUrls) ? config.manualResourceUrls : [];
    manualResourceListEl.innerHTML = "";
    if (urls.length === 0) addResourceRow();
    else urls.forEach((u) => addResourceRow(typeof u === "string" ? u : ""));
    setStatus(`已导入配置，游戏: ${config.gameName || "-"}，${urls.length} 个资源地址。`);
  } catch (err) {
    setError(`导入失败: ${err.message}`);
  }
});

/* ── Polling ── */

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshStatus(), 3000);
}

void refreshStatus();
startPolling();
