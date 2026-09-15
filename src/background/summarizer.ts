// §8-5: 記事1件分の「本文取得 → offscreen抽出 → Claude要約」処理。

import type { PipelineProgress, Settings } from "../shared/types";
import { getDb } from "../shared/db";
import {
  MIN_PAGE_TEXT_CHARS,
  MIN_RSS_TEXT_CHARS,
  NEW_ITEM_GRACE_MS,
  PAGE_FETCH_TIMEOUT_MS,
  PAGE_MAX_BYTES,
} from "../shared/constants";
import { fetchArticleHtml } from "./articleFetcher";
import { extractViaOffscreen } from "./offscreenClient";
import { summarizeArticle, describeApiError, isBillingOrAuthError } from "../lib/claudeClient";
import type { ContentSource } from "../lib/prompts";
import { updateProgress } from "./progress";

/** 本文を truncate してから DB に保存する（maxContentChars まで） */
function truncateForStorage(text: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  return text.length <= limit ? text : text.slice(0, limit);
}

/** ページ本文取得の結果。text が空文字列なら取得・抽出に失敗している */
interface PageFetchResult {
  text: string;
  /** ExtractResult.publishedAt（§10 の探索順で見つかった公開日時） */
  publishedAt?: number;
}

/** article.url からページ本文を取得し、Readability で抽出した本文・公開日を返す（失敗時は空文字列） */
async function fetchPageText(url: string): Promise<PageFetchResult> {
  const html = await fetchArticleHtml(url, PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES);
  if (html === null) return { text: "" };
  const result = await extractViaOffscreen(html, url);
  return { text: result.text, publishedAt: result.publishedAt };
}

/** summarizeOne の結果。呼び出し側（summarizeBatch）が課金・認証エラーによる打ち切り判定に使う */
export interface SummarizeOneResult {
  billingOrAuthError: boolean;
  /**
   * §8-5: 一覧経路で登録時に公開日が不明だった記事（publishedAt が仮値 = createdAt）について、
   * ページから取れた本当の公開日が基準（source.latestPublishedAt - NEW_ITEM_GRACE_MS）以下だったため、
   * 要約せず記事行を削除した場合 true。呼び出し側は newCount から差し引き、errors には入れない。
   */
  skippedOld?: boolean;
}

/**
 * 記事1件を要約する。
 * progress を渡した場合（パイプラインのバッチ処理から呼ばれる場合）は、完了時に
 * articlesDone をインクリメントして PROGRESS を送信する。RESUMMARIZE / REFETCH_CONTENT の
 * ような単発実行では progress を渡さず、進捗バーには影響させない。
 *
 * skipInitialTransition: true の場合、status を "summarizing" にする最初の更新を行わない。
 * 呼び出し側（resummarize / refetchContent）が「"new" を経由せず直接 summarizing へ遷移させる」
 * ために、この関数を呼ぶ前に自分で status:"summarizing" を書き込み済みであることを示す
 * （経由すると、その間に並行実行中の runPipeline の recoverOrphans が同じ記事を "new" として
 * 拾ってしまい、二重要約になり得るため）。
 *
 * allowDeleteOld: true の場合のみ、§8-5 の「仮公開日記事が実は基準以下の過去記事だった」判定で
 * 記事行を削除する。runPipeline のバッチ経路（summarizeBatch）だけが true を渡す。
 * RESUMMARIZE / REFETCH_CONTENT の単発実行（ユーザーの明示操作）では false（既定）のままにし、
 * 削除はせず publishedAt を実日付に更新したうえで通常どおり要約する
 * （ユーザーが操作したカードが黙って消えないようにするため）。
 */
