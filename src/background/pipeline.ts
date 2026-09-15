// §8: 取得・要約パイプライン本体。runPipeline がフィード取得〜要約〜通知までの一連の流れを担う。

import Dexie from "dexie";
import type { Article, Settings, Source } from "../shared/types";
import { getDb } from "../shared/db";
import { DEFAULT_SOURCES } from "../shared/sources";
import { IDLE_PROGRESS, isLockActive, loadProgress, loadSettings, saveProgress, saveSettings } from "../shared/settings";
import { FEED_CONCURRENCY, FEED_FETCH_TIMEOUT_MS, SUMMARIZING_STALE_MS } from "../shared/constants";
import { sha256Hex } from "../lib/hash";
import { normalizeUrl } from "../lib/urlNormalize";
import { htmlToText } from "../lib/htmlToText";
import { parseFeed, filterByCategory, NotXmlError, type FeedItem } from "../lib/feedParser";
import { mapLimit } from "../lib/concurrency";
import { fetchFeed, testFeed as testFeedImpl } from "./feedFetcher";
import { fetchListingItems, commitListingItems } from "./listingFetcher";
import { summarizeOne } from "./summarizer";
import * as offscreenPool from "./offscreenClient";
import { notifyRun } from "./notifications";
import { updateProgress, getProgress } from "./progress";
import * as keepAlive from "./keepAlive";

export type PipelineTrigger = "alarm" | "manual" | "install" | "startup";

/** ロック中に来た alarm/manual の実行要求を、現在の実行が終わった直後に拾い直すための storage.session キー */
const PENDING_TRIGGER_KEY = "pendingTrigger";

/** 設定ページの「フィード接続テスト」（messageRouter からそのまま re-export して使う） */
export const testFeed = testFeedImpl;

/**
 * 有効ソースを feedUrlOverrides でマージして db.sources に upsert する。
 * 既存の etag/lastModified/initialized/lastFetchedAt/lastStatus/lastError/lastItemCount/lastFetchMode/listingSeenIds
 * は維持する（ただし feedUrl 自体が変わった場合は etag/lastModified は無効になるためリセットする）。
 * listingSeenIds を維持し忘れると一覧経路の「見たことがある」記録が毎回消え、
 * 過去記事が繰り返し新着扱いになってしまうため他の実行時フィールドと同様に必ず引き継ぐ。
 */
export async function upsertSources(settings: Settings): Promise<Source[]> {
  const db = getDb();
  const enabled = DEFAULT_SOURCES.filter((s) => settings.enabledSources.includes(s.id));
  const existing = await db.sources.bulkGet(enabled.map((s) => s.id));

  const merged: Source[] = enabled.map((base, i) => {
    const prev = existing[i];
    const feedUrl = settings.feedUrlOverrides[base.id] ?? base.feedUrl;
    const feedUrlChanged = prev !== undefined && prev.feedUrl !== feedUrl;
    return {
      ...base,
      feedUrl,
      initialized: prev?.initialized ?? base.initialized,
      etag: feedUrlChanged ? undefined : prev?.etag,
      lastModified: feedUrlChanged ? undefined : prev?.lastModified,
      lastFetchedAt: prev?.lastFetchedAt,
      lastStatus: prev?.lastStatus,
      lastError: prev?.lastError,
      lastItemCount: prev?.lastItemCount,
      lastFetchMode: prev?.lastFetchMode,
      listingSeenIds: prev?.listingSeenIds,
    };
  });

  await db.sources.bulkPut(merged);
  return merged;
}

