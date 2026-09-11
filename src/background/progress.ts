// パイプライン進捗（chrome.storage.session）の読み書きと、ページへの broadcast。

import type { PipelineProgress } from "../shared/types";
import { loadProgress, saveProgress } from "../shared/settings";
import { broadcast } from "../shared/messages";

/**
 * updateProgress の read-modify-write を直列化するためのキュー。
 * mapLimit による並列呼び出し（フィード取得・要約）が同時に loadProgress → saveProgress を
 * 行うと、先勝ちの更新が後勝ちに上書きされて更新を失う（lost update）ため、
 * モジュール内の単一 Promise チェーンに乗せて1件ずつ処理する。
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 進捗の一部を更新し、保存してからページへ broadcast する。
 * patch は固定値のほか、現在値から差分を計算する関数でも渡せる
 * （mapLimit による並列実行下で articlesDone++ のような加算を安全に行うため）。
 */
export function updateProgress(
  patch: Partial<PipelineProgress> | ((current: PipelineProgress) => Partial<PipelineProgress>),
): Promise<PipelineProgress> {
  const run = queue.then(async () => {
    const current = await loadProgress();
    const resolved = typeof patch === "function" ? patch(current) : patch;
    const next: PipelineProgress = { ...current, ...resolved };
    await saveProgress(next);
    await broadcast({ type: "PROGRESS", progress: next });
    return next;
  });
  // このタスクが失敗してもキュー自体は途切れさせず、後続の更新を処理し続ける
  queue = run.catch(() => undefined);
  return run;
}

/** 現在の進捗を取得する */
export async function getProgress(): Promise<PipelineProgress> {
  return loadProgress();
}
