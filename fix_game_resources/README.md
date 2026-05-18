# Fix Game Resources（404 资源补全）

在本地运行 **download-poki-game** 下载的游戏时，监听页面 **404**，从远程 CDN 拉取缺失文件并写入与下载器相同的目录。

## 与 download-poki-game 配合使用

| 配置项 | download-poki-game | fix_game_resources |
|--------|-------------------|-------------------|
| 本地服务 | `npm run poki-server`（根目录） | **共用** |
| 输出根目录 | 弹窗「输出根目录」 | **共用** `pokiSinkSettings` |
| 游戏目录 | `downloaded-games/<游戏名>/` | 下载目录填 `downloaded-games`，游戏名一致 |

落盘路径：`{输出根目录}/<游戏名>/<相对路径>`

每次成功补全 404 资源后，会**合并写入**同目录下的 `assets-manifest.json`（不覆盖已有条目）。

例如输出根为 `/Users/you/work/chrome-extension/games` 时：

`games/downloaded-games/lips-diy-master/shadows/000.png`

## 使用步骤

1. **启动本地服务**（与 Poki 下载器相同）

```bash
npm run poki-server
```

2. **加载两个扩展**：`download-poki-game`、`fix_game_resources`

3. **用 download-poki-game 下载游戏**（或已有 `downloaded-games/<游戏名>/` 目录）

4. **本地起 HTTP 服务打开游戏**

```bash
cd games && python3 -m http.server 8090
# 访问 http://localhost:8090/downloaded-games/lips-diy-master/
```

5. **配置 fix_game_resources 弹窗**
   - 勾选「使用本地服务」
   - 输出根目录与 download-poki-game **相同**（如 `.../chrome-extension/games`）
   - 下载目录保持 `downloaded-games`

6. **开始监听**（在本地游戏目录页，如 `http://localhost:8090/downloaded-games/fashion-legends/`）
   - 自动读取该目录下 `assets-manifest.json` 的 `gameUrl`（去掉 query 参数）作为 CDN 根地址
   - 自动填入 `gameName`
   - 监听过程中切换至其他游戏页 URL 时，会再次自动同步
   - 刷新游戏页 → 404 自动补全到本地

## 说明

- 仅处理与**当前标签页同源**的 404（本地 `localhost` 上的游戏页）
- **CDN 根地址**：来自 `assets-manifest.json` 的 `gameUrl`（去掉 `/index.html`）
- 关闭「使用本地服务」时回退为 `chrome.downloads`（可能弹窗）
- 404 补全对 URL 下载使用 `overwrite: true`，确保能覆盖损坏/占位文件