export async function summarizeOne(
  articleId: string,
  settings: Settings,
  progress?: PipelineProgress,
  options?: { skipInitialTransition?: boolean; allowDeleteOld?: boolean },
): Promise<SummarizeOneResult> {
  const db = getDb();
  const article = await db.articles.get(articleId);
  if (!article) return { billingOrAuthError: false };

  if (!options?.skipInitialTransition) {
    await db.articles.update(articleId, { status: "summarizing", summarizingAt: Date.now(), error: undefined });
  }

  try {
    const source = await db.sources.get(article.sourceId);
    const sourceName = source?.name ?? article.sourceId;

    // ページ本文の取得を試み、文字数が足りなければ RSS 概要にフォールバックする
    let contentSource: ContentSource = "none";
    let text = "";
    let pagePublishedAt: number | undefined;
    try {
      const pageResult = await fetchPageText(article.url);
      pagePublishedAt = pageResult.publishedAt;
      if (pageResult.text.length >= MIN_PAGE_TEXT_CHARS) {
        contentSource = "page";
        text = pageResult.text;
      }
    } catch {
      // ページ取得・抽出の失敗は RSS 概要へのフォールバックとして扱う
    }

    // ページから公開日が取れ、Article.publishedAt が取得時刻の仮値（createdAt と等しい。
    // 一覧経路で登録時に公開日が不明だった記事）なら、要約の成否・スキップにかかわらず、
    // 本文取得直後（この後の要約スキップ判定より前）に §8-5 の判定を行う。
    if (pagePublishedAt !== undefined && article.publishedAt === article.createdAt) {
      const threshold = (source?.latestPublishedAt ?? -Infinity) - NEW_ITEM_GRACE_MS;
      if (options?.allowDeleteOld && pagePublishedAt <= threshold) {
        // 本当は基準以下（新着ではない）過去記事だった。タイトルだけの要約に課金しないよう、
        // Claude を呼ばず記事行そのものを削除する（progress.errors には入れず newCount から減らす）。
        // runPipeline のバッチ経路（allowDeleteOld:true）だけがこの分岐に入る。
        await db.articles.delete(articleId);
        return { billingOrAuthError: false, skippedOld: true };
      }
      // 単発実行（allowDeleteOld:false）で基準以下だった場合も含め、削除はせず
      // publishedAt を実日付に更新したうえで通常どおり要約する。
      await db.articles.update(articleId, { publishedAt: pagePublishedAt });
      article.publishedAt = pagePublishedAt;
      if (source && pagePublishedAt > (source.latestPublishedAt ?? -Infinity)) {
        await db.sources.update(source.id, { latestPublishedAt: pagePublishedAt });
      }
    }

    if (contentSource === "none") {
      const rssSummary = article.rssSummary ?? "";
      if (rssSummary.length >= MIN_RSS_TEXT_CHARS) {
        contentSource = "rss";
        text = rssSummary;
      } else {
        text = rssSummary;
      }
    }

    // §8-5: 本文もRSS概要も無い（一覧経路など）場合は、タイトルだけの要約に課金しないよう
    // Claude を呼ばずにスキップする
    if (contentSource === "none" && !article.rssSummary) {
      const current = await db.articles.get(articleId);
      await db.articles.update(articleId, {
        status: "error",
        error: "本文を取得できなかったため要約をスキップしました",
        attempts: (current?.attempts ?? 0) + 1,
        summarizingAt: undefined,
      });
      return { billingOrAuthError: false };
    }

    const contentText = truncateForStorage(text, settings.maxContentChars);

    const summary = await summarizeArticle({
      apiKey: settings.apiKey,
      model: settings.model,
      effort: settings.effort,
      article: {
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        sourceName,
      },
      text: contentText,
      contentSource,
      maxContentChars: settings.maxContentChars,
    });

    await db.articles.update(articleId, {
      status: "done",
      summary,
      contentText,
      contentSource,
      contentChars: contentText.length,
      model: settings.model,
      summarizedAt: Date.now(),
      summarizingAt: undefined,
      error: undefined,
    });
    return { billingOrAuthError: false };
  } catch (err) {
    const current = await db.articles.get(articleId);
    await db.articles.update(articleId, {
      status: "error",
      error: describeApiError(err),
      attempts: (current?.attempts ?? 0) + 1,
      summarizingAt: undefined,
    });
    return { billingOrAuthError: isBillingOrAuthError(err) };
  } finally {
    if (progress) {
      await updateProgress((current) => ({ articlesDone: current.articlesDone + 1 }));
    }
  }
}
