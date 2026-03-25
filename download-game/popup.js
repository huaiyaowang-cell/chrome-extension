const CONFIG_KEY = "downloadGameExtensionConfig";

const platformEl = document.getElementById("platform");
const gameUrlEl = document.getElementById("gameUrl");
const listenListEl = document.getElementById("listenList");
const addListenBtn = document.getElementById("addListenBtn");
const downloadDirEl = document.getElementById("downloadDir");
const gameNameEl = document.getElementById("gameName");
const manualResourceListEl = document.getElementById("manualResourceList");
const addResourceBtn = document.getElementById("addResourceBtn");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const exportConfigBtn = document.getElementById("exportConfigBtn");
const importConfigBtn = document.getElementById("importConfigBtn");
const importFileEl = document.getElementById("importFile");

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("error");
}

function setError(text) {
  statusEl.textContent = text;
  statusEl.classList.add("error");
}

function defaultListenFromGameUrl(gameUrl) {
  try {
    const u = new URL(gameUrl.trim());
    let p = u.pathname;
    if (/\.html?$/i.test(p)) p = p.replace(/\/[^/]+$/, "");
    p = p.replace(/\/+$/, "") || "/";
    return u.origin + (p === "/" ? "" : p);
  } catch {
    return "";
  }
}

function getListenUrls() {
  const inputs = listenListEl.querySelectorAll(".listen-row input");
  return Array.from(inputs)
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function getManualResourceUrls() {
  const inputs = manualResourceListEl.querySelectorAll(".resource-row input");
  return Array.from(inputs)
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function getFormConfig() {
  return {
    platform: platformEl.value,
    gameUrl: gameUrlEl.value.trim(),
    listenUrls: getListenUrls(),
    downloadDir: downloadDirEl.value.trim(),
    gameName: gameNameEl.value.trim(),
    manualResourceUrls: getManualResourceUrls()
  };
}

function validateFormForStart() {
  const c = getFormConfig();
  if (!c.gameUrl.startsWith("http")) throw new Error("请填写有效的游戏 URL。");
  if (!c.downloadDir) throw new Error("请填写下载目录。");
  if (!c.gameName) throw new Error("请填写游戏名称。");
  return c;
}

async function saveConfigToStorage() {
  const c = getFormConfig();
  await chrome.storage.local.set({ [CONFIG_KEY]: c });
  setStatus("配置已保存到本机。");
}

async function loadConfigFromStorage() {
  const { [CONFIG_KEY]: stored } = await chrome.storage.local.get(CONFIG_KEY);
  if (!stored) {
    if (listenListEl.children.length === 0) addListenRow("");
    if (manualResourceListEl.children.length === 0) addResourceRow("");
    return;
  }
  platformEl.value = stored.platform || "crazygames";
  gameUrlEl.value = stored.gameUrl || "";
  downloadDirEl.value = stored.downloadDir || "downloaded-games";
  gameNameEl.value = stored.gameName || "";

  listenListEl.innerHTML = "";
  const listens = Array.isArray(stored.listenUrls) ? stored.listenUrls : [];
  if (listens.length === 0) addListenRow("");
  else listens.forEach((u) => addListenRow(typeof u === "string" ? u : ""));

  manualResourceListEl.innerHTML = "";
  const res = Array.isArray(stored.manualResourceUrls) ? stored.manualResourceUrls : [];
  if (res.length === 0) addResourceRow("");
  else res.forEach((u) => addResourceRow(typeof u === "string" ? u : ""));
}

function addListenRow(value = "") {
  const row = document.createElement("div");
  row.className = "listen-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://…";
  input.value = value;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "删除";
  rm.addEventListener("click", () => {
    row.remove();
    void saveConfigToStorage();
  });
  row.appendChild(input);
  row.appendChild(rm);
  listenListEl.appendChild(row);
}

function addResourceRow(value = "") {
  const row = document.createElement("div");
  row.className = "resource-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://…";
  input.value = value;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "删除";
  rm.addEventListener("click", () => {
    row.remove();
    void saveConfigToStorage();
  });
  row.appendChild(input);
  row.appendChild(rm);
  manualResourceListEl.appendChild(row);
}

addListenBtn.addEventListener("click", () => {
  addListenRow("");
  void saveConfigToStorage();
});

addResourceBtn.addEventListener("click", () => {
  addResourceRow("");
  void saveConfigToStorage();
});

gameUrlEl.addEventListener("blur", () => {
  const inputs = listenListEl.querySelectorAll(".listen-row input");
  if (inputs.length === 1 && !inputs[0].value.trim()) {
    const d = defaultListenFromGameUrl(gameUrlEl.value);
    if (d) inputs[0].value = d;
  }
  void saveConfigToStorage();
});

listenListEl.addEventListener(
  "blur",
  () => {
    void saveConfigToStorage();
  },
  true
);

manualResourceListEl.addEventListener(
  "blur",
  () => {
    void saveConfigToStorage();
  },
  true
);

[platformEl, downloadDirEl, gameNameEl].forEach((el) => {
  el.addEventListener("change", () => void saveConfigToStorage());
});

saveConfigBtn.addEventListener("click", () => {
  void saveConfigToStorage().catch((e) => setError(String(e.message)));
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function updateButtons(state) {
  const listening = state === "listening";
  startBtn.disabled = listening;
  startBtn.textContent = listening ? "监听中…" : "开始监听";
  captureBtn.disabled = !listening;
  stopBtn.disabled = !listening;
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
    if (!result?.ok) return;
    if (result.status === "idle" || result.status === "stopped") {
      if (result.status === "stopped") {
        const s = result.stats || {};
        setStatus(
          `已停止\n平台: ${result.platform || "-"}\n游戏: ${result.gameName}\n已下载: ${s.downloaded || 0}\n目录: ${result.folder}/`
        );
      } else {
        setStatus("未在监听。填写表单后点「开始监听」，然后刷新当前标签页加载游戏。");
      }
      updateButtons("idle");
      return;
    }
    const s = result.stats || {};
    setStatus(
      [
        "状态: 监听中",
        `平台: ${result.platform}`,
        `游戏: ${result.gameName}`,
        `域名: ${result.gameHost || "-"}`,
        `监听前缀数: ${result.listenCount ?? "-"}`,
        `已下载: ${s.downloaded || 0} 失败: ${s.failed || 0}`,
        `HTML 缓存条目: ${result.networkCacheSize ?? 0}（含入口页）`,
        `入口 HTML: ${result.htmlCaptured ? "已生成" : "未生成"}`,
        `目录: ${result.folder}/`
      ].join("\n")
    );
    updateButtons("listening");
  } catch {
    setError("无法连接后台，请在 chrome://extensions 重新加载本扩展。");
  }
}

startBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在开启监听…");
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");
    const config = validateFormForStart();
    const result = await chrome.runtime.sendMessage({
      type: "START_MONITOR",
      tabId: tab.id,
      config
    });
    if (!result?.ok) throw new Error(result?.error || "开启失败");
    await saveConfigToStorage();
    setStatus(
      `监听已开启\n目录: ${result.folder}/\n\n当前标签页将自动刷新；请加载游戏以抓取资源。\n（须允许本扩展附加调试器）`
    );
    updateButtons("listening");
    try {
      chrome.runtime.connect({ name: "keepalive" });
    } catch (_) {}
  } catch (e) {
    setError(`错误: ${e.message}`);
    updateButtons("idle");
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "生成中…";
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");
    const result = await chrome.runtime.sendMessage({
      type: "CAPTURE_HTML",
      tabId: tab.id
    });
    if (!result?.ok) throw new Error(result?.error || "生成失败");
    setStatus(`生成成功\n${result.message}`);
  } catch (e) {
    setError(`生成失败: ${e.message}`);
  } finally {
    captureBtn.textContent = "生成 HTML";
    await refreshStatus();
  }
});

