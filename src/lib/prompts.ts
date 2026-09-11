// Claude 連携用のプロンプト文字列を組み立てる純粋関数群。

import type { Summary } from "../shared/types";

/** 要約生成の system プロンプト（固定文字列。キャッシュ効率のため一切変更しない） */
export const SUMMARY_SYSTEM = `あなたは海外テック企業のエンジニアリングブログを日本の技術者向けに紹介する編集者です。与えられた記事を読み、日本語で3段階の要約をJSONで返してください。
- headline: 記事の内容が一目で分かる日本語の見出し（40字以内。原題の直訳ではなく内容を表す）
- brief: 3文程度のざっくり紹介（何についての記事か、なぜ注目に値するか）
- digest: 忙しい人向けの要点まとめ。3〜7項目の箇条書き。各項目1〜2文で、具体的な数値・技術名・結論を含める
- detail: より詳しく分かりやすい解説（400〜800字）。背景→課題→アプローチ→結果→学びの順。専門用語には短い補足を添える。段落は改行で区切り、マークダウン記法は使わない
- tags: 技術トピックのタグを最大5つ
固有名詞・製品名・技術名は原語のまま。記事に書かれていないことは推測しない。本文の取得元が「RSS概要」の場合は分かる範囲で書き、detail の末尾に「（本文を取得できなかったためRSSの概要に基づく要約）」と付記する。`;

/** チャット（記事についての質問応答）の system プロンプト固定文（メタ情報・記事本文を付加する前の部分） */
const CHAT_SYSTEM_FIXED =
  "あなたは技術記事についての質問に日本語で答えるアシスタントです。以下の記事の内容に基づいて回答し、記事に書かれていない事柄は「記事には記載がありません」と明示したうえで一般知識として補足してください。";

/** 本文の取得元 */
export type ContentSource = "page" | "rss" | "none";

const CONTENT_SOURCE_LABEL: Record<ContentSource, string> = {
  page: "ページ本文",
  rss: "RSS概要",
  none: "なし",
};

interface ArticleMeta {
  title: string;
  url: string;
  /** 公開日時（epoch ミリ秒） */
  publishedAt: number;
  sourceName: string;
}

/** epoch ミリ秒を YYYY-MM-DD（UTC）の文字列にする */
function formatDate(publishedAt: number): string {
  return new Date(publishedAt).toISOString().slice(0, 10);
}

function buildMetaLines(article: ArticleMeta): string {
  return [
    `タイトル: ${article.title}`,
    `ソース名: ${article.sourceName}`,
    `URL: ${article.url}`,
    `公開日: ${formatDate(article.publishedAt)}`,
  ].join("\n");
}

/** text を maxChars 文字に切り詰める。切り詰めた場合は末尾に「（以下省略）」を付ける */
function truncate(text: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}（以下省略）`;
}

/** 要約生成の user ターンを組み立てる */
export function buildSummaryUser(
  article: ArticleMeta,
  text: string,
  contentSource: ContentSource,
  maxChars: number,
): string {
  const metaLines = [
    `タイトル: ${article.title}`,
    `ソース名: ${article.sourceName}`,
    `URL: ${article.url}`,
    `公開日: ${formatDate(article.publishedAt)}`,
    `本文の取得元: ${CONTENT_SOURCE_LABEL[contentSource]}`,
  ].join("\n");
  const body = truncate(text, maxChars);
  return `${metaLines}\n\n<article>\n${body}\n</article>`;
}

/** チャットの system プロンプトを組み立てる（記事メタ情報 + 本文はキャッシュ対象の安定プレフィックス） */
export function buildChatSystem(article: ArticleMeta, contentText: string): string {
  const metaLines = buildMetaLines(article);
  return `${CHAT_SYSTEM_FIXED}\n\n${metaLines}\n\n<article>\n${contentText}\n</article>`;
}

/** Summary をチャット用のプレーンテキストに変換する（本文が無いときの代替コンテキスト） */
export function summaryAsText(summary: Summary): string {
  const digestLines = summary.digest.map((item) => `- ${item}`).join("\n");
  return [summary.headline, summary.brief, digestLines, summary.detail]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
