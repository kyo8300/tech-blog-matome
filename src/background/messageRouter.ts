// §7: SW 宛メッセージ（target 未指定 = "background"）のルーティング。

import { listen } from "../shared/messages";
import { loadSettings } from "../shared/settings";
import { LOCK_STALE_MS } from "../shared/constants";
import { testFeed } from "./feedFetcher";
import { runPipeline, resummarize, refetchContent, resetAll } from "./pipeline";
import { getProgress } from "./progress";
import { ensureAlarm } from "./alarms";
import { openApp } from "./openApp";

/** 実行中でロック中なら理由を返す（そうでなければ undefined） */
async function checkLocked(): Promise<string | undefined> {
  const progress = await getProgress();
  const now = Date.now();
  if (progress.running && progress.startedAt !== undefined && now - progress.startedAt < LOCK_STALE_MS) {
    return "既に更新処理が実行中です";
  }
  return undefined;
}

/** background 宛メッセージのリスナーを登録する */
export function registerMessageRouter(): void {
  listen((msg) => {
    switch (msg.type) {
      case "FETCH_NOW":
        return (async () => {
          const reason = await checkLocked();
          if (reason) return { started: false, reason };
          // runPipeline は await せず起動して即応答する
          void runPipeline("manual");
          return { started: true };
        })();

      case "GET_PROGRESS":
        return getProgress();

      case "RESUMMARIZE":
        return (async () => {
          try {
            await resummarize(msg.articleId);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        })();

      case "REFETCH_CONTENT":
        return (async () => {
          try {
            await refetchContent(msg.articleId);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        })();

      case "TEST_FEED":
        return testFeed(msg.url);

      case "SETTINGS_CHANGED":
        return (async () => {
          const settings = await loadSettings();
          await ensureAlarm(settings);
          return { ok: true };
        })();

      case "OPEN_APP":
        return (async () => {
          await openApp(msg.articleId);
          return { ok: true };
        })();

      case "RESET_ALL":
        return (async () => {
          await resetAll();
          return { ok: true };
        })();

      default:
        return undefined;
    }
  });
}
