// §9.5: HTML 一覧ページから記事リンクを抽出する。フィードを提供しないソース（Uber / LinkedIn）向け。
// 引数で受け取った Document のみを操作し、グローバルの document/window には触れない
// （offscreen では DOMParser が、scripts / tests では jsdom が Document を渡す）。

import type { ListingItem } from "../shared/types";
import { normalizeUrl } from "./urlNormalize";

/** アンカー内の見出しとみなすタグ名 */
const HEADING_SELECTOR = "h1, h2, h3, h4";

/** 記事リンクらしさ判定のしきい値（アンカーテキストの文字数） */
const MIN_ANCHOR_TEXT_LENGTH = 20;

/** 祖先を遡って time[datetime] を探す最大階層 */
const MAX_ANCESTOR_DEPTH = 3;

/** 空白（改行含む）を1つのスペースに正規化してトリムする */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** リンク先として無視すべき href かどうか（javascript: / mailto: / フラグメントのみ） */
function isIgnorableHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  const lower = trimmed.toLowerCase();
  return lower.startsWith("javascript:") || lower.startsWith("mailto:");
}

/** アンカー自身、または最も近い祖先 article/li/div（3階層まで）の中の time[datetime] を探す */
function findDateElement(anchor: Element): Element | null {
  const own = anchor.querySelector("time[datetime]");
  if (own) return own;

  let ancestor: Element | null = anchor.parentElement;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && ancestor; depth++) {
    const tag = ancestor.tagName.toLowerCase();
    if (tag === "article" || tag === "li" || tag === "div") {
      const found = ancestor.querySelector("time[datetime]");
      if (found) return found;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/** time[datetime] から日時（ms epoch）を取り出す。無効なら undefined */
function parseDateFromAnchor(anchor: Element): number | undefined {
  const timeEl = findDateElement(anchor);
  const datetime = timeEl?.getAttribute("datetime");
  if (!datetime) return undefined;
  const parsed = Date.parse(datetime);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** アンカーのタイトルを決める: 見出しテキスト → アンカーのテキスト → aria-label / title 属性 */
function resolveTitle(anchor: Element, heading: Element | null): string {
  const headingText = heading ? normalizeWhitespace(heading.textContent ?? "") : "";
  if (headingText) return headingText;

  const anchorText = normalizeWhitespace(anchor.textContent ?? "");
  if (anchorText) return anchorText;

  const ariaLabel = anchor.getAttribute("aria-label");
  if (ariaLabel && normalizeWhitespace(ariaLabel)) return normalizeWhitespace(ariaLabel);

  const titleAttr = anchor.getAttribute("title");
  if (titleAttr && normalizeWhitespace(titleAttr)) return normalizeWhitespace(titleAttr);

  return "";
}

/**
 * 一覧ページの Document から記事リンクを抽出する。
 * - href を pattern（正規化後の絶対URLに適用）でフィルタする
 * - 見出しを含む、またはアンカーテキストが20文字以上のものだけ記事リンクとみなす
 * - タイトル・日付（time[datetime]）を取り出し、正規化URLで重複除去（先勝ち）する
 * - 返り値は文書順（一覧の上ほど新しいとみなす）
 * pattern が無効な正規表現の場合は throw する。
 */
export function extractListingItems(doc: Document, opts: { baseUrl: string; pattern: string }): ListingItem[] {
  const regex = new RegExp(opts.pattern);
  const anchors = Array.from(doc.querySelectorAll("a[href]"));

  const items: ListingItem[] = [];
  const seenUrls = new Set<string>();

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href || isIgnorableHref(href)) continue;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, opts.baseUrl).href;
    } catch {
      continue;
    }

    const normalized = normalizeUrl(absoluteUrl);
    if (!regex.test(normalized)) continue;

    const heading = anchor.querySelector(HEADING_SELECTOR);
    const anchorText = normalizeWhitespace(anchor.textContent ?? "");
    const looksLikeArticle = heading !== null || anchorText.length >= MIN_ANCHOR_TEXT_LENGTH;
    if (!looksLikeArticle) continue;

    const title = resolveTitle(anchor, heading);
    if (!title) continue;

    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    items.push({
      url: normalized,
      title,
      publishedAt: parseDateFromAnchor(anchor),
    });
  }

  return items;
}
