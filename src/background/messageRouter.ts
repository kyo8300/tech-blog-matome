// §7: SW 宛メッセージ（target 未指定 = "background"）のルーティング。

import { listen } from "../shared/messages";
import { isLockActive, loadSettings } from "../shared/settings";
import { getDb } from "../shared/db";
import { DEFAULT_SOURCES } from "../shared/sources";
import { testFeed } from "./feedFetcher";
import { testListing } from "./listingFetcher";
import { runPipeline, resummarize, refetchContent, resetAll, resetSource, queuePendingTrigger } from "./pipeline";
import { getProgress } from "./progress";
import { ensureAlarm } from "./alarms";
import { openApp } from "./openApp";

/** 実行中でロック中なら理由を返す（そうでなければ undefined） */
async function checkLocked(): Promise<string | undefined> {
  const progress = await getProgress();
  if (isLockActive(progress)) {
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
          const locked = await checkLocked();
          if (locked) {
            // ロック中でも要求を取りこぼさないよう、現在の実行が終わった直後に
            // 拾い直せるよう記録しておく（runPipeline の finally 参照）
            await queuePendingTrigger("manual").catch(() => undefined);
            return { started: false, reason: "実行中のため終了後に実行します" };
          }
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

      case "TEST_LISTING":
        return (async () => {
          const db = getDb();
          const source =
            (await db.sources.get(msg.sourceId)) ?? DEFAULT_SOURCES.find((s) => s.id === msg.sourceId);
          if (!source) {
            return { ok: false, error: "ソースが見つかりません" };
          }
          return testListing(source);
        })();

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

      case "RESET_SOURCE":
        return (async () => {
          try {
            return await resetSource(msg.sourceId);
          } catch (err) {
            return { ok: false, deleted: 0, error: err instanceof Error ? err.message : String(err) };
          }
        })();

      default:
        return undefined;
    }
  });
}
