/**
 * assets-manifest.json 合并写入（download-poki-game / fix_game_resources 共用）
 */

export function fileEntryKey(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.localPath) return `path:${entry.localPath}`;
  if (entry.sourceUrl) return `url:${entry.sourceUrl}`;
  return null;
}

export function computeStatsFromFiles(files) {
  const stats = { totalSeen: 0, downloaded: 0, failed: 0, skipped: 0 };
  for (const f of files) {
    stats.totalSeen += 1;
    if (f.status === "failed") stats.failed += 1;
    else if (f.skipped) stats.skipped += 1;
    else stats.downloaded += 1;
  }
  return stats;
}

/**
 * 合并 manifest：同 localPath（或 sourceUrl）条目合并字段，不丢弃历史记录。
 * @param {object | null} existing
 * @param {object | null} incoming
 */
export function mergeManifest(existing, incoming) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const next = incoming && typeof incoming === "object" ? incoming : {};

  const fileMap = new Map();
  for (const f of prev.files || []) {
    const key = fileEntryKey(f);
    if (key) fileMap.set(key, { ...f });
  }
  for (const f of next.files || []) {
    const key = fileEntryKey(f);
    if (!key) continue;
    const old = fileMap.get(key) || {};
    fileMap.set(key, {
      ...old,
      ...f,
      updatedAt: f.updatedAt || new Date().toISOString()
    });
  }

  const files = Array.from(fileMap.values());
  const merged = {
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
    status: next.status || prev.status || prev.status || "",
    updatedAt: new Date().toISOString(),
    files
  };
  merged.stats = computeStatsFromFiles(files);
  return merged;
}

/** 将磁盘已有 manifest 的 files 并入内存会话（不降低已有 stats 计数） */
export function hydrateSessionFiles(session, manifest) {
  if (!session || !manifest?.files?.length) return;
  if (manifest.gameUrl && !session.gameUrl) session.gameUrl = manifest.gameUrl;
  if (manifest.gameName && !session.gameName) session.gameName = manifest.gameName;
  for (const f of manifest.files) {
    if (!f?.localPath && !f?.sourceUrl) continue;
    const idx = session.files.findIndex(
      (x) =>
        (f.localPath && x.localPath === f.localPath) ||
        (f.sourceUrl && x.sourceUrl === f.sourceUrl)
    );
    if (idx >= 0) {
      session.files[idx] = { ...session.files[idx], ...f };
    } else {
      session.files.push({ ...f });
    }
    if (f.status === "ok" && f.localPath && session.downloadedLocalPaths) {
      session.downloadedLocalPaths.add(f.localPath);
    }
  }
}
