// §9.5: RSS を提供しないソース向けの HTML 一覧ページフォールバック。
// 一覧ページを取得して記事リンクを抽出する。db.articles への取り込みは
// pipeline.ts が共通の commitNewItems（src/background/commit.ts, mode:"listing"）で行う。

import type { FeedTestResult, ListingItem, Source } from "../shared/types";
import { PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES } from "../shared/constants";
import { fetchArticleHtml } from "./articleFetcher";
import { extractLinksViaOffscreen } from "./offscreenClient";

/**
 * extractLinksViaOffscreen() の応答から items 配列を取り出す。
 * `listen()`（§7）はハンドラが reject した場合 `{ ok: false, error }` を返し、
 * 対象 target のリスナーが無い場合（またはメッセージ型が一致しない場合）は
 * `chrome.runtime.sendMessage` が `undefined` に解決する。どちらも `items` を持たないため、
 * 型（`Promise<{ items: ListingItem[] }>`）を無条件に信用せず実行時に検証する。
 */
function extractItemsFromResponse(response: unknown): ListingItem[] {
  if (response && typeof response === "object" && Array.isArray((response as { items?: unknown }).items)) {
    return (response as { items: ListingItem[] }).items;
  }
  const errorMessage =
    response && typeof response === "object" && "error" in response
      ? String((response as { error?: unknown }).error ?? "")
      : "";
  throw new Error(errorMessage || "一覧ページの解析に失敗しました");
}

/** 一覧ページを取得して記事リンクを抽出する。listingUrl / listingLinkPattern が無い場合は throw する */
async function extractFromListingPage(source: Source): Promise<ListingItem[]> {
  if (!source.listingUrl || !source.listingLinkPattern) {
    throw new Error("一覧ページが設定されていません");
  }
  const html = await fetchArticleHtml(source.listingUrl, PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES);
  if (html === null) {
    throw new Error("一覧ページのHTMLを取得できませんでした");
  }
  const response = await extractLinksViaOffscreen(
    html,
    source.listingUrl,
    source.listingLinkPattern,
    source.listingExcludePattern,
  );
  const items = extractItemsFromResponse(response);
  if (items.length === 0) {
    throw new Error("一覧ページから記事リンクを抽出できませんでした");
  }
  return items;
}

/**
 * 一覧ページから記事リンクを抽出する（§8-3 以降のパイプラインへは pipeline.ts が
 * commitNewItems(source, settings, candidates, "listing") で合流させる）。
 * 文書順（一覧の上ほど新しい）を保って返す。
 */
export async function fetchListingItems(source: Source): Promise<ListingItem[]> {
  return extractFromListingPage(source);
}

/** 設定ページの「一覧ページ抽出テスト」用。一覧ページを取得・抽出して概要を返す */
export async function testListing(source: Source): Promise<FeedTestResult> {
  try {
    const items = await extractFromListingPage(source);
    const newest = items[0];
    return {
      ok: true,
      format: "listing",
      itemCount: items.length,
      newestTitle: newest?.title,
      newestDate: newest?.publishedAt !== undefined ? new Date(newest.publishedAt).toISOString() : undefined,
      hasFullContent: false,
    };
  } catch (err) {
    return {
      ok: false,
      format: "listing",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
