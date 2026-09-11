// Claude が返す要約JSONのスキーマ定義とパース処理。
// 文字数などの長さ制約はプロンプト側で指示するため、スキーマは型だけを検証する。

import { z } from "zod";
import type { Summary } from "../shared/types";

export const SummarySchema = z.object({
  /** 40字以内の日本語見出し */
  headline: z.string(),
  /** 3文程度のざっくり紹介（①） */
  brief: z.string(),
  /** 忙しい人向け要点 3〜7項目（②） */
  digest: z.array(z.string()),
  /** 400〜800字の解説。改行で段落分け（③） */
  detail: z.string(),
  /** 最大5つ */
  tags: z.array(z.string()),
});

export type SummaryOutput = z.infer<typeof SummarySchema>;

/** JSON.parse + SummarySchema.safeParse を試み、成功時のみ値を返す */
function tryParse(text: string): Summary | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = SummarySchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/**
 * Claude の応答テキストから要約JSONを取り出す。
 * まず全体を JSON.parse + safeParse で試し、失敗したら最初の "{" から最後の "}" までを
 * 抽出して再試行する。それでも解釈できない場合はエラーを投げる。
 */
export function parseSummaryText(text: string): Summary {
  const direct = tryParse(text);
  if (direct) return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const extracted = tryParse(text.slice(start, end + 1));
    if (extracted) return extracted;
  }

  throw new Error(`要約の JSON を解釈できませんでした: ${text.slice(0, 200)}`);
}
