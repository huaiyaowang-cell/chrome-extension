# download-poki-game

Chrome 插件（Manifest V3），用于在 Poki 游戏页面实时监听并下载：

- `index.html`（对应 `id="game-element"` 的 iframe 页面）
- `game.html`（对应 `id="gameframe"` 的 iframe 页面）
- 两个页面中引用的核心资源（js/css/unityweb/data/wasm 等）

## 使用方法

### 本地写盘服务（推荐，无下载弹窗）

1. 启动本地服务（只需一次，保持运行）：

```bash
# 在仓库根目录（推荐）
npm run poki-server

# 或
cd tools/poki-dl-server && npm start
```

2. 在插件弹窗中勾选「使用本地服务写盘」，填写：
   - **服务地址**：`http://127.0.0.1:22222`（默认）
   - **输出根目录**：例如 `/Users/you/work/chrome-extension`（绝对路径）
3. 点击「检测本地服务」确认连接正常。

服务会在写盘前检查文件是否已存在：**已存在则跳过**，不存在才从 CDN 下载。

### 抓取游戏

1. 打开 Chrome 扩展管理页 `chrome://extensions/`
2. 开启「开发者模式」
3. 选择「加载已解压的扩展程序」，选中本目录
4. 打开游戏页，例如：
   - <https://poki.com/zh/g/happy-glass#fullscreen>
5. 在刷新前点击插件按钮，选择「开始监听当前标签页」
6. 刷新页面并正常进入游戏
7. 插件会实时监听当前标签页的核心请求并持续下载
8. 检测到 gameframe 且 HTML 已进入网络缓存后，会**自动生成** `index.html`（本地已有则跳过）
9. 完成后点击「停止监听并写入清单」

## 下载目录

插件使用下载路径前缀：`downloaded-games/<game-name>/`

例如 `happy-glass` 会输出：

- `downloaded-games/happy-glass/index.html`
- `downloaded-games/happy-glass/game.html`
- `downloaded-games/happy-glass/assets-manifest.json`
- `downloaded-games/happy-glass/assets/...`

开始监听后还会抓取 Poki 入口页信息，写入 `{游戏名}/__info_assets__/`：

- `meta.json` — 标题、开发商、评分、投票、Like/Dislike、描述小节、FAQ、表格等
- `article.html` — `article` 元素 HTML 快照
- `icon.*` — 来自 `og:image` 的游戏图标

`assets-manifest.json` 会在下载过程中**自动合并写入**（约每 3 秒，或停止监听时）；多次写入会按 `localPath` / `sourceUrl` 合并条目，不会整文件覆盖丢失历史。

每条资源记录包含：

- `sourceUrl` — CDN 原始地址（用于按清单重新下载）
- `localPath` — 相对游戏目录的路径
- `status` — `ok` / `failed`
- 可选 `requestType`、`updatedAt` 等

顶层字段 `gameUrl` 为游戏 CDN 根地址，供 **fix_game_resources** 补全 404 时使用。

## 404 资源补全

本地运行游戏后若仍有 404，请配合 **fix_game_resources** 扩展：共用同一 `npm run poki-server` 与输出根目录，在弹窗点「读 manifest」填充 CDN 地址后开始监听即可。详见 `fix_game_resources/README.md`。

## 监听范围

插件会优先监听并下载这些更接近游戏核心的资源：

- `index.html` 与 `game.html`
- `js` / `mjs` / `css`
- `json` / `wasm` / `data` / `unityweb` / `bundle` / `mem`
- 路径中包含 `Build/`、`loader`、`poki-sdk` 的请求

默认会过滤广告、统计、追踪类请求。

> **本地服务模式**：资源写到 `{输出根目录}/downloaded-games/<游戏名>/`，不经过 Chrome 下载，无弹窗。  
> **回退模式**（取消勾选本地服务）：仍使用 `chrome.downloads`，需关闭 Chrome「下载前询问保存位置」，并将默认下载目录设为输出根目录。

分支版本：
craw-with-local-server：本地服务器版本
