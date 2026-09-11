// §13-2: SW は約30秒でアイドル終了する。パイプライン実行中・単発の要約実行中は定期的に
// chrome.* API を呼び出してアイドルタイマーをリセットし、SW を生かし続ける。
//
// runPipeline のバッチ処理と RESUMMARIZE/REFETCH_CONTENT の単発実行が同時に走ることがあるため、
// 参照カウント方式にして「どちらかが動いている間はタイマーを維持し、全員が stop() を呼び終えたら
// 止める」ようにしている（片方の finally が先に stop() しても、もう片方の実行中に SW が死なない）。

import { KEEP_ALIVE_INTERVAL_MS } from "../shared/constants";

let count = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** keepAlive を開始する（参照カウントを1増やす。タイマーは1本だけ） */
export function start(): void {
  count++;
  if (!timer) {
    timer = setInterval(() => {
      void chrome.runtime.getPlatformInfo();
    }, KEEP_ALIVE_INTERVAL_MS);
  }
}

/** keepAlive を停止する（参照カウントを1減らし、0になったらタイマーを止める） */
export function stop(): void {
  if (count > 0) count--;
  if (count === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}
