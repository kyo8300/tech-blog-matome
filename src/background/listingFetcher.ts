// §9.5: RSS を提供しないソース向けの HTML 一覧ページフォールバック。
// 一覧ページを取得して記事リンクを抽出し、listingSeenIds ベースの新着判定で db.articles に取り込む。

import Dexie from "dexie";
import type { Article, FeedTestResult, ListingItem, Settings, Source } from "../shared/types";
import { LISTING_SEEN_MAX, PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES } from "../shared/constants";
import { getDb } from "../shared/db";
import { sha256Hex } from "../lib/hash";
import { normalizeUrl } from "../lib/urlNormalize";
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
 * 一覧ページから記事リンクを抽出する（§8-3 以降のパイプラインへは commitListingItems で合流させる）。
 * 文書順（一覧の上ほど新しい）を保って返す。
 */
export async function fetchListingItems(source: Source): Promise<ListingItem[]> {
  return extractFromListingPage(source);
}

/** listingSeenIds に新しい id を追加し、LISTING_SEEN_MAX 件を超えたら古いものから切り詰める */
function appendSeenIds(seen: string[], newIds: string[]): string[] {
  const merged = [...seen];
  for (const id of newIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  if (merged.length > LISTING_SEEN_MAX) {
    return merged.slice(merged.length - LISTING_SEEN_MAX);
  }
  return merged;
}

/**
 * §9.5: 一覧ページから抽出した記事を、`source.listingSeenIds` ベースの新着判定で db.articles に取り込む。
 * 一覧ページには過去記事も並ぶため、通常のフィード経路（DB未登録＝新着）とは異なり、
 * 「listingSeenIds に無い id」だけを新着として扱う。
 * - 未初期化（initialized=false）、または listingSeenIds が未設定（undefined。旧版からの移行や seen 消失時）: 文書順の先頭1件だけを
 *   新着として登録し、残りは「見た」ことにするだけで登録しない（安全側に倒す）。
 * - それ以外（初期化済みかつ listingSeenIds 設定済み）: listingSeenIds に無い id だけを新着とする（maxNewPerSourcePerRun で上限）。
 * - 実行のたびに、抽出した全件の id を listingSeenIds に追加する（最大 LISTING_SEEN_MAX 件、古いものから破棄）。
 * publishedAt が不明な項目は createdAt（取得時刻）を仮値として使う（§8-5, §10 で本文取得時に更新され得る）。
 * rssSummary に相当する情報は無い。新規追加できた記事数を返す。
 */
export async function commitListingItems(source: Source, settings: Settings, items: ListingItem[]): Promise<number> {
  const db = getDb();

  // 正規化URL+sha256 で id を計算する。同一 id が複数回出てくることがあるため、先に現れたものだけ残す
  const withIds: { item: ListingItem; id: string }[] = [];
  const seenInThisRun = new Set<string>();
  for (const item of items) {
    const id = await sha256Hex(normalizeUrl(item.url));
    if (seenInThisRun.has(id)) continue;
    seenInThisRun.add(id);
    withIds.push({ item, id });
  }

  // listingSeenIds が未設定（旧版からの移行・seen 消失など）のときは、初期化済みでも
  // 未初期化と同じ扱いにする（全件を新着として登録してしまわないよう安全側に倒す）。
  const treatAsUninitialized = !source.initialized || source.listingSeenIds === undefined;
  const previousSeen = new Set(source.listingSeenIds ?? []);
  const candidates = treatAsUninitialized
    ? withIds.slice(0, 1)
    : withIds.filter((w) => !previousSeen.has(w.id)).slice(0, settings.maxNewPerSourcePerRun);

  // DB に既に存在する記事は除外する（安全策。listingSeenIds が正しく機能していれば通常は空集合になる）
  const existing = candidates.length > 0 ? await db.articles.bulkGet(candidates.map((c) => c.id)) : [];
  const toAdd = candidates.filter((_, i) => existing[i] === undefined);

  let addedCount = 0;
  if (toAdd.length > 0) {
    const now = Date.now();
    const articles: Article[] = toAdd.map(({ item, id }) => ({
      id,
      sourceId: source.id,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt ?? now,
      createdAt: now,
      rssSummary: undefined,
      contentText: undefined,
      contentSource: "none",
      contentChars: 0,
      status: "new",
      attempts: 0,
    }));
    try {
      await db.articles.bulkAdd(articles);
      addedCount = articles.length;
    } catch (err) {
      // bulkAdd は非トランザクション的に「入れられるものは入れる」ので、
      // 重複キー等で一部が失敗しても成功した分は保存されている。失敗数を差し引いて数える。
      if (err instanceof Dexie.BulkError) {
        addedCount = articles.length - err.failures.length;
      } else {
        throw err;
      }
    }
  }

  const nextSeenIds = appendSeenIds(
    source.listingSeenIds ?? [],
    withIds.map((w) => w.id),
  );

  await db.sources.update(source.id, {
    initialized: true,
    listingSeenIds: nextSeenIds,
    lastFetchedAt: Date.now(),
    lastStatus: "ok",
    lastError: undefined,
    lastItemCount: items.length,
    lastFetchMode: "listing",
  });

  return addedCount;
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
