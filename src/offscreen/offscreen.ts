// offscreen document 側のエントリポイント（Readability による本文抽出）。
// §10: SW から OFFSCREEN_EXTRACT を受け取り、DOMParser + Readability で本文を抽出して返す。
// fetch はここでは行わない（HTML 取得は SW 側の articleFetcher が担う）。

import { Readability } from "@mozilla/readability";
import type { ExtractResult, ListingItem } from "../shared/types";
import { listen } from "../shared/messages";
import { extractListingItems } from "../lib/listingExtract";

/** テキストの空白を正規化する（連続する空白・改行をまとめ、前後をトリムする） */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 記事の実URLを <base> として head 先頭に挿入する（相対URL解決・Readability の判定精度のため） */
function parseWithBase(html: string, url: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = url;
  doc.head.insertBefore(base, doc.head.firstChild);
  return doc;
}

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
 * §10: 記事の公開日時を探す。Readability で本文が書き換えられる前に呼ぶこと。
 * meta[property="article:published_time"] → meta[name="date"|"pubdate"|"publish-date"|"dc.date"]
 * → ld+json の datePublished → article time[datetime] / time[datetime] の順に探し、
 * Date.parse できた最初の値（epoch ms）を返す。
 */
function findPublishedAt(doc: Document): number | undefined {
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

/** 記事HTMLから Readability で本文を抽出する */
function extract(html: string, url: string): ExtractResult {
  const doc = parseWithBase(html, url);
  // Readability.parse() は doc を破壊的に書き換えるため、公開日探索は必ず先に行う
  const publishedAt = findPublishedAt(doc);

  const article = new Readability(doc).parse();
  if (!article) {
    return { text: "", publishedAt };
  }

  return {
    title: article.title ?? undefined,
    text: normalizeWhitespace(article.textContent ?? ""),
    excerpt: article.excerpt ?? undefined,
    publishedAt,
  };
}

/** §9.5: 一覧ページのHTMLから記事リンクを抽出する */
function extractLinks(html: string, url: string, pattern: string, excludePattern?: string): { items: ListingItem[] } {
  const doc = parseWithBase(html, url);
  return { items: extractListingItems(doc, { baseUrl: url, pattern, excludePattern }) };
}

listen(
  (msg) => {
    // handler が同期的に throw しても呼び出し元は必ず1回応答を受け取れるよう、
    // async IIFE で包んで Promise の reject として返す（listen 側で catch される）。
    if (msg.type === "OFFSCREEN_EXTRACT") {
      return (async () => extract(msg.html, msg.url))();
    }
    if (msg.type === "OFFSCREEN_EXTRACT_LINKS") {
      return (async () => extractLinks(msg.html, msg.url, msg.pattern, msg.excludePattern))();
    }
    return undefined;
  },
  { target: "offscreen" },
);
