/**
 * 在 Poki 游戏页解析推荐区游戏瓦片（summaryTile / data-tile-url）。
 * 通过 chrome.scripting.executeScript({ func: scrapePokiGameTiles }) 注入。
 */
export function scrapePokiGameTiles() {
  const tiles = [];
  const seen = new Set();

  const currentMatch = location.pathname.match(/\/g\/([^/?#]+)/i);
  const currentSlug = currentMatch ? decodeURIComponent(currentMatch[1]) : "";

  function addFromAnchor(a) {
    const href =
      a.getAttribute("data-tile-url") || a.getAttribute("href") || "";
    if (!href.includes("/g/")) return;
    const m = href.match(/\/g\/([^/?#]+)/i);
    if (!m) return;
    const slug = decodeURIComponent(m[1]);
    if (!slug || seen.has(slug)) return;

    const img = a.querySelector("img");
    let iconUrl = img?.currentSrc || img?.src || img?.getAttribute("data-src") || "";
    if (iconUrl.startsWith("//")) iconUrl = `https:${iconUrl}`;

    const titleEl = a.querySelector(
      '[class*="summaryTile_title"], .summaryTile_title'
    );
    let title = titleEl ? String(titleEl.textContent || "").trim() : "";
    if (!title) title = String(img?.alt || slug).trim();

    let portalUrl = href;
    try {
      portalUrl = href.startsWith("http")
        ? href
        : new URL(href, location.origin).href;
    } catch {
      portalUrl = `${location.origin}/en/g/${slug}`;
    }

    tiles.push({ slug, title, iconUrl, portalUrl });
    seen.add(slug);
  }

  const selectors = [
    "a[data-tile-url]",
    'a.summaryTile[href*="/g/"]',
    'a[class*="summaryTile"][href*="/g/"]'
  ];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(addFromAnchor);
  }

  if (tiles.length === 0) {
    document.querySelectorAll('a[href*="/g/"]').forEach((a) => {
      if (a.querySelector("img")) addFromAnchor(a);
    });
  }

  return {
    pageUrl: location.href,
    currentSlug,
    tiles
  };
}
