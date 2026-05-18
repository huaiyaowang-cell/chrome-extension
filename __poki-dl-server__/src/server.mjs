#!/usr/bin/env node
/**
 * Local asset ingest server for download-poki-game.
 * Bind 127.0.0.1 only. Extension POSTs CDN URLs; server skips existing files.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.POKI_DL_PORT || 22222);
const HOST = "127.0.0.1";
/** 与 `npm run poki-server` 启动时的工作目录一致（不追加 games） */
const DEFAULT_OUTPUT_ROOT =
  process.env.POKI_DL_OUTPUT_ROOT || path.resolve(process.cwd());
const CONCURRENCY = Number(process.env.POKI_DL_CONCURRENCY || 12);
const MIN_FILE_BYTES = Number(process.env.POKI_DL_MIN_BYTES || 1);

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Map<string, DownloadJob>} */
const jobs = new Map();
let jobSeq = 0;

/** @type {DownloadJob[]} */
const jobQueue = [];
let activeDownloads = 0;

/** 同 session 同路径的并发下载合并为一次 */
/** @type {Map<string, Promise<object>>} */
const pathDownloadInflight = new Map();

/**
 * @typedef {object} Session
 * @property {string} sessionId
 * @property {string} gameName
 * @property {string} outputRoot
 * @property {string} relPrefix
 * @property {string} gameDir
 * @property {string} pageUrl
 * @property {string} referer
 * @property {string} gameUrl
 * @property {number} downloaded
 * @property {number} skipped
 * @property {number} failed
 */

const LOG_URL_MAX = Number(process.env.POKI_DL_LOG_URL_MAX || 96);
const LOG_INGEST = process.env.POKI_DL_LOG_INGEST !== "0";

function log(...args) {
  console.log(`[poki-dl-server]`, ...args);
}

function truncateUrl(url, max = LOG_URL_MAX) {
  if (!url) return "";
  const s = String(url);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @param {Session} session
 * @param {string} sourceUrl
 * @param {string} absPath
 * @param {object} result
 */
function logIngestResult(session, sourceUrl, absPath, result) {
  if (!LOG_INGEST) return;
  const status = String(result.status || "?").toUpperCase();
  const rel = result.relPath || path.relative(session.gameDir, absPath);
  const size = formatBytes(result.bytes);
  const line = [
    status.padEnd(7),
    rel,
    "→",
    absPath,
    size ? `(${size})` : "",
    sourceUrl ? `<- ${truncateUrl(sourceUrl)}` : "[inline body]"
  ]
    .filter(Boolean)
    .join(" ");
  const extra = [];
  if (result.reason) extra.push(`reason=${result.reason}`);
  if (result.wrote) extra.push(`wrote=${result.wrote}`);
  if (result.error) extra.push(`error=${result.error}`);
  log(extra.length ? `${line} | ${extra.join(" ")}` : line);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data)
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeResolve(gameDir, relPath) {
  const normalized = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("invalid relPath");
  }
  const abs = path.resolve(gameDir, normalized);
  const base = path.resolve(gameDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error("path escape");
  }
  return { abs, relPath: normalized };
}

async function fileExists(absPath) {
  try {
    const st = await fs.stat(absPath);
    return st.isFile() && st.size >= MIN_FILE_BYTES;
  } catch {
    return false;
  }
}

function manifestFileKey(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.localPath) return `path:${entry.localPath}`;
  if (entry.sourceUrl) return `url:${entry.sourceUrl}`;
  return null;
}

/** 合并 assets-manifest.json（与扩展 assets-manifest-lib.js 逻辑一致） */
function mergeManifestOnDisk(existing, incoming) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const next = incoming && typeof incoming === "object" ? incoming : {};
  const fileMap = new Map();
  for (const f of prev.files || []) {
    const key = manifestFileKey(f);
    if (key) fileMap.set(key, { ...f });
  }
  for (const f of next.files || []) {
    const key = manifestFileKey(f);
    if (!key) continue;
    const old = fileMap.get(key) || {};
    fileMap.set(key, {
      ...old,
      ...f,
      updatedAt: f.updatedAt || new Date().toISOString()
    });
  }
  const files = [...fileMap.values()];
  const stats = { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 };
  for (const f of files) {
    stats.totalSeen += 1;
    if (f.status === "failed") stats.failed += 1;
    else if (f.skipped) stats.skipped += 1;
    else stats.downloaded += 1;
  }
  return {
    manifestVersion: 1,
    ...prev,
    ...next,
    gameName: next.gameName || prev.gameName || "",
    gameUrl: next.gameUrl || prev.gameUrl || "",
    pageUrl: next.pageUrl || prev.pageUrl || "",
    portalInfo: next.portalInfo !== undefined ? next.portalInfo : prev.portalInfo ?? null,
    engine: next.engine || prev.engine || "",
    startedAt: prev.startedAt || next.startedAt || "",
    stoppedAt: next.stoppedAt || prev.stoppedAt || "",
    status: next.status || prev.status || "",
    updatedAt: new Date().toISOString(),
    stats,
    files
  };
}

