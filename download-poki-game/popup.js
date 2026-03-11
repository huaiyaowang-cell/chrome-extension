const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
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

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshStatus(), 3000);
}

void refreshStatus();
startPolling();
