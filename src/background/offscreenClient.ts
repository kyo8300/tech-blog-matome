// SW から offscreen document を扱うためのクライアント。§10 / §13-5。
// offscreen document は1つだけ（getContexts で存在確認 + 作成 Promise のシングルトン）。

import type { ExtractResult } from "../shared/types";
import { send } from "../shared/messages";
import { OFFSCREEN_PAGE } from "../shared/constants";

let creating: Promise<void> | null = null;

/** offscreen document が存在することを保証する（無ければ作成する） */
export async function ensureOffscreen(): Promise<void> {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length > 0) return;

  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE,
      reasons: ["DOM_PARSER"],
      justification: "記事HTMLから本文を抽出する",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/** offscreen document に記事HTMLを送り、Readability による抽出結果を受け取る */
export async function extractViaOffscreen(html: string, url: string): Promise<ExtractResult> {
  await ensureOffscreen();
  return send({ type: "OFFSCREEN_EXTRACT", target: "offscreen", html, url });
}

/** offscreen document を閉じる（存在しない・失敗した場合の例外は無視する） */
export async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // 例外は無視する（§10・§13-5）
  }
}
