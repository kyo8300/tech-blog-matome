// 新着通知（§13-6）。1回の実行につき1通、chrome.notifications で OS 通知を出す。

import type { Settings } from "../shared/types";
import { openApp } from "./openApp";

/** 直近の通知IDを覚えておき、クリック時に openApp するために使う */
let lastNotificationId: string | null = null;

/** 実行結果の通知を1通出す（notificationsEnabled が false、または新着が無ければ何もしない） */
export async function notifyRun(
  newCount: number,
  doneCount: number,
  errorCount: number,
  settings: Settings,
): Promise<void> {
  if (!settings.notificationsEnabled || newCount <= 0) return;

  const id = `run-${Date.now()}`;
  lastNotificationId = id;

  const messageParts = [`新着 ${newCount} 件`, `要約完了 ${doneCount} 件`];
  if (errorCount > 0) {
    messageParts.push(`エラー ${errorCount} 件`);
  }

  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: "Tech Blog まとめ",
    message: messageParts.join(" / "),
  });
}

/** 通知クリック時のハンドラ。アプリを開いて通知を消す */
export async function onNotificationClicked(id: string): Promise<void> {
  if (id === lastNotificationId) {
    lastNotificationId = null;
  }
  await openApp();
  await chrome.notifications.clear(id);
}
