// §8-3 / §9.5 共通: 新着判定・上限適用・bulkAdd・source 更新。
// フィード経路（mode:"feed"）と一覧経路（mode:"listing"）の両方から呼ばれる。
//
// 新着判定は「見たことがあるID集合」ではなく「公開日が基準より新しいか」で行う
// （DB未登録＝新着ではない。フィードにも一覧にも過去記事が並ぶため）。

import Dexie from "dexie";
import type { Article, Settings, Source } from "../shared/types";
import type { FeedItem } from "../lib/feedParser";
import { getDb } from "../shared/db";
import { htmlToText } from "../lib/htmlToText";
import { NEW_ITEM_GRACE_MS } from "../shared/constants";

/** commitNewItems への入力1件。id は呼び出し側で sha256Hex(normalizeUrl(item.link)) 済みのもの */
export interface CommitCandidate {
  id: string;
  item: FeedItem;
}

export interface CommitResult {
  /** 新規に db.articles へ登録できた件数 */
  added: number;
  /** 上限（maxNewPerSourcePerRun）を超えて次回に繰り越した件数。初期化済みソースのみで発生しうる */
  carriedOver: number;
  /** この実行後の source.latestPublishedAt（更新が無ければ呼び出し前の値のまま） */
  latestPublishedAt?: number;
}

/**
 * §8-3 / §9.5: 新着判定・上限適用・bulkAdd・source 更新をまとめて行う。
 *
 * 基準 = (source.latestPublishedAt ?? -Infinity) - NEW_ITEM_GRACE_MS。公開日がこの基準より
 * 新しい候補だけを対象にする（猶予 3 日ぶんは基準以下でも拾う。並び順や時差のズレ対策）。
 *
 * - 未初期化、または source.latestPublishedAt が未設定（旧版からの移行）: 公開日が判明している
 *   候補のうち publishedAt 最新の1件を選ぶ。その1件が既に DB にあれば登録は 0 件だが、
 *   latestPublishedAt はその公開日に設定する（設定しないと毎回「最新1件」判定に留まってしまうため）。
 * - 初期化済み: 基準を超える候補のうち DB に無いものを publishedAt の古い順に
 *   settings.maxNewPerSourcePerRun 件まで登録する。latestPublishedAt は、繰り越しが無い回
 *   （carriedOver === 0）は「基準を超えた候補のうち登録した分と既に DB にあった分」の最大値まで、
 *   **繰り越しがある回（carriedOver > 0）は登録した分（addedKnown）の最大値まで**しか進めない
 *   （既登録分の新しい日付で latestPublishedAt が繰り越し候補を飛び越えてしまうと、
 *    その繰り越し候補が次回以降ずっと基準以下になり永久に拾われなくなるため）。
 *   既登録が猶予内に並んでいても上限の枠をそれらに食い潰されて新着が登録できなくなることはない。
 *   上限を超えてまだ DB に無いまま残った分だけを carriedOver として繰り越す（次回の実行で拾われる。何も失わない）。
 *
 * mode:"feed" では公開日不明の候補は捨てる（RSS で日付が無いのは稀）。
 * mode:"listing" では公開日不明の候補も Article.publishedAt = createdAt（取得時刻の仮値）で
 * 登録するが、文書順（candidates の並び順）の先頭1件までに絞り、DB 存在チェックで絞り込む
 * （一覧の並びが新しい順である前提で、過去記事を大量に拾わないため）。ただし未初期化のときは
 * 公開日ありの候補があればその最新1件を選ぶのみに留め、公開日不明の候補は追加しない
 * （合計で常に1件。公開日ありの候補が無い場合だけ公開日不明の文書順先頭1件にフォールバックする。
 *  §0 の「初回は各ブログ最新1件」を一覧経路でも守るため）。
 * ページ取得時に公開日が判明したら summarizer.ts 側が §8-5 の判定と
 * source.latestPublishedAt の更新を行う（公開日不明の候補はここでは latestPublishedAt を進めない）。
 *
 * etag / lastModified の更新は呼び出し側（フィード経路のみ）の責務。
 */
