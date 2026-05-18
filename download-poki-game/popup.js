const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const clearConfigBtn = document.getElementById("clearConfigBtn");
const scanMissingBtn = document.getElementById("scanMissingBtn");
const missingSummaryEl = document.getElementById("missingSummary");
const missingGamesGridEl = document.getElementById("missingGamesGrid");
const missingEmptyEl = document.getElementById("missingEmpty");
const useLocalSinkEl = document.getElementById("useLocalSink");
const sinkServerUrlEl = document.getElementById("sinkServerUrl");
const sinkOutputRootEl = document.getElementById("sinkOutputRoot");
const testSinkBtn = document.getElementById("testSinkBtn");

const SINK_SETTINGS_KEY = "pokiSinkSettings";
const DEFAULT_SERVER_URL = "http://127.0.0.1:22222";

/** 执行「检查未下载游戏」时的 Poki 标签页，用于点击头像在当前页跳转 */
let missingGamesTabId = null;

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

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}

function renderMissingGames(result, tabId) {
  if (!missingSummaryEl || !missingGamesGridEl || !missingEmptyEl) return;
  if (tabId != null) missingGamesTabId = tabId;

  const missing = result.missing || [];
  if (missing.length === 0) {
    missingSummaryEl.style.display = "none";
    missingGamesGridEl.style.display = "none";
    missingEmptyEl.style.display = "block";
    missingEmptyEl.textContent = `推荐区 ${result.totalOnPage || 0} 个游戏均已存在于输出目录。`;
    return;
  }

  missingEmptyEl.style.display = "none";
  missingSummaryEl.style.display = "block";
  missingSummaryEl.textContent = `共解析 ${result.totalOnPage} 个，未下载 ${missing.length} 个（输出: ${result.outputRoot}）`;

  missingGamesGridEl.style.display = "grid";
  missingGamesGridEl.innerHTML = missing
    .map((game) => {
      const title = escapeHtml(game.title || game.slug);
      const icon = game.iconUrl
        ? `<img src="${escapeHtml(game.iconUrl)}" alt="${title}" loading="lazy" />`
        : `<div style="width:56px;height:56px;border-radius:10px;background:#e5e7eb"></div>`;
      const portalUrl = game.portalUrl || "";
      return `<button type="button" class="missing-game-card" data-portal-url="${escapeHtml(portalUrl)}" title="${title}\n${escapeHtml(game.folder || game.slug || "")}">${icon}<span>${title}</span></button>`;
    })
    .join("");

  missingGamesGridEl.querySelectorAll(".missing-game-card").forEach((card) => {
    card.addEventListener("click", () => {
      const url = card.getAttribute("data-portal-url");
      if (!url) {
        setError("该游戏没有可跳转的 Poki 地址");
        return;
      }
      if (missingGamesTabId == null) {
        setError("未找到用于跳转的标签页，请重新执行「检查未下载游戏」");
        return;
      }
      void chrome.tabs.update(missingGamesTabId, { url }).then(() => window.close());
    });
  });
}

if (scanMissingBtn) {
  scanMissingBtn.addEventListener("click", async () => {
    scanMissingBtn.disabled = true;
    scanMissingBtn.textContent = "检查中...";
    if (missingGamesGridEl) missingGamesGridEl.style.display = "none";
    if (missingEmptyEl) missingEmptyEl.style.display = "none";
    if (missingSummaryEl) missingSummaryEl.style.display = "none";

    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error("未找到当前标签页。");

      await saveSinkSettings();
      const result = await chrome.runtime.sendMessage({
        type: "SCAN_MISSING_GAMES",
        tabId: tab.id,
        sinkSettings: getSinkSettings()
      });

      if (!result?.ok) throw new Error(result.error || "检查失败");
      renderMissingGames(result, tab.id);
      setStatus(
        `未下载 ${result.missingCount} / ${result.totalOnPage} 个\n点击头像在当前页跳转到游戏，再「开始监听」抓取。`
      );
    } catch (e) {
      setError(`检查失败: ${e.message}`);
    } finally {
      scanMissingBtn.disabled = false;
      scanMissingBtn.textContent = "检查未下载游戏";
    }
  });
}

void loadSinkSettings();
void refreshStatus();

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshStatus(), 3000);
}
startPolling();
