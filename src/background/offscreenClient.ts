// SW から offscreen document を扱うためのクライアント。§10 / §13-5。
// offscreen document は1つだけ（getContexts で存在確認 + 作成 Promise のシングルトン）。
//
// runPipeline のバッチ処理と RESUMMARIZE/REFETCH_CONTENT の単発実行が同時に offscreen を
// 使うことがあるため、参照カウント方式の acquire()/release() で「誰か1人でも使用中なら
// 閉じない」ようにする（keepAlive.ts の start()/stop() と同じ考え方）。
// どちらが先に終わって release() しても、まだ使っている側の document は閉じられない。
//
// extractViaOffscreen() 自体も1回の呼び出しごとに acquire()/release() する
// （下記コメント参照）ので、呼び出し側が外側で acquire/release しているかどうかに関わらず、
// 抽出中に document が閉じられたり、抽出後に開きっぱなしになったりしない。

import type { ExtractResult, ListingItem } from "../shared/types";
import { send } from "../shared/messages";
import { OFFSCREEN_PAGE } from "../shared/constants";

let creating: Promise<void> | null = null;
/** closeDocument() の実行中の Promise。ensureOffscreen() はこれが終わるまで待ってから
 *  getContexts() を見る（閉じかけの document を「存在する」と誤認して使ってしまうのを防ぐ）。 */
let closing: Promise<void> | null = null;
let refCount = 0;

/** offscreen document が存在することを保証する（無ければ作成する） */
export async function ensureOffscreen(): Promise<void> {
  // closeDocument() が進行中なら、getContexts() で見る前にまず完了を待つ。
  // 待たずに getContexts() すると、閉じかけの（まだ存在するように見える）document を
  // 「使える」と誤認して return してしまい、直後に close が完了して送信が失敗したり、
  // createDocument() が「Only a single offscreen document」で reject したりする。
  if (closing) {
    await closing;
  }

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

/**
 * offscreen document の利用を開始する（参照カウントを1増やす）。
 * refCount++ を `await ensureOffscreen()` より先に（＝await をまたがず同期的に）行う。
 * 逆順にすると、ensureOffscreen() の await 中に他の release() が refCount を 0 と見なして
 * closeDocument() を呼んでしまい、これから使おうとしている document を閉じられる恐れがある。
 * ensureOffscreen() が失敗した場合は refCount を戻してから throw する
 * （呼び出し側は `await acquire()` が成功した場合のみ finally で release() すること）。
 */
export async function acquire(): Promise<void> {
  refCount++;
  try {
    await ensureOffscreen();
  } catch (err) {
    refCount--;
    throw err;
  }
}

/**
 * offscreen document の利用を終える（参照カウントを1減らし、0になったら閉じる）。
 * closeDocument() の Promise を `closing` に保持し、finally で null に戻す。
 * closeDocument() が完了するまでの間に新しい acquire() が入っても、
 * ensureOffscreen() 側が `closing` を待ってから getContexts() を見るため、
 * 閉じかけの document を「使える」と誤認することはない。
 */
export async function release(): Promise<void> {
  if (refCount > 0) refCount--;
  if (refCount !== 0) return;

  // closeDocument() が同期的に throw する場合も含めて例外は無視する（§10・§13-5）
  closing = (async () => {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // 例外は無視する
    }
  })().finally(() => {
    closing = null;
  });
  await closing;
}

/**
 * offscreen document に記事HTMLを送り、Readability による抽出結果を受け取る。
 * 呼び出し1回ごとに acquire()/release() する。呼び出し側（runPipeline / summarizeSingle）が
 * 実行全体を通した外側の acquire/release をしているかどうかに関わらず、
 * 少なくともこの抽出中は document が生きていること、抽出後に開きっぱなしにならないことを
 * この関数自身が保証する（外側の acquire が失敗していても、ここで独立して再試行される）。
 */
export async function extractViaOffscreen(html: string, url: string): Promise<ExtractResult> {
  await acquire();
  try {
    return await send({ type: "OFFSCREEN_EXTRACT", target: "offscreen", html, url });
  } finally {
    await release();
  }
}

/**
 * offscreen document に一覧ページのHTMLを送り、記事リンクの抽出結果を受け取る（§9.5）。
 * extractViaOffscreen 同様、呼び出し1回ごとに acquire()/release() する。
 */
export async function extractLinksViaOffscreen(
  html: string,
  url: string,
  pattern: string,
  excludePattern?: string,
): Promise<{ items: ListingItem[] }> {
  await acquire();
  try {
    return await send({ type: "OFFSCREEN_EXTRACT_LINKS", target: "offscreen", html, url, pattern, excludePattern });
  } finally {
    await release();
  }
}
