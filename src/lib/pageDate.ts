// 記事ページの公開日時を抽出する純粋関数。DOM API（Document）だけに依存するため、
// offscreen（DOMParser が作る Document）と scripts/check-feeds.ts（jsdom の Document）の
// 両方から同じ抽出順で使える。§10 / §14。

/** meta タグの content 属性値を返す（空文字は undefined 扱い） */
function metaContent(doc: Document, selector: string): string | undefined {
  const content = doc.querySelector(selector)?.getAttribute("content");
  return content && content.trim() ? content : undefined;
}

/** ld+json（配列・@graph 配列にも対応）から最初に見つかった datePublished を返す */
function findDatePublishedInJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findDatePublishedInJson(v);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.datePublished === "string" && obj.datePublished.trim()) return obj.datePublished;
    if (Array.isArray(obj["@graph"])) {
      return findDatePublishedInJson(obj["@graph"]);
    }
  }
  return undefined;
}

function findPublishedAtFromLd(doc: Document): string | undefined {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent;
    if (!raw || !raw.trim()) continue;
    try {
      const found = findDatePublishedInJson(JSON.parse(raw));
      if (found) return found;
    } catch {
      // 壊れた JSON-LD は無視する
    }
  }
  return undefined;
}

/**
 * §10: 記事の公開日時を探す。Readability で本文が書き換えられる前に呼ぶこと（offscreen 側）。
 * meta[property="article:published_time"] → meta[name="date"|"pubdate"|"publish-date"|"dc.date"]
 * → ld+json の datePublished → article time[datetime] / time[datetime] の順に探し、
 * Date.parse できた最初の値（epoch ms）を返す。
 */
export function extractPublishedAt(doc: Document): number | undefined {
  const candidates: (string | undefined)[] = [
    metaContent(doc, 'meta[property="article:published_time"]'),
    metaContent(doc, 'meta[name="date"]') ??
      metaContent(doc, 'meta[name="pubdate"]') ??
      metaContent(doc, 'meta[name="publish-date"]') ??
      metaContent(doc, 'meta[name="dc.date"]'),
    findPublishedAtFromLd(doc),
    doc.querySelector("article time[datetime]")?.getAttribute("datetime") ??
      doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
      undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
