// §8: 取得・要約パイプライン本体。runPipeline がフィード取得〜要約〜通知までの一連の流れを担う。

import Dexie from "dexie";
import type { Article, Settings, Source } from "../shared/types";
import { getDb } from "../shared/db";
import { DEFAULT_SOURCES } from "../shared/sources";
import { IDLE_PROGRESS, loadProgress, loadSettings, saveProgress, saveSettings } from "../shared/settings";
import { FEED_CONCURRENCY, FEED_FETCH_TIMEOUT_MS, LOCK_STALE_MS, SUMMARIZING_STALE_MS } from "../shared/constants";
import { sha256Hex } from "../lib/hash";
import { normalizeUrl } from "../lib/urlNormalize";
import { htmlToText } from "../lib/htmlToText";
import { parseFeed, filterByCategory, NotXmlError, type FeedItem } from "../lib/feedParser";
import { mapLimit } from "../lib/concurrency";
import { fetchFeed, testFeed as testFeedImpl } from "./feedFetcher";
import { summarizeOne } from "./summarizer";
import { closeOffscreen } from "./offscreenClient";
import { notifyRun } from "./notifications";
import { updateProgress, getProgress } from "./progress";
import * as keepAlive from "./keepAlive";

export type PipelineTrigger = "alarm" | "manual" | "install";

/** 設定ページの「フィード接続テスト」（messageRouter からそのまま re-export して使う） */
export const testFeed = testFeedImpl;

/**
 * 有効ソースを feedUrlOverrides でマージして db.sources に upsert する。
 * 既存の etag/lastModified/initialized/lastFetchedAt/lastStatus/lastError/lastItemCount は維持する
 * （ただし feedUrl 自体が変わった場合は etag/lastModified は無効になるためリセットする）。
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
    };
  });

  await db.sources.bulkPut(merged);
  return merged;
}

/** publishedAt 降順でソートする（無いものは最も古い扱い） */
function sortByPublishedDesc(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/** 1ソース分のフィード取得〜新着記事の bulkAdd を行う。新規追加できた記事数を返す */
async function processSource(source: Source, settings: Settings): Promise<number> {
  const db = getDb();
  try {
    const result = await fetchFeed(
      source.feedUrl,
      { etag: source.etag, lastModified: source.lastModified },
      FEED_FETCH_TIMEOUT_MS,
    );

    if (result.notModified || result.text === undefined) {
      await db.sources.update(source.id, { lastFetchedAt: Date.now(), lastStatus: "ok" });
      return 0;
    }

    const { items } = parseFeed(result.text);
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
      etag: result.etag,
      lastModified: result.lastModified,
      lastFetchedAt: Date.now(),
      lastStatus: "ok",
      lastError: undefined,
      lastItemCount: items.length,
    });

    return addedCount;
  } catch (err) {
    const message = err instanceof NotXmlError ? err.message : err instanceof Error ? err.message : String(err);
    await db.sources.update(source.id, {
      lastFetchedAt: Date.now(),
      lastStatus: "error",
      lastError: message,
    });
    return 0;
  }
}

/**
 * 取り残し回収。status:"new" の全件と、summarizingAt が SUMMARIZING_STALE_MS 以上前
 * （または未設定）の status:"summarizing" の記事（SW 死亡による取り残し）を
 * "new" に戻して対象IDの一覧を返す。まだ新しい summarizingAt を持つ記事は、
 * RESUMMARIZE / REFETCH_CONTENT の単発実行がまさに処理中の可能性があるため対象にしない
 * （そうしないと二重要約になってしまう）。
 */
export async function recoverOrphans(): Promise<string[]> {
  const db = getDb();
  const newArticles = await db.articles.where("status").equals("new").toArray();
  const summarizingArticles = await db.articles.where("status").equals("summarizing").toArray();

  const now = Date.now();
  const stale = summarizingArticles.filter((a) => now - (a.summarizingAt ?? 0) >= SUMMARIZING_STALE_MS);

  if (stale.length > 0) {
    await db.articles.bulkPut(stale.map((a) => ({ ...a, status: "new" as const, summarizingAt: undefined })));
  }

  return [...newArticles.map((a) => a.id), ...stale.map((a) => a.id)];
}

export interface SummarizeBatchResult {
  doneCount: number;
  errorCount: number;
  errors: string[];
}

