const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const exportConfigBtn = document.getElementById("exportConfigBtn");
const importConfigBtn = document.getElementById("importConfigBtn");
const importFileEl = document.getElementById("importFile");
const clearConfigBtn = document.getElementById("clearConfigBtn");
const useLocalSinkEl = document.getElementById("useLocalSink");
const sinkServerUrlEl = document.getElementById("sinkServerUrl");
const sinkOutputRootEl = document.getElementById("sinkOutputRoot");
const testSinkBtn = document.getElementById("testSinkBtn");

const SINK_SETTINGS_KEY = "pokiSinkSettings";
const DEFAULT_SERVER_URL = "http://127.0.0.1:22222";

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
    "状态: 监听中（换游戏页 URL 会自动切换抓取）",
    `游戏: ${result.gameName}`,
    gameLine,
    `写盘: ${result.sinkMode === "local-server" ? "本地服务" : "Chrome 下载"}`,
    `已下载: ${s.downloaded || 0}`,
    `已跳过: ${s.skipped || 0}`,
    `失败: ${s.failed || 0}`,
    `总请求: ${s.totalSeen || 0}`,
    `文件数: ${result.fileCount || 0}`,
    `HTML: ${htmlLine}`,
    `页面信息: ${result.portalInfoSaved ? "__info_assets__ ✓" : "抓取中…"}`,
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

function getSinkSettings() {
  return {
    enabled: !!useLocalSinkEl?.checked,
    serverUrl: (sinkServerUrlEl?.value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, ""),
    outputRoot: (sinkOutputRootEl?.value || "").trim()
  };
}

function saveSinkSettings() {
  return chrome.storage.local.set({ [SINK_SETTINGS_KEY]: getSinkSettings() });
}

async function loadSinkSettings() {
  const stored = await chrome.storage.local.get(SINK_SETTINGS_KEY);
  const sink = stored[SINK_SETTINGS_KEY] || {};
  if (useLocalSinkEl) useLocalSinkEl.checked = sink.enabled !== false;
  if (sinkServerUrlEl) sinkServerUrlEl.value = sink.serverUrl || DEFAULT_SERVER_URL;
  if (sinkOutputRootEl && sink.outputRoot) sinkOutputRootEl.value = sink.outputRoot;
}

if (useLocalSinkEl) useLocalSinkEl.addEventListener("change", () => void saveSinkSettings());
if (sinkServerUrlEl) sinkServerUrlEl.addEventListener("blur", () => void saveSinkSettings());
if (sinkOutputRootEl) sinkOutputRootEl.addEventListener("blur", () => void saveSinkSettings());

async function probeLocalServer() {
  const sink = getSinkSettings();
  await saveSinkSettings();
  if (!sink.enabled) {
    return { ok: true, message: "已关闭本地服务，将使用 Chrome 下载" };
  }
  const base = sink.serverUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/health`);
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  if (!sink.outputRoot) {
    return { ok: true, message: `服务正常（${base}）\n请填写「输出根目录」` };
  }
  return { ok: true, message: `本地服务正常\n${base}\n输出: ${sink.outputRoot}` };
}

if (testSinkBtn) {
  testSinkBtn.addEventListener("click", async () => {
    testSinkBtn.disabled = true;
    testSinkBtn.textContent = "检测中...";
    try {
      await saveSinkSettings();
      const result = await probeLocalServer();
      setStatus(result.message || "本地服务正常");
    } catch (e) {
      const msg = e?.message || String(e);
      setError(
        `本地服务不可用: ${msg}\n\n请执行: npm run poki-server\n服务地址: ${sinkServerUrlEl?.value || DEFAULT_SERVER_URL}`
      );
    } finally {
      testSinkBtn.disabled = false;
      testSinkBtn.textContent = "检测本地服务";
    }
  });
}

clearConfigBtn.addEventListener("click", () => {
  if (sinkServerUrlEl) sinkServerUrlEl.value = DEFAULT_SERVER_URL;
  if (sinkOutputRootEl) sinkOutputRootEl.value = "";
  if (useLocalSinkEl) useLocalSinkEl.checked = true;
  void saveSinkSettings();
  setStatus("本地服务配置已重置。");
});

startBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在开启监听...");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");

    await saveSinkSettings();
    const sinkSettings = getSinkSettings();
    if (sinkSettings.enabled && !sinkSettings.outputRoot) {
      throw new Error("请填写「输出根目录」后再开始监听。");
    }

    const result = await chrome.runtime.sendMessage({
      type: "START_MONITOR",
      tabId: tab.id,
      sinkSettings
    });

    if (!result) throw new Error("后台无响应，请在 chrome://extensions/ 重新加载插件。");
    if (!result.ok) throw new Error(result.error || "开启监听失败。");

    let sinkLine = "\n写盘: Chrome 下载（可能弹窗，建议启用本地服务）";
    if (result.sinkMode === "local-server") {
      sinkLine = `\n写盘: 本地服务 → ${sinkSettings.outputRoot}/${result.folder}/`;
    }
    setStatus(
      `监听已开启！\n游戏: ${result.gameName}\n目录: ${result.folder}/${sinkLine}\n\n请现在刷新页面，进入游戏。\n检测到游戏后资源将自动下载。`
    );
    updateButtons("listening");
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
      tabId: tab.id,
      force: true
    });

    if (!result) throw new Error("后台无响应。");
    if (!result.ok) throw new Error(result.error || "生成失败。");

    setStatus(result.skipped ? result.message : `生成成功！\n${result.message}`);
  } catch (error) {
    setError(`生成失败: ${error.message}`);
  } finally {
    captureBtn.textContent = "重新生成 HTML";
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

    const result = await chrome.runtime.sendMessage({
      type: "EXPORT_CONFIG",
      config: { gameName, folder },
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
    const config = JSON.parse(await file.text());
    setStatus(`已导入配置，游戏: ${config.gameName || "-"}，目录: ${config.folder || "-"}`);
  } catch (err) {
    setError(`导入失败: ${err.message}`);
  }
});

void loadSinkSettings();
void refreshStatus();

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshStatus(), 3000);
}
startPolling();
