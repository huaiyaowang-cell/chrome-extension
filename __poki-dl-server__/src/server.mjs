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

function log(...args) {
  console.log(`[poki-dl-server]`, ...args);
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
  return new Promise((resolve) => {
    const jobId = `j${++jobSeq}`;
    const job = { jobId, sessionId: session.sessionId, sourceUrl, absPath, resolve };
    jobs.set(jobId, job);
    jobQueue.push(job);
    pumpQueue();
  });
}

/**
 * @param {Session} session
 * @param {object} item
 */
async function ingestOne(session, item) {
  const { relPath: safeRel, abs } = safeResolve(session.gameDir, item.relPath);

  if (item.body != null && item.body !== "") {
    const enc = item.encoding === "base64" ? "base64" : "utf8";
    const overwrite = !!item.overwrite;
    if (!overwrite && (await fileExists(abs))) {
      session.skipped += 1;
      return { relPath: safeRel, status: "skipped", reason: "exists" };
    }
    await writeBody(abs, item.body, enc);
    session.downloaded += 1;
    const st = await fs.stat(abs);
    return {
      relPath: safeRel,
      status: "ok",
      bytes: st.size,
      wrote: overwrite ? "body-overwrite" : "body"
    };
  }

  if (!item.sourceUrl || !item.sourceUrl.startsWith("http")) {
    session.failed += 1;
    return { relPath: safeRel, status: "failed", error: "missing sourceUrl" };
  }

  const overwrite = !!item.overwrite;
  if (!overwrite && (await fileExists(abs))) {
    session.skipped += 1;
    const st = await fs.stat(abs);
    return { relPath: safeRel, status: "skipped", reason: "exists", bytes: st.size };
  }

  const result = await enqueueDownload(session, item.sourceUrl, abs);
  return { relPath: safeRel, ...result };
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}`);
  const method = req.method || "GET";

  try {
    if (method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        version: "1.0.0",
        port: PORT,
        defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
        sessions: sessions.size,
        queue: jobQueue.length,
        activeDownloads
      });
    }

    if (method === "POST" && url.pathname === "/api/session/start") {
      const body = await readJson(req);
      const gameName = String(body.gameName || "poki-game").trim();
      const outputRoot = path.resolve(
        String(body.outputRoot || DEFAULT_OUTPUT_ROOT).trim()
      );
      const relPrefix = String(body.relPrefix || gameName)
        .replace(/^\/+|\/+$/g, "");
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
      log("session start", sessionId, gameDir);
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
        await fs.writeFile(
          manifestPath,
          JSON.stringify(body.manifest, null, 2),
          "utf8"
        );
      }
      const stats = {
        downloaded: session.downloaded,
        skipped: session.skipped,
        failed: session.failed
      };
      sessions.delete(session.sessionId);
      log("session finish", body.sessionId, stats);
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