/** §8-5: 記事IDの一覧を summaryConcurrency 並列で要約する */
export async function summarizeBatch(ids: string[], settings: Settings): Promise<SummarizeBatchResult> {
  if (ids.length === 0) {
    return { doneCount: 0, errorCount: 0, errors: [] };
  }
  if (!settings.apiKey) {
    return { doneCount: 0, errorCount: 0, errors: ["APIキー未設定"] };
  }

  const progress = await getProgress();
  await mapLimit(ids, settings.summaryConcurrency, (id) => summarizeOne(id, settings, progress));

  const db = getDb();
  const articles = await db.articles.bulkGet(ids);
  let doneCount = 0;
  const errors: string[] = [];
  for (const article of articles) {
    if (!article) continue;
    if (article.status === "done") doneCount++;
    else if (article.status === "error") errors.push(`${article.title}: ${article.error ?? "不明なエラー"}`);
  }
  return { doneCount, errorCount: errors.length, errors };
}

/** 現在 runPipeline がロックを保持して実行中かどうか（単発実行が offscreen を閉じてよいかの判定に使う） */
async function isPipelineRunning(): Promise<boolean> {
  const progress = await loadProgress();
  return (
    progress.running && progress.startedAt !== undefined && Date.now() - progress.startedAt < LOCK_STALE_MS
  );
}

/** 指定記事を status:"new" に戻して1件だけ要約し直す（§13-2: keepAlive で挟む） */
export async function resummarize(articleId: string): Promise<void> {
  const db = getDb();
  await db.articles.update(articleId, { status: "new", summarizingAt: undefined });
  const settings = await loadSettings();
  keepAlive.start();
  try {
    await summarizeOne(articleId, settings);
  } finally {
    // runPipeline が実行中なら offscreen はまだ使われているので閉じない
    if (!(await isPipelineRunning())) {
      await closeOffscreen();
    }
    keepAlive.stop();
  }
}

/** 指定記事の本文（contentText）を消し、再取得したうえで再要約する（§13-2: keepAlive で挟む） */
export async function refetchContent(articleId: string): Promise<void> {
  const db = getDb();
  await db.articles.update(articleId, {
    status: "new",
    contentText: undefined,
    contentSource: "none",
    contentChars: 0,
    summarizingAt: undefined,
  });
  const settings = await loadSettings();
  keepAlive.start();
  try {
    await summarizeOne(articleId, settings);
  } finally {
    if (!(await isPipelineRunning())) {
      await closeOffscreen();
    }
    keepAlive.stop();
  }
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

/** ロックを確認し、実行中でなければ running:true にして獲得する */
async function acquireLock(trigger: PipelineTrigger): Promise<boolean> {
  const current = await loadProgress();
  const now = Date.now();
  if (current.running && current.startedAt !== undefined && now - current.startedAt < LOCK_STALE_MS) {
    return false;
  }
  await saveProgress({
    ...structuredClone(IDLE_PROGRESS),
    running: true,
    trigger,
    startedAt: now,
    phase: "feeds",
  });
  return true;
}

export interface RunPipelineOptions {
  /**
   * true の場合、3.（フィード取得）を飛ばして 4.（取り残し回収）+ 5.（要約）だけを行う。
   * onStartup（ブラウザ起動直後の取り残し処理）用。ロック・keepAlive・progress 更新・
   * 後片付け（offscreen close / 通知 / lastRunAt / keepAlive.stop / running=false）は
   * 通常の実行と同じ枠組みに乗せる。
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
    return { started: false, reason: "既に更新処理が実行中です" };
  }

  keepAlive.start();
  let newCount = 0;
  let doneCount = 0;
  let errorCount = 0;

  try {
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
    await closeOffscreen();

    let settings: Settings | undefined;
    try {
      settings = await loadSettings();
    } catch {
      // 設定読み込みに失敗しても後片付けは続行する
    }
    if (settings) {
      await notifyRun(newCount, doneCount, errorCount, settings).catch(() => undefined);
      await saveSettings({ lastRunAt: Date.now() }).catch(() => undefined);
    }

    keepAlive.stop();
    await updateProgress({ running: false, phase: "done", finishedAt: Date.now() }).catch(() => undefined);
  }
}