export async function commitNewItems(
  source: Source,
  settings: Settings,
  candidates: CommitCandidate[],
  mode: "feed" | "listing",
): Promise<CommitResult> {
  const db = getDb();

  // 同じ id が複数回出てくることがある（フィードが同じ記事を複数エントリで掲載している等）ため、
  // 先に現れたものだけ残して dedupe する。
  const deduped: CommitCandidate[] = [];
  const seenIds = new Set<string>();
  for (const c of candidates) {
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    deduped.push(c);
  }

  const threshold = (source.latestPublishedAt ?? -Infinity) - NEW_ITEM_GRACE_MS;
  const uninitialized = !source.initialized || source.latestPublishedAt === undefined;

  const known = deduped.filter((c) => c.item.publishedAt !== undefined);
  const eligible = known.filter((c) => c.item.publishedAt!.getTime() > threshold);

  // 公開日が判明していて実際に db.articles へ追加する候補
  let addedKnown: CommitCandidate[] = [];
  let carriedOver = 0;
  // 「基準を超えた候補のうち登録した分・既登録分」の最大 publishedAt（未定なら latestPublishedAt を進めない）
  let knownLatest: number | undefined;
  // 未初期化バックフィルで公開日ありの候補を選べたかどうか（listing モードで公開日不明の
  // フォールバックを抑止するために使う。§9.5: 未初期化のときは合計1件に絞る）
  let uninitializedChosenKnown: CommitCandidate | undefined;

  if (uninitialized) {
    // 初回バックフィル: 公開日が判明している中で最新の1件を選ぶ
    let chosen: CommitCandidate | undefined;
    for (const c of eligible) {
      if (!chosen || c.item.publishedAt!.getTime() > chosen.item.publishedAt!.getTime()) {
        chosen = c;
      }
    }
    uninitializedChosenKnown = chosen;
    if (chosen) {
      knownLatest = chosen.item.publishedAt!.getTime();
      const [alreadyExists] = await db.articles.bulkGet([chosen.id]);
      if (alreadyExists === undefined) {
        addedKnown = [chosen];
      }
      // 既に DB にあっても登録は 0 件のまま。latestPublishedAt だけは進め、
      // 次回から「初期化済み」の通常判定に移れるようにする。
    }
  } else {
    const sortedAsc = [...eligible].sort(
      (a, b) => a.item.publishedAt!.getTime() - b.item.publishedAt!.getTime(),
    );
    const existingFlags =
      sortedAsc.length > 0 ? await db.articles.bulkGet(sortedAsc.map((c) => c.id)) : [];
    const alreadyExisting: CommitCandidate[] = [];
    const notInDb: CommitCandidate[] = [];
    sortedAsc.forEach((c, i) => {
      if (existingFlags[i] !== undefined) alreadyExisting.push(c);
      else notInDb.push(c);
    });

    const limit = Math.max(0, Math.floor(settings.maxNewPerSourcePerRun) || 0);
    addedKnown = notInDb.slice(0, limit);
    // 上限を超えてまだ DB に無いまま残った分だけを繰り越す（既登録分は枠を消費していない）
    carriedOver = Math.max(0, notInDb.length - limit);

    // 繰り越しがある回は、既登録分の新しい日付で latestPublishedAt が繰り越し候補を
    // 飛び越えないよう、登録した分（addedKnown）の最大値までしか進めない。
    const countedCandidates = carriedOver > 0 ? addedKnown : [...addedKnown, ...alreadyExisting];
    const countedDates = countedCandidates.map((c) => c.item.publishedAt!.getTime());
    if (countedDates.length > 0) {
      knownLatest = Math.max(...countedDates);
    }
  }

  // mode:"listing" のみ: 公開日不明の候補を文書順の先頭1件まで対象にし、DB 存在チェックで絞る。
  // ただし未初期化バックフィルで公開日ありの候補を選べた場合は、公開日不明の候補は追加しない
  // （未初期化のときは合計1件に絞るため。§9.5）。
  const skipUnknownForUninitializedBackfill = uninitialized && uninitializedChosenKnown !== undefined;
  const unknownCandidate: CommitCandidate[] =
    mode === "listing" && !skipUnknownForUninitializedBackfill
      ? deduped.filter((c) => c.item.publishedAt === undefined).slice(0, 1)
      : [];
  const unknownExisting =
    unknownCandidate.length > 0 ? await db.articles.bulkGet(unknownCandidate.map((c) => c.id)) : [];
  const addedUnknown = unknownCandidate.filter((_, i) => unknownExisting[i] === undefined);

  const toAdd = [...addedKnown, ...addedUnknown];

  let addedCount = 0;
  if (toAdd.length > 0) {
    const now = Date.now();
    const articles: Article[] = toAdd.map(({ item, id }) => ({
      id,
      sourceId: source.id,
      guid: item.guid,
      title: item.title,
      url: item.link,
      // publishedAt 未知の候補（一覧経路のみ）は createdAt（取得時刻）を仮値として使う
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
      // bulkAdd は非トランザクション的に「入れられるものは入れる」ので、重複キー等で
      // 一部が失敗しても成功した分は保存されている。失敗数を差し引いて数える。
      if (err instanceof Dexie.BulkError) {
        addedCount = articles.length - err.failures.length;
      } else {
        throw err;
      }
    }
  }

  let latestPublishedAt = source.latestPublishedAt;
  if (knownLatest !== undefined) {
    latestPublishedAt = latestPublishedAt === undefined ? knownLatest : Math.max(latestPublishedAt, knownLatest);
  }

  await db.sources.update(source.id, {
    initialized: true,
    latestPublishedAt,
    lastFetchedAt: Date.now(),
    lastItemCount: candidates.length,
    lastStatus: "ok",
    lastError: undefined,
    lastFetchMode: mode,
  });

  return { added: addedCount, carriedOver, latestPublishedAt };
}