/** publishedAt 降順でソートする（無いものは最も古い扱い） */
function sortByPublishedDesc(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/**
 * フィード経由でのフィルタ・dedupe・上限適用・bulkAdd・source更新までを行う。
 * 一覧経由（§9.5）は listingSeenIds ベースの新着判定を行う commitListingItems を別途使う。
 * 新規追加できた記事数を返す。
 */
async function commitItems(
  source: Source,
  settings: Settings,
  items: FeedItem[],
  feedMeta?: { etag?: string; lastModified?: string },
): Promise<number> {
  const db = getDb();
  const filtered = filterByCategory(items, source.categoryFilter);
  const sorted = sortByPublishedDesc(filtered);

  // URL正規化+sha256 で id を計算する。同じ id が複数回出てくることがある
  // （フィードが同じ記事を複数エントリで掲載している等）ため、先に現れたものだけ残して dedupe する。
  const seenIds = new Set<string>();
  const withIds: { item: FeedItem; id: string }[] = [];
  for (const item of sorted) {
    const id = await sha256Hex(normalizeUrl(item.link));
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    withIds.push({ item, id });
  }

  // 未登録の記事だけ残す
  const existing = await db.articles.bulkGet(withIds.map((w) => w.id));
  const newOnes = withIds.filter((_, i) => existing[i] === undefined);

  const limit = source.initialized ? settings.maxNewPerSourcePerRun : 1;
  const toAdd = newOnes.slice(0, limit);

  let addedCount = 0;
  if (toAdd.length > 0) {
    const now = Date.now();
    // publishedAt 未知の記事は createdAt（取得時刻）を使う
    const articles: Article[] = toAdd.map(({ item, id }) => ({
      id,
      sourceId: source.id,
      guid: item.guid,
      title: item.title,
      url: item.link,
      publishedAt: item.publishedAt?.getTime() ?? now,
      createdAt: now,
      rssSummary: item.contentHtml ? htmlToText(item.contentHtml) : undefined,
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

  await db.sources.update(source.id, {
    initialized: true,
    etag: feedMeta?.etag,
    lastModified: feedMeta?.lastModified,
    lastFetchedAt: Date.now(),
    lastStatus: "ok",
    lastError: undefined,
    lastItemCount: items.length,
    lastFetchMode: "feed",
  });

  return addedCount;
}

/**
 * 1ソース分のフィード取得〜新着記事の bulkAdd を行う。新規追加できた記事数を返す。
 * フィード取得/解析（HTTPエラー・NotXmlError・ネットワークエラー）に失敗し、かつ
 * source.listingUrl があれば §9.5 の一覧ページフォールバックに切り替える。
 * 一覧フォールバックが成功した場合は lastStatus:"ok", lastFetchMode:"listing"。
 * 双方失敗した場合は両方のエラーメッセージを lastError に併記する。
 */
async function processSource(source: Source, settings: Settings): Promise<number> {
  const db = getDb();
  let feedResult: Awaited<ReturnType<typeof fetchFeed>>;
  let items: FeedItem[];

  try {
    feedResult = await fetchFeed(
      source.feedUrl,
      { etag: source.etag, lastModified: source.lastModified },
      FEED_FETCH_TIMEOUT_MS,
    );

    if (feedResult.notModified || feedResult.text === undefined) {
      await db.sources.update(source.id, { lastFetchedAt: Date.now(), lastStatus: "ok", lastFetchMode: "feed" });
      return 0;
    }

    items = parseFeed(feedResult.text).items;
  } catch (err) {
    const feedMessage = err instanceof NotXmlError ? err.message : err instanceof Error ? err.message : String(err);

    if (!source.listingUrl) {
      await db.sources.update(source.id, {
        lastFetchedAt: Date.now(),
        lastStatus: "error",
        lastError: feedMessage,
      });
      return 0;
    }

    // §9.5: フィード取得/解析に失敗した場合、一覧ページフォールバックに切り替える
    try {
      const listingItems = await fetchListingItems(source);
      return await commitListingItems(source, settings, listingItems);
    } catch (listingErr) {
      const listingMessage =
        listingErr instanceof Error ? listingErr.message : String(listingErr);
      await db.sources.update(source.id, {
        lastFetchedAt: Date.now(),
        lastStatus: "error",
        lastError: `フィード: ${feedMessage} / 一覧ページ: ${listingMessage}`,
      });
      return 0;
    }
  }

  try {
    return await commitItems(source, settings, items, {
      etag: feedResult.etag,
      lastModified: feedResult.lastModified,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.sources.update(source.id, {
      lastFetchedAt: Date.now(),
      lastStatus: "error",
      lastError: message,
    });
    return 0;
  }
}

/** status:"new" の記事と、summarizingAt が SUMMARIZING_STALE_MS 以上前（または未設定）の
 *  status:"summarizing" の記事（SW 死亡による取り残し）を、DBを書き換えずに集めて返す。
 *  まだ新しい summarizingAt を持つ記事は、RESUMMARIZE / REFETCH_CONTENT の単発実行が
 *  まさに処理中の可能性があるため対象にしない（そうしないと二重要約になってしまう）。
 */
async function findOrphans(): Promise<{ newIds: string[]; staleSummarizing: Article[] }> {
  const db = getDb();
  const newArticles = await db.articles.where("status").equals("new").toArray();
  const summarizingArticles = await db.articles.where("status").equals("summarizing").toArray();
  const now = Date.now();
  const staleSummarizing = summarizingArticles.filter(
    (a) => now - (a.summarizingAt ?? 0) >= SUMMARIZING_STALE_MS,
  );
  return { newIds: newArticles.map((a) => a.id), staleSummarizing };
}

/** 取り残し（回収対象）の件数だけを数える。DB は書き換えない（ロックを取る前の事前チェック用）。 */
export async function countOrphans(): Promise<number> {
  const { newIds, staleSummarizing } = await findOrphans();
  return newIds.length + staleSummarizing.length;
}

/**
 * 取り残し回収。status:"new" の全件と、取り残された status:"summarizing" の記事を
 * "new" に戻して対象IDの一覧を返す。
 */
export async function recoverOrphans(): Promise<string[]> {
  const db = getDb();
  const { newIds, staleSummarizing } = await findOrphans();

  if (staleSummarizing.length > 0) {
    await db.articles.bulkPut(
      staleSummarizing.map((a) => ({ ...a, status: "new" as const, summarizingAt: undefined })),
    );
  }

  return [...newIds, ...staleSummarizing.map((a) => a.id)];
}

export interface SummarizeBatchResult {
  doneCount: number;
  errorCount: number;
  errors: string[];
}

/** ids を Article.publishedAt 降順（不明・未取得は末尾）に並べ替える */
async function sortIdsByPublishedDesc(ids: string[]): Promise<string[]> {
  const db = getDb();
  const articles = await db.articles.bulkGet(ids);
  return ids
    .map((id, i) => ({ id, publishedAt: articles[i]?.publishedAt ?? 0 }))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((w) => w.id);
}

/**
 * §8-5: 記事IDの一覧を summaryConcurrency 並列で要約する。
 * publishedAt 降順で settings.maxSummariesPerRun 件までに絞り、残りは "new" のまま次回に繰り越す
 * （繰り越された記事はまだ summarizeOne を呼んでいないので、DBの状態は "new" のままで変更不要）。
 * 課金・認証エラー（isBillingOrAuthError）が1件でも出たら、以降まだ着手していない記事の
 * summarizeOne 呼び出しを打ち切る（既に呼び出し中の記事は完了まで待つ。mapLimit の各 fn が
 * 開始時に aborted フラグを見て即 return することで実現する）。
 */
export async function summarizeBatch(ids: string[], settings: Settings): Promise<SummarizeBatchResult> {
  if (ids.length === 0) {
    return { doneCount: 0, errorCount: 0, errors: [] };
  }
  if (!settings.apiKey) {
    return { doneCount: 0, errorCount: 0, errors: ["APIキー未設定"] };
  }

  const sortedIds = await sortIdsByPublishedDesc(ids);
  const limit = Math.max(0, Math.floor(settings.maxSummariesPerRun) || 0);
  const target = sortedIds.slice(0, limit);
  const carriedOver = sortedIds.slice(limit);

  const notices: string[] = [];
  if (carriedOver.length > 0) {
    notices.push(`上限 ${limit} 件に達したため ${carriedOver.length} 件を次回に繰り越しました`);
  }

  const progress = await getProgress();
  let aborted = false;

  await mapLimit(target, settings.summaryConcurrency, async (id) => {
    if (aborted) return;
    const result = await summarizeOne(id, settings, progress);
    if (result.billingOrAuthError) {
      aborted = true;
    }
  });

  if (aborted) {
    notices.push("APIの残高不足または認証エラーのため中断しました");
  }

  const db = getDb();
  const articles = await db.articles.bulkGet(target);
  let doneCount = 0;
  const errors: string[] = [];
  for (const article of articles) {
    if (!article) continue;
    if (article.status === "done") doneCount++;
    else if (article.status === "error") errors.push(`${article.title}: ${article.error ?? "不明なエラー"}`);
  }
  return { doneCount, errorCount: errors.length, errors: [...notices, ...errors] };
}

/**
 * 指定記事を1件だけ（再）要約する。"new" を経由せず、現在の状態から直接
 * status:"summarizing" に遷移させてから summarizeOne を呼ぶ（二重要約防止。§5-item 参照）。
 * offscreen は acquire/release の参照カウントで扱うため、runPipeline と同時に走っていても
 * 片方が先に終わっても互いの document を閉じてしまわない。
 */
async function summarizeSingle(articleId: string, extraUpdate?: Partial<Article>): Promise<void> {
  const db = getDb();
  await db.articles.update(articleId, {
    status: "summarizing",
    summarizingAt: Date.now(),
    error: undefined,
    ...extraUpdate,
  });
  const settings = await loadSettings();

  keepAlive.start();
  try {
    let offscreenAcquired = false;
    try {
      await offscreenPool.acquire();
      offscreenAcquired = true;
    } catch {
      // offscreen 起動に失敗しても、以降は RSS 概要へのフォールバックとして処理を続行する
    }
    try {
      await summarizeOne(articleId, settings, undefined, { skipInitialTransition: true });
    } finally {
      if (offscreenAcquired) {
        await offscreenPool.release().catch(() => undefined);
      }
    }
  } finally {
    keepAlive.stop();
  }
}

/** 指定記事を1件だけ要約し直す（§13-2: keepAlive で挟む） */
export async function resummarize(articleId: string): Promise<void> {
  await summarizeSingle(articleId);
}

/** 指定記事の本文（contentText）を消し、再取得したうえで再要約する（§13-2: keepAlive で挟む） */
export async function refetchContent(articleId: string): Promise<void> {
  await summarizeSingle(articleId, { contentText: undefined, contentSource: "none", contentChars: 0 });
}

/** 全データを削除して初期状態に戻す（sources は未初期化の既定値で再投入） */
export async function resetAll(): Promise<void> {
  const db = getDb();
  await db.articles.clear();
  await db.chats.clear();
  await db.sources.clear();
  await db.sources.bulkAdd(DEFAULT_SOURCES.map((s) => ({ ...s })));
  await saveProgress(structuredClone(IDLE_PROGRESS));
}

/**
 * 指定ソースの記事・チャット履歴を削除し、initialized=false / listingSeenIds=[] に戻す
 * （etag/lastModified/lastStatus/lastError/lastItemCount/lastFetchMode もクリアする）。
 * これにより次回実行時、一覧経路は「先頭1件だけ登録」の初回バックフィルからやり直しになる。
 * パイプライン実行中（ロック有効。running かつ startedAt から LOCK_STALE_MS 未満）は拒否する
 * （実行中の commitListingItems が initialized=true / listingSeenIds を書き戻し、削除と競合するため）。
 * 削除した記事数を返す。
 */
export async function resetSource(sourceId: string): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const progress = await loadProgress();
  if (isLockActive(progress)) {
    return { ok: false, deleted: 0, error: "更新の実行中は削除できません" };
  }

  const db = getDb();
  const articleIds = (await db.articles.where("sourceId").equals(sourceId).primaryKeys()) as string[];

  await db.articles.bulkDelete(articleIds);
  if (articleIds.length > 0) {
    await db.chats.bulkDelete(articleIds);
  }

  const source = await db.sources.get(sourceId);
  if (source) {
    await db.sources.update(sourceId, {
      initialized: false,
      listingSeenIds: [],
      etag: undefined,
      lastModified: undefined,
      lastStatus: undefined,
      lastError: undefined,
      lastItemCount: undefined,
      lastFetchMode: undefined,
    });
  }

  return { ok: true, deleted: articleIds.length };
}

/** ロックを確認し、実行中でなければ running:true にして獲得する */
async function acquireLock(trigger: PipelineTrigger): Promise<boolean> {
  const current = await loadProgress();
  if (isLockActive(current)) {
    return false;
  }
  const now = Date.now();
  await saveProgress({
    ...structuredClone(IDLE_PROGRESS),
    running: true,
    trigger,
    startedAt: now,
    phase: "feeds",
  });
  return true;
}

/**
 * ロック中に来た alarm/manual の実行要求を記録する（取りこぼし防止）。
 * FETCH_NOW がロック中で runPipeline を呼ばずに即応答するケースと、
 * runPipeline 自身がロック獲得に失敗したケースの両方から呼ばれる。
 */
export async function queuePendingTrigger(trigger: PipelineTrigger): Promise<void> {
  await chrome.storage.session.set({ [PENDING_TRIGGER_KEY]: trigger });
}

/** 記録されている pendingTrigger を取り出して消す（無ければ undefined） */
async function takePendingTrigger(): Promise<PipelineTrigger | undefined> {
  const stored = await chrome.storage.session.get(PENDING_TRIGGER_KEY);
  const trigger = stored[PENDING_TRIGGER_KEY] as PipelineTrigger | undefined;
  if (trigger !== undefined) {
    await chrome.storage.session.remove(PENDING_TRIGGER_KEY);
  }
  return trigger;
}

export interface RunPipelineOptions {
  /**
   * true の場合、3.（フィード取得）を飛ばして 4.（取り残し回収）+ 5.（要約）だけを行う。
   * onStartup（ブラウザ起動直後の取り残し処理）用。ロック・keepAlive・progress 更新・
   * 後片付け（offscreen release / 通知 / keepAlive.stop / running=false）は
   * 通常の実行と同じ枠組みに乗せる。lastRunAt はフィード取得を伴わないため更新しない。
   */
  recoverOnly?: boolean;
}

/** §8: 取得・要約パイプライン本体 */
export async function runPipeline(
  trigger: PipelineTrigger,
  options?: RunPipelineOptions,
): Promise<{ started: boolean; reason?: string }> {
  const acquired = await acquireLock(trigger);
  if (!acquired) {
    // 実行中に来た alarm/manual は、現在の実行が終わった直後に拾い直せるよう記録しておく
    if (trigger === "alarm" || trigger === "manual") {
      await queuePendingTrigger(trigger).catch(() => undefined);
    }
    return { started: false, reason: "既に更新処理が実行中です" };
  }

  keepAlive.start();
  let newCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  let offscreenAcquired = false;

  try {
    try {
      await offscreenPool.acquire();
      offscreenAcquired = true;
    } catch {
      // offscreen 起動に失敗しても、記事ごとの抽出時に再試行されるため処理は続行する
    }

    const settings = await loadSettings();
    let ids: string[];

    if (options?.recoverOnly) {
      await updateProgress({ phase: "summarizing", feedsTotal: 0, feedsDone: 0 });
      ids = await recoverOrphans();
    } else {
      const sources = await upsertSources(settings);

      // 3. FEEDS
      await updateProgress({ phase: "feeds", feedsTotal: sources.length, feedsDone: 0 });
      await mapLimit(sources, FEED_CONCURRENCY, async (source) => {
        const added = await processSource(source, settings);
        newCount += added;
        await updateProgress((c) => ({ feedsDone: c.feedsDone + 1, newCount }));
      });

      // 4. 取り残し回収
      ids = await recoverOrphans();
    }

    // 5. SUMMARIZE
    await updateProgress({ phase: "summarizing", articlesTotal: ids.length, articlesDone: 0 });
    const result = await summarizeBatch(ids, settings);
    doneCount = result.doneCount;
    errorCount = result.errorCount;
    await updateProgress((c) => ({ phase: "done", errors: [...c.errors, ...result.errors] }));

    return { started: true };
  } finally {
    // 6. 後片付け。どこかが失敗しても keepAlive.stop() と running=false には必ず到達させる。
    if (offscreenAcquired) {
      await offscreenPool.release().catch(() => undefined);
    }

    let settings: Settings | undefined;
    try {
      settings = await loadSettings();
    } catch {
      // 設定読み込みに失敗しても後片付けは続行する
    }
    if (settings) {
      await notifyRun(newCount, doneCount, errorCount, settings).catch(() => undefined);
      // recoverOnly はフィード取得を行っていないので lastRunAt は更新しない
      if (!options?.recoverOnly) {
        await saveSettings({ lastRunAt: Date.now() }).catch(() => undefined);
      }
    }

    keepAlive.stop();
    await updateProgress({ running: false, phase: "done", finishedAt: Date.now() }).catch(() => undefined);

    const pending = await takePendingTrigger().catch(() => undefined);
    if (pending) {
      void runPipeline(pending);
    }
  }
}