stopBtn.addEventListener("click", async () => {
  updateButtons("disabled");
  setStatus("正在停止…");
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");
    const result = await chrome.runtime.sendMessage({
      type: "STOP_MONITOR",
      tabId: tab.id
    });
    if (!result?.ok) throw new Error(result?.error || "停止失败");
    if (result.warnings?.length) {
      setStatus(
        `已停止\n游戏: ${result.gameName}\n\n警告:\n${result.warnings.join("\n")}`
      );
    }
  } catch (e) {
    setError(`错误: ${e.message}`);
  } finally {
    updateButtons("idle");
    await refreshStatus();
  }
});

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
    button.textContent = "…";
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error("未找到标签页");
      const result = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_ASSET",
        tabId: tab.id,
        url,
        assetKey: key
      });
      if (!result?.ok) throw new Error(result?.error || "下载失败");
      button.textContent = "✓";
      setTimeout(() => {
        button.textContent = "下载";
        button.disabled = false;
      }, 1200);
    } catch (e) {
      button.textContent = "✗";
      setError(`附加资源: ${e.message}`);
      setTimeout(() => {
        button.textContent = "下载";
        button.disabled = false;
      }, 2000);
    }
  });
}

exportConfigBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("未找到当前标签页。");
    const statusResult = await chrome.runtime.sendMessage({
      type: "GET_MONITOR_STATUS",
      tabId: tab.id
    });
    if (!statusResult?.ok) throw new Error("无法获取状态");
    const folder = statusResult.folder;
    if (!folder) throw new Error("尚无游戏目录，请先开始监听一次。");
    const config = getFormConfig();
    const result = await chrome.runtime.sendMessage({
      type: "EXPORT_CONFIG",
      config,
      folder
    });
    if (!result?.ok) throw new Error(result?.error || "导出失败");
    setStatus(`已导出: ${result.filename}`);
  } catch (e) {
    setError(`导出失败: ${e.message}`);
  }
});

importConfigBtn.addEventListener("click", () => importFileEl.click());

importFileEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const j = JSON.parse(text);
    if (j.platform) platformEl.value = j.platform;
    if (j.gameUrl != null) gameUrlEl.value = j.gameUrl;
    if (j.downloadDir != null) downloadDirEl.value = j.downloadDir;
    if (j.gameName != null) gameNameEl.value = j.gameName;
    listenListEl.innerHTML = "";
    const lu = Array.isArray(j.listenUrls) ? j.listenUrls : [];
    if (lu.length === 0) addListenRow("");
    else lu.forEach((u) => addListenRow(String(u)));
    manualResourceListEl.innerHTML = "";
    const mr = Array.isArray(j.manualResourceUrls) ? j.manualResourceUrls : [];
    if (mr.length === 0) addResourceRow("");
    else mr.forEach((u) => addResourceRow(String(u)));
    await saveConfigToStorage();
    setStatus("已从 JSON 导入配置。");
  } catch (err) {
    setError(`导入失败: ${err.message}`);
  }
});

void loadConfigFromStorage();
void refreshStatus();
setInterval(() => void refreshStatus(), 4000);
