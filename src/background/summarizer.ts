// §8-5: 記事1件分の「本文取得 → offscreen抽出 → Claude要約」処理。

import type { PipelineProgress, Settings } from "../shared/types";
import { getDb } from "../shared/db";
import {
  MIN_PAGE_TEXT_CHARS,
  MIN_RSS_TEXT_CHARS,
  PAGE_FETCH_TIMEOUT_MS,
  PAGE_MAX_BYTES,
} from "../shared/constants";
import { fetchArticleHtml } from "./articleFetcher";
import { extractViaOffscreen } from "./offscreenClient";
import { summarizeArticle, describeApiError } from "../lib/claudeClient";
import type { ContentSource } from "../lib/prompts";
import { updateProgress } from "./progress";

/** 本文を truncate してから DB に保存する（maxContentChars まで） */
function truncateForStorage(text: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  return text.length <= limit ? text : text.slice(0, limit);
}

/** article.url からページ本文を取得し、Readability で抽出した本文を返す（失敗時は空文字列） */
async function fetchPageText(url: string): Promise<string> {
  const html = await fetchArticleHtml(url, PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES);
  if (html === null) return "";
  const result = await extractViaOffscreen(html, url);
  return result.text;
}

/**
 * 記事1件を要約する。
 * progress を渡した場合（パイプラインのバッチ処理から呼ばれる場合）は、完了時に
 * articlesDone をインクリメントして PROGRESS を送信する。RESUMMARIZE / REFETCH_CONTENT の
 * ような単発実行では progress を渡さず、進捗バーには影響させない。
 */
export async function summarizeOne(
  articleId: string,
  settings: Settings,
  progress?: PipelineProgress,
): Promise<void> {
  const db = getDb();
  const article = await db.articles.get(articleId);
  if (!article) return;

  await db.articles.update(articleId, { status: "summarizing", summarizingAt: Date.now() });

  try {
    const source = await db.sources.get(article.sourceId);
    const sourceName = source?.name ?? article.sourceId;

    // ページ本文の取得を試み、文字数が足りなければ RSS 概要にフォールバックする
    let contentSource: ContentSource = "none";
    let text = "";
    try {
      const pageText = await fetchPageText(article.url);
      if (pageText.length >= MIN_PAGE_TEXT_CHARS) {
        contentSource = "page";
        text = pageText;
      }
    } catch {
      // ページ取得・抽出の失敗は RSS 概要へのフォールバックとして扱う
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
  } catch (err) {
    const current = await db.articles.get(articleId);
    await db.articles.update(articleId, {
      status: "error",
      error: describeApiError(err),
      attempts: (current?.attempts ?? 0) + 1,
      summarizingAt: undefined,
    });
  } finally {
    if (progress) {
      await updateProgress((current) => ({ articlesDone: current.articlesDone + 1 }));
    }
  }
}
