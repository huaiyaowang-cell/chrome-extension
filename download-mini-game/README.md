# download-mini-game

Chrome 插件（Manifest V3），用于在 minigame.com 游戏页面实时监听并下载：

- `game.html`（对应 `id="playIframe"` 的 iframe 页面）
- iframe 中引用的核心资源（js/css/wasm/data/图片/音频/字体等）

## 使用方法

1. 打开 Chrome 扩展管理页 `chrome://extensions/`
2. 开启「开发者模式」
3. 选择「加载已解压的扩展程序」，选中本目录
4. 打开游戏页，例如：
   - <https://www.minigame.com/en/game/jelly-crush/play/m>
5. 在刷新前点击插件按钮，选择「开始监听当前标签页」
6. 刷新页面并正常进入游戏
7. 插件会实时监听当前标签页的核心请求并持续下载
8. 游戏加载完成后，点击「抓取页面 HTML」
9. 完成后点击「停止监听并写入清单」

## 下载目录

插件使用下载路径前缀：`download-mini-games/<game-name>/`

例如 `jelly-crush` 会输出：

- `download-mini-games/jelly-crush/game.html`
- `download-mini-games/jelly-crush/assets-manifest.json`
- `download-mini-games/jelly-crush/minigame.js`
- `download-mini-games/jelly-crush/game.min.js`
- `download-mini-games/jelly-crush/...`

其中 `assets-manifest.json` 记录每个资源的：

- 原始地址 `sourceUrl`
- 本地路径 `localPath`
- 下载状态 `status`（`ok` / `failed`）

## 页面结构

minigame.com 的游戏运行在 `id="playIframe"` 的 iframe 中：

```
主页面: https://www.minigame.com/en/game/{game-name}/play/m
  └── iframe#playIframe: https://{game-name}.apps.minigame.vip/minigame-index.html
        └── 游戏内容（Canvas、脚本、资源等）
```

游戏名从 URL 路径 `/game/{game-name}/` 中自动提取。

## 监听范围

插件会优先监听并下载这些更接近游戏核心的资源：

- `game.html`（iframe 内容）
- `js` / `mjs` / `css`
- `json` / `wasm` / `data` / `unityweb` / `bundle` / `mem`
- 来自 `*.apps.minigame.vip` 域名的所有请求

默认会过滤广告、统计、追踪类请求（Google Analytics、GTM 等）。

## 支持的游戏引擎

自动检测并适配：Cocos2d、Unity、Defold、Construct、Godot、GameMaker、Phaser、PixiJS、PlayCanvas、CreateJS。

> 注意：Chrome 扩展无法直接写入任意绝对路径。  
> 若你希望落到 `/Users/neptune/Downloads/download-mini-games`，请将 Chrome 的默认下载目录设置为 `/Users/neptune/Downloads`。
