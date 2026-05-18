# poki-dl-server

`download-poki-game` 的本地落盘服务：扩展上报 CDN URL，服务检查文件是否已存在，存在则跳过，否则下载写入磁盘。

## 启动

```bash
# 仓库根目录
npm run poki-server

# 或本目录
cd tools/poki-dl-server && npm start
```

默认监听 `http://127.0.0.1:22222`。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `POKI_DL_PORT` | 端口 | `22222` |
| `POKI_DL_OUTPUT_ROOT` | 默认输出根目录 | 启动服务时的当前工作目录（`cwd`） |
| `POKI_DL_CONCURRENCY` | 并发下载数 | `12` |

## API

- `GET /health`
- `POST /api/session/start` — `{ gameName, outputRoot, relPrefix, pageUrl, gameUrl? }`
- `POST /api/assets/ingest` — 单条 `{ sessionId, sourceUrl?, relPath, body?, encoding? }`
- `POST /api/assets/ingest/batch` — 批量
- `POST /api/session/finish` — `{ sessionId, manifest? }`

## 扩展配置

在插件弹窗中：

1. 勾选「使用本地服务写盘」
2. 填写服务地址（默认 `http://127.0.0.1:22222`）
3. 填写输出根目录（例如 `/Users/you/work/chrome-extension`）

资源会保存到：`{输出根目录}/downloaded-games/{游戏名}/...`
