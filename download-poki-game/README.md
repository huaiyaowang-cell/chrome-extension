# download-poki-game

Chrome 插件（Manifest V3），用于在 Poki 游戏页面实时监听并下载：

- `index.html`（对应 `id="game-element"` 的 iframe 页面）
- `game.html`（对应 `id="gameframe"` 的 iframe 页面）
- 两个页面中引用的核心资源（js/css/unityweb/data/wasm 等）

## 使用方法

1. 打开 Chrome 扩展管理页 `chrome://extensions/`
2. 开启「开发者模式」
3. 选择「加载已解压的扩展程序」，选中本目录
4. 打开游戏页，例如：
   - <https://poki.com/zh/g/happy-glass#fullscreen>
5. 在刷新前点击插件按钮，选择「开始监听当前标签页」
6. 刷新页面并正常进入游戏
7. 插件会实时监听当前标签页的核心请求并持续下载
8. 完成后点击「停止监听并写入清单」

## 下载目录

插件使用下载路径前缀：`downloaded-games/<game-name>/`

例如 `happy-glass` 会输出：

- `downloaded-games/happy-glass/index.html`
- `downloaded-games/happy-glass/game.html`
- `downloaded-games/happy-glass/assets-manifest.json`
- `downloaded-games/happy-glass/assets/...`

其中 `assets-manifest.json` 记录每个资源的：

- 原始地址 `sourceUrl`
- 本地路径 `localPath`
- 下载状态 `status`（`ok` / `failed`）

## 监听范围

插件会优先监听并下载这些更接近游戏核心的资源：

- `index.html` 与 `game.html`
- `js` / `mjs` / `css`
- `json` / `wasm` / `data` / `unityweb` / `bundle` / `mem`
- 路径中包含 `Build/`、`loader`、`poki-sdk` 的请求

默认会过滤广告、统计、追踪类请求。

> 注意：Chrome 扩展无法直接写入任意绝对路径。  
> 若你希望落到 `/Users/neptune/work/rabigame/chrome-extension/downloaded-games`，请将 Chrome 的默认下载目录设置为 `/Users/neptune/work/rabigame/chrome-extension`。
