/**
 * 在 Poki 游戏入口页（/xx/g/slug）内执行，提取壳层 + article + head 元数据。
 * 通过 chrome.scripting.executeScript({ func: scrapePokiPortalPage }) 注入。
 */
export function scrapePokiPortalPage() {
  function norm(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function metaName(name) {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || "";
  }

  function metaOg(prop) {
    return document.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") || "";
  }

  function extFromUrl(u) {
    try {
      const p = new URL(u).pathname;
      const i = p.lastIndexOf(".");
      if (i > 0 && p.length - i <= 6) return p.slice(i).toLowerCase();
    } catch {
      /* ignore */
    }
    return ".webp";
  }

  const pathMatch = location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\/g\/([^/?#]+)/i);
  const locale = pathMatch?.[1] || "en";
  const gameSlug = pathMatch?.[2] ? decodeURIComponent(pathMatch[2]) : "";

  let jsonLdName = "";
  let jsonLdImage = "";
  let jsonLdAuthor = "";
  let jsonLdRating = null;

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const raw = JSON.parse(script.textContent);
      const items = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = String(item["@type"] || "");
        const isGame =
          /VideoGame|WebApplication|Game/i.test(type) ||
          item.aggregateRating ||
          (item.name && item.url && String(item.url).includes("/g/"));
        if (!isGame) continue;
        if (item.name) jsonLdName = String(item.name);
        if (item.image) {
          const img = item.image;
          jsonLdImage =
            typeof img === "string"
              ? img
              : img?.url || (Array.isArray(img) ? img[0]?.url || img[0] : "") || "";
        }
        if (item.author) {
          jsonLdAuthor =
            typeof item.author === "string" ? item.author : item.author?.name || "";
        }
        if (item.aggregateRating) {
          const ar = item.aggregateRating;
          const voteRaw = ar.ratingCount ?? ar.reviewCount ?? "";
          jsonLdRating = {
            value: parseFloat(ar.ratingValue),
            voteCount:
              parseInt(String(voteRaw).replace(/\D/g, ""), 10) ||
              (Number.isFinite(Number(voteRaw)) ? Number(voteRaw) : null)
          };
        }
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  const article = document.querySelector("article");
  const main = document.querySelector("main") || document.body;
  const mainText = main?.innerText || "";

  const h1 = document.querySelector("h1");
  let title =
    jsonLdName ||
    norm(h1?.textContent) ||
    metaOg("og:title").replace(/\s*-\s*Play.*$/i, "").trim() ||
    document.title.split("-")[0].trim();

  let developer = jsonLdAuthor || "";
  if (!developer) {
    const byMatch = mainText.match(/\bby\s+([^\n|•·]+?)(?:\s+\d|\s+Like|\s+Dislike|\n|$)/i);
    if (byMatch) developer = byMatch[1].trim();
  }

  let likes = "";
  let dislikes = "";
  const likeM = mainText.match(/([\d.,]+[KMB]?)\s*Like\b/i);
  const dislikeM = mainText.match(/([\d.,]+[KMB]?)\s*Dislike\b/i);
  if (likeM) likes = likeM[1];
  if (dislikeM) dislikes = dislikeM[1];

  let rating = jsonLdRating;
  if (!rating && article) {
    const ratingM = (article.innerText || "").match(/([\d.]+)\s*([\d,]+)\s*votes/i);
    if (ratingM) {
      rating = {
        value: parseFloat(ratingM[1]),
        voteCount: parseInt(ratingM[2].replace(/,/g, ""), 10)
      };
    }
  }

  let summary = metaOg("og:description") || metaName("description") || "";
  const sections = [];
  const faq = [];
  const tables = [];
  const tags = [];
  const relatedGames = [];
  const seenRelated = new Set();

  if (article) {
    const firstP = article.querySelector("p");
    if (!summary && firstP) summary = norm(firstP.textContent).slice(0, 800);

    for (const h of article.querySelectorAll("h2, h3")) {
      const heading = norm(h.textContent);
      const level = h.tagName === "H2" ? 2 : 3;
      const parts = [];
      let sib = h.nextElementSibling;
      while (sib && sib.tagName !== "H2" && sib.tagName !== "H3") {
        if (sib.tagName === "P") parts.push(norm(sib.textContent));
        sib = sib.nextElementSibling;
      }
      if (heading) sections.push({ heading, level, text: parts.join("\n\n") });
    }

    for (const table of article.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th, td")].map((td) => norm(td.textContent))
      );
      if (rows.length) {
        tables.push({
          headers: rows[0] || [],
          rows: rows.length > 1 ? rows.slice(1) : []
        });
      }
    }

    let inFaq = false;
    for (const el of article.querySelectorAll("h2, h3, p")) {
      if (el.tagName === "H2" && /^faq$/i.test(norm(el.textContent))) {
        inFaq = true;
        continue;
      }
      if (inFaq && el.tagName === "H2") break;
      if (inFaq && el.tagName === "H3") {
        const q = norm(el.textContent);
        let a = "";
        const next = el.nextElementSibling;
        if (next?.tagName === "P") a = norm(next.textContent);
        if (q) faq.push({ q, a });
      }
    }

    for (const a of article.querySelectorAll("a[href]")) {
      const href = a.href || "";
      const label = norm(a.textContent);
      if (!label || label.length > 48) continue;
      if (/\/g\/[^/]+/.test(href) && !href.includes(gameSlug)) {
        if (!seenRelated.has(href)) {
          seenRelated.add(href);
          relatedGames.push({ title: label, url: href.split("#")[0] });
        }
      } else if (
        !href.includes("/g/") &&
        /poki\.com/i.test(href) &&
        !tags.includes(label)
      ) {
        tags.push(label);
      }
    }
  }

  const iconUrl = metaOg("og:image") || jsonLdImage || "";
  let thumbnailVideoUrl = null;
  const videoEl =
    document.querySelector("video[src]") ||
    document.querySelector("video source[src]");
  if (videoEl) {
    thumbnailVideoUrl =
      videoEl.getAttribute("src") || videoEl.src || null;
  }

  const assets = [];
  if (iconUrl && iconUrl.startsWith("http")) {
    assets.push({ url: iconUrl, filename: `icon${extFromUrl(iconUrl)}` });
  }
  if (thumbnailVideoUrl && thumbnailVideoUrl.startsWith("http")) {
    assets.push({
      url: thumbnailVideoUrl,
      filename: `preview${extFromUrl(thumbnailVideoUrl)}`
    });
  }

  const meta = {
    portalUrl: location.href.split("#")[0],
    gameSlug,
    locale,
    title,
    developer,
    rating: rating || null,
    engagement: { likes, dislikes },
    media: {
      iconUrl: iconUrl || null,
      ogImageUrl: metaOg("og:image") || null,
      thumbnailVideoUrl
    },
    description: {
      summary,
      sections,
      faq
    },
    tables,
    tags: tags.slice(0, 40),
    relatedGames: relatedGames.slice(0, 24),
    scrapedAt: new Date().toISOString()
  };

  return {
    meta,
    articleHtml: article ? article.outerHTML : "",
    assets
  };
}
