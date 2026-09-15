// offscreen document 側のエントリポイント（Readability による本文抽出）。
// §10: SW から OFFSCREEN_EXTRACT を受け取り、DOMParser + Readability で本文を抽出して返す。
// fetch はここでは行わない（HTML 取得は SW 側の articleFetcher が担う）。

import { Readability } from "@mozilla/readability";
import type { ExtractResult, ListingItem } from "../shared/types";
import { listen } from "../shared/messages";
import { extractListingItems } from "../lib/listingExtract";
import { extractPublishedAt } from "../lib/pageDate";

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

/** 記事HTMLから Readability で本文を抽出する */
function extract(html: string, url: string): ExtractResult {
  const doc = parseWithBase(html, url);
  // Readability.parse() は doc を破壊的に書き換えるため、公開日探索は必ず先に行う
  const publishedAt = extractPublishedAt(doc);

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