async function readTextFile(absPath) {
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) return { exists: false };
    const content = await fs.readFile(absPath, "utf8");
    return { exists: true, bytes: st.size, content };
  } catch {
    return { exists: false };
  }
}

async function writeBody(absPath, body, encoding) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  if (encoding === "base64") {
    await fs.writeFile(tmp, Buffer.from(body, "base64"));
  } else {
    await fs.writeFile(tmp, body, encoding === "utf8" ? "utf8" : undefined);
  }
  await fs.rename(tmp, absPath);
}

/**
 * @param {Session} session
 * @param {string} sourceUrl
 * @param {string} absPath
 */
async function downloadToFile(session, sourceUrl, absPath) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  if (session.referer) headers.Referer = session.referer;
  else if (session.gameUrl) headers.Referer = session.gameUrl;

  const res = await fetch(sourceUrl, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${sourceUrl.slice(0, 120)}`);
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  if (res.body) {
    await pipeline(res.body, createWriteStream(tmp));
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(tmp, buf);
  }
  await fs.rename(tmp, absPath);
  const st = await fs.stat(absPath);
  return st.size;
}

function pumpQueue() {
  while (activeDownloads < CONCURRENCY && jobQueue.length > 0) {
    const job = jobQueue.shift();
    if (!job) break;
    activeDownloads += 1;
    void runJob(job).finally(() => {
      activeDownloads -= 1;
      pumpQueue();
    });
  }
}

/**
 * @param {DownloadJob} job
 */
async function runJob(job) {
  const session = sessions.get(job.sessionId);
  if (!session) {
    job.resolve({ status: "failed", error: "session not found" });
    return;
  }
  try {
    const bytes = await downloadToFile(session, job.sourceUrl, job.absPath);
    session.downloaded += 1;
    job.resolve({ status: "ok", bytes, absPath: job.absPath });
  } catch (e) {
    session.failed += 1;
    job.resolve({ status: "failed", error: String(e.message || e) });
  } finally {
    jobs.delete(job.jobId);
  }
}

/**
 * @typedef {object} DownloadJob
 * @property {string} jobId
 * @property {string} sessionId
 * @property {string} sourceUrl
 * @property {string} absPath
 * @property {(r: object) => void} resolve
 */

function enqueueDownload(session, sourceUrl, absPath) {
  const key = `${session.sessionId}\0${absPath}`;
  const existing = pathDownloadInflight.get(key);
  if (existing) return existing;

  const promise = new Promise((resolve) => {
    const jobId = `j${++jobSeq}`;
    const job = { jobId, sessionId: session.sessionId, sourceUrl, absPath, resolve };
    jobs.set(jobId, job);
    jobQueue.push(job);
    pumpQueue();
  }).finally(() => {
    pathDownloadInflight.delete(key);
  });

  pathDownloadInflight.set(key, promise);
  return promise;
}

/**
 * @param {Session} session
 * @param {object} item
 */
async function ingestOne(session, item) {
  const { relPath: safeRel, abs } = safeResolve(session.gameDir, item.relPath);
  const sourceUrl = item.sourceUrl && String(item.sourceUrl).startsWith("http")
    ? String(item.sourceUrl)
    : "";
  let result;

  if (item.body != null && item.body !== "") {
    const enc = item.encoding === "base64" ? "base64" : "utf8";
    const overwrite = !!item.overwrite;
    if (!overwrite && (await fileExists(abs))) {
      session.skipped += 1;
      const st = await fs.stat(abs).catch(() => null);
      result = {
        relPath: safeRel,
        status: "skipped",
        reason: "exists",
        bytes: st?.size
      };
    } else {
      await writeBody(abs, item.body, enc);
      session.downloaded += 1;
      const st = await fs.stat(abs);
      result = {
        relPath: safeRel,
        status: "ok",
        bytes: st.size,
        wrote: overwrite ? "body-overwrite" : "body"
      };
    }
  } else if (!sourceUrl) {
    session.failed += 1;
    result = { relPath: safeRel, status: "failed", error: "missing sourceUrl" };
  } else {
    const overwrite = !!item.overwrite;
    if (!overwrite && (await fileExists(abs))) {
      session.skipped += 1;
      const st = await fs.stat(abs);
      result = {
        relPath: safeRel,
        status: "skipped",
        reason: "exists",
        bytes: st.size
      };
    } else {
      const dl = await enqueueDownload(session, sourceUrl, abs);
      result = { relPath: safeRel, ...dl };
    }
  }

  logIngestResult(session, sourceUrl, abs, result);
  return result;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}`);
  const method = req.method || "GET";

  try {
    if (method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        version: "1.1.0",
        port: PORT,
        defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
        sessions: sessions.size,
        queue: jobQueue.length,
        activeDownloads,
        features: { listGameDirs: true }
      });
    }

    if (method === "POST" && url.pathname === "/api/output/list-game-dirs") {
      const body = await readJson(req);
      const outputRoot = path.resolve(
        String(body.outputRoot || DEFAULT_OUTPUT_ROOT).trim()
      );
      let dirs = [];
      try {
        const entries = await fs.readdir(outputRoot, { withFileTypes: true });
        dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      return json(res, 200, { ok: true, outputRoot, dirs });
    }

    if (method === "POST" && url.pathname === "/api/session/start") {
      const body = await readJson(req);
      const gameName = String(body.gameName || "poki-game").trim();
      const outputRoot = path.resolve(
        String(body.outputRoot || DEFAULT_OUTPUT_ROOT).trim()
      );
      const relPrefix = String(body.relPrefix || gameName)
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      const gameDir = path.join(outputRoot, relPrefix);
      const sessionId = `sess_${randomBytes(8).toString("hex")}`;
      /** @type {Session} */
      const session = {
        sessionId,
        gameName,
        outputRoot,
        relPrefix,
        gameDir,
        pageUrl: String(body.pageUrl || ""),
        referer: String(body.referer || body.pageUrl || ""),
        gameUrl: String(body.gameUrl || ""),
        downloaded: 0,
        skipped: 0,
        failed: 0
      };
      await fs.mkdir(gameDir, { recursive: true });
      sessions.set(sessionId, session);
      log(
        "session start",
        sessionId,
        "| game:",
        gameName,
        "| dir:",
        gameDir
      );
      return json(res, 200, {
        ok: true,
        sessionId,
        gameDir,
        relPrefix,
        outputRoot
      });
    }

    if (method === "POST" && url.pathname === "/api/session/finish") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) {
        return json(res, 404, { ok: false, error: "session not found" });
      }
      if (body.manifest) {
        const manifestPath = path.join(session.gameDir, "assets-manifest.json");
        let existing = null;
        try {
          const raw = await fs.readFile(manifestPath, "utf8");
          existing = JSON.parse(raw);
        } catch {
          /* 首次写入 */
        }
        const merged = mergeManifestOnDisk(existing, body.manifest);
        await fs.writeFile(manifestPath, JSON.stringify(merged, null, 2), "utf8");
      }
      const stats = {
        downloaded: session.downloaded,
        skipped: session.skipped,
        failed: session.failed
      };
      sessions.delete(session.sessionId);
      log(
        "session finish",
        body.sessionId,
        "| game:",
        session.gameName,
        "| dir:",
        session.gameDir,
        "| ok:",
        stats.downloaded,
        "skip:",
        stats.skipped,
        "fail:",
        stats.failed
      );
      return json(res, 200, { ok: true, stats, gameDir: session.gameDir });
    }

    if (method === "GET" && url.pathname.startsWith("/api/session/")) {
      const sessionId = url.pathname.split("/")[3];
      const session = sessions.get(sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session not found" });
      return json(res, 200, {
        ok: true,
        sessionId,
        gameDir: session.gameDir,
        stats: {
          downloaded: session.downloaded,
          skipped: session.skipped,
          failed: session.failed
        },
        queue: jobQueue.filter((j) => j.sessionId === sessionId).length
      });
    }

    if (method === "POST" && url.pathname === "/api/file/stat") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session not found" });
      const { relPath: safeRel, abs } = safeResolve(session.gameDir, body.relPath);
      const exists = await fileExists(abs);
      let bytes = 0;
      if (exists) {
        const st = await fs.stat(abs);
        bytes = st.size;
      }
      return json(res, 200, { ok: true, exists, relPath: safeRel, bytes });
    }

    if (method === "POST" && url.pathname === "/api/file/read") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session not found" });
      const { relPath: safeRel, abs } = safeResolve(session.gameDir, body.relPath);
      const file = await readTextFile(abs);
      return json(res, 200, { ok: true, relPath: safeRel, ...file });
    }

    if (method === "POST" && url.pathname === "/api/assets/ingest") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session not found" });
      const result = await ingestOne(session, body);
      return json(res, 200, { ok: true, ...result });
    }

    if (method === "POST" && url.pathname === "/api/assets/ingest/batch") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session not found" });
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > 0 && LOG_INGEST) {
        log("batch ingest", items.length, "item(s) |", session.gameName);
      }
      const results = [];
      for (const item of items) {
        results.push(await ingestOne(session, item));
      }
      const stats = {
        downloaded: results.filter((r) => r.status === "ok").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length
      };
      return json(res, 200, {
        ok: true,
        results,
        stats,
        sessionStats: {
          downloaded: session.downloaded,
          skipped: session.skipped,
          failed: session.failed
        }
      });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log("error", e);
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }
  void handleRequest(req, res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[poki-dl-server] 端口 ${PORT} 已被占用。可选方案：\n` +
        `  1) 服务可能已在运行，直接访问 http://${HOST}:${PORT}/health\n` +
        `  2) 结束旧进程: lsof -i :${PORT} 然后 kill <PID>\n` +
        `  3) 换端口: POKI_DL_PORT=22223 npm run poki-server`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`default output root: ${DEFAULT_OUTPUT_ROOT}`);
});
