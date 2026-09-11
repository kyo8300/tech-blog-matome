// Claude API 連携。Service Worker とアプリページ（DOM あり）の両方から使うため、
// DOM API・chrome.* API には依存しないこと。

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Summary } from "../shared/types";
import { USE_FALLBACKS } from "../shared/constants";
import { SummarySchema, parseSummaryText } from "./summarySchema";
import { SUMMARY_SYSTEM, buildSummaryUser, buildChatSystem, type ContentSource } from "./prompts";

/** 記事メタ情報（要約・チャットの共通入力） */
interface ArticleMeta {
  title: string;
  url: string;
  /** 公開日時（epoch ミリ秒） */
  publishedAt: number;
  sourceName: string;
}

/**
 * Claude クライアントを生成する。
 * SW・アプリページどちらのコンテキストでも動くよう `dangerouslyAllowBrowser: true` を指定する
 * （実行環境はブラウザ拡張のみで、キーはユーザー本人の chrome.storage.local に保存される）。
 */
export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3, timeout: 120_000 });
}

/** Claude が要約生成を拒否した（stop_reason === "refusal"）ときに投げるエラー */
export class SummaryRefusedError extends Error {
  category?: string;
  explanation?: string;

  constructor(category?: string | null, explanation?: string | null) {
    super(`Claudeが要約を拒否しました（カテゴリ: ${category ?? "不明"}）`);
    this.name = "SummaryRefusedError";
    this.category = category ?? undefined;
    this.explanation = explanation ?? undefined;
  }
}

/** USE_FALLBACKS が true のときだけ、拒否フォールバック用の beta パラメータを付加する */
function fallbackParams(): { betas: ["server-side-fallback-2026-07-01"]; fallbacks: "default" } | Record<string, never> {
  return USE_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

/** 記事1本を要約する（SW から呼ばれる想定） */
export async function summarizeArticle(params: {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  article: ArticleMeta;
  text: string;
  contentSource: ContentSource;
  maxContentChars: number;
}): Promise<Summary> {
  const client = createClient(params.apiKey);

  const msg = await client.beta.messages.create({
    model: params.model,
    max_tokens: 8000,
    ...fallbackParams(),
    system: SUMMARY_SYSTEM,
    output_config: { effort: params.effort, format: zodOutputFormat(SummarySchema) },
    messages: [
      {
        role: "user",
        content: buildSummaryUser(params.article, params.text, params.contentSource, params.maxContentChars),
      },
    ],
  });

  if (msg.stop_reason === "refusal") {
    throw new SummaryRefusedError(msg.stop_details?.category, msg.stop_details?.explanation);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("出力が長すぎて途中で切れました");
  }

  const textBlock = msg.content.find((block) => block.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "";
  return parseSummaryText(text);
}

/** チャットの1メッセージ（履歴・新規送信の両方に使う） */
export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/** ストリーミングチャットの結果 */
export type StreamChatResult =
  | { text: string; refused?: undefined }
  | { text: ""; refused: { category?: string; explanation?: string } };

/**
 * 記事についてのチャットをストリーミングで実行する（アプリページから呼ばれる想定）。
 * onText は本文テキストのデルタごとに呼ばれる。拒否時は text を空にし refused を返す
 * （§11 のとおり、拒否ターンは呼び出し側で assistant ターンとして保存しない）。
 */
export async function streamChat(params: {
  apiKey: string;
  model: string;
  article: ArticleMeta;
  contentText: string;
  history: ChatHistoryMessage[];
  onText: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<StreamChatResult> {
  const client = createClient(params.apiKey);

  const stream = client.beta.messages.stream(
    {
      model: params.model,
      max_tokens: 8000,
      ...fallbackParams(),
      system: [
        {
          type: "text",
          text: buildChatSystem(params.article, params.contentText),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: params.history.map((m) => ({ role: m.role, content: m.content })),
    },
    params.signal ? { signal: params.signal } : undefined,
  );

  stream.on("text", params.onText);

  const final = await stream.finalMessage();

  if (final.stop_reason === "refusal") {
    return {
      text: "",
      refused: {
        category: final.stop_details?.category ?? undefined,
        explanation: final.stop_details?.explanation ?? undefined,
      },
    };
  }

  const text = final.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text };
}

/** APIキー・モデルIDの疎通確認（出力トークンを消費しない） */
export async function testApiKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true; modelName?: string } | { ok: false; message: string }> {
  try {
    const client = createClient(apiKey);
    const info = await client.models.retrieve(model);
    return { ok: true, modelName: info.display_name };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

/**
 * Anthropic SDK のエラーを日本語メッセージに変換する。
 * most-specific-first の instanceof チェーンで判定する（文字列マッチは使わない）。
 * 注: `Anthropic.APIConnectionError` は `Anthropic.APIError` のサブクラスなので、
 * 汎用の `APIError` チェックより先に判定する必要がある（設計書の記載順どおりだと
 * ネットワークエラーが「APIエラー (undefined): …」に化けてしまうため、判定順を入れ替えた）。
 */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "APIキーが無効です";
  }
  if (err instanceof Anthropic.NotFoundError) {
    return "モデルIDが見つかりません";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "レート制限中です";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "APIに接続できません（ネットワークを確認してください）";
  }
  if (err instanceof Anthropic.APIError) {
    return `APIエラー (${err.status}): ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
