# Fix Game Resources（404 资源补全）

在本地运行已下载游戏（如 `download-mini-games/jelly-crush`、poki 游戏等）时，自动监听页面中的 **404 请求**，并从远程游戏域名拉取对应资源并保存到本地，实现缺失资源补全。sdsd

## 使用步骤

1. **加载插件**  
   在 Chrome 中打开 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择本目录 `fix_game_resources`。

2. **打开游戏页**  
   用本地服务器打开游戏（例如 `http://localhost:8083/jelly-crush/` 或 `http://localhost:8083/jelly-boom/`）。

3. **配置并保存**  
   点击插件图标，在弹窗中填写并保存：
   - **游戏域名**：远程资源根地址，如 `https://jelly-crush.apps.minigame.vip`
   - **下载目录**：本地保存的一级目录名，如 `download-mini-games`
   - **游戏名**（可选）：如 `jelly-crush`；不填则从当前页 URL 解析（如 `/jelly-crush/` → `jelly-crush`）

4. **触发 404 并查看列表**  
   在游戏页刷新或正常操作，让页面发起请求。出现 404 时，插件会记录**与当前页同源**的 404 地址。点击「刷新 404 列表」可更新列表。

5. **一键补全下载**  
   在弹窗中点击「一键补全下载」。插件会：
   - 用「游戏域名」+ 相对路径拼出远程 URL（如 `https://jelly-crush.apps.minigame.vip/res/ui/decorate_layer.json`）
   - 将文件下载到：**[Chrome 默认下载目录]/[下载目录]/[游戏名]/[相对路径]**  
   例如：`~/Downloads/download-mini-games/jelly-crush/res/ui/decorate_layer.json`。

6. **查看失败项**  
   若某资源下载失败，会在弹窗下方「下载失败的资源」中列出，包含**请求地址**和错误信息，便于排查或手动补下。

## 示例

- 游戏域名：`https://jelly-crush.apps.minigame.vip`
- 下载目录：`download-mini-games`
- 当前窗口：`http://localhost:8083/jelly-crush/`
- 插件检测到 404：`http://localhost:8083/jelly-crush/res/ui/decorate_layer.json`

则插件会从 `https://jelly-crush.apps.minigame.vip/res/ui/decorate_layer.json` 下载，并保存到  
`[下载目录]/jelly-crush/res/ui/decorate_layer.json`（相对于 Chrome 默认下载目录）。

## 说明

- 仅记录并处理与**当前标签页同源**的 404 请求（同一 host）。
- 相对路径由当前页 URL 与 404 请求 URL 的 path 推算得出。
- 适用于 minigame、poki 等本地运行游戏的资源补全场景。
