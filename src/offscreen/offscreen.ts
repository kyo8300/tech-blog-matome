// offscreen document 側のエントリポイント（Readability による本文抽出）。
// §10: SW から OFFSCREEN_EXTRACT を受け取り、DOMParser + Readability で本文を抽出して返す。
// fetch はここでは行わない（HTML 取得は SW 側の articleFetcher が担う）。

import { Readability } from "@mozilla/readability";
import type { ExtractResult } from "../shared/types";
import { listen } from "../shared/messages";

/** テキストの空白を正規化する（連続する空白・改行をまとめ、前後をトリムする） */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 記事HTMLから Readability で本文を抽出する */
function extract(html: string, url: string): ExtractResult {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 相対URLの解決や Readability の判定精度のため、記事の実URLを <base> として挿入する
  const base = doc.createElement("base");
  base.href = url;
  doc.head.insertBefore(base, doc.head.firstChild);

  const article = new Readability(doc).parse();
  if (!article) {
    return { text: "" };
  }

  return {
    title: article.title ?? undefined,
    text: normalizeWhitespace(article.textContent ?? ""),
    excerpt: article.excerpt ?? undefined,
  };
}

listen(
  (msg) => {
    if (msg.type !== "OFFSCREEN_EXTRACT") return undefined;
    // extract() が同期的に throw しても handler 自体は同期例外にならないよう
    // async IIFE で包み、Promise の reject として返す（listen 側で catch される）。
    return (async () => extract(msg.html, msg.url))();
  },
  { target: "offscreen" },
);
