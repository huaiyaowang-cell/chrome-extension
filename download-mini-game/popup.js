const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

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
    setStatus("无法获取状态，请重新加载插件。");
  }
}

startBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在开启监听...");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");

    const result = await chrome.runtime.sendMessage({
      type: "START_MONITOR",
      tabId: tab.id
    });

    if (!result) throw new Error("后台无响应，请在 chrome://extensions/ 重新加载插件。");
    if (!result.ok) throw new Error(result.error || "开启监听失败。");

    setStatus(
      `监听已开启！\n游戏: ${result.gameName}\n目录: ${result.folder}/\n\n请现在刷新页面，进入游戏。\n检测到游戏后资源将自动下载。`
    );
    updateButtons("listening");
  } catch (error) {
    setStatus(`错误: ${error.message}`);
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
    setStatus(`生成失败: ${error.message}`);
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
    setStatus(`错误: ${error.message}`);
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
      if (!result) throw new Error("后台无响应，请关闭弹窗后重试，或到 chrome://extensions 重新加载插件");
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

/* ── Polling ── */

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshStatus(), 3000);
}

void refreshStatus();
startPolling();
