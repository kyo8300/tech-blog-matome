// chrome.alarms によるスケジュール管理。§8・§13-2 のとおり、periodInMinutes が
// 変わらない限り作り直さない（毎回作り直すとカウントダウンがリセットされてしまう）。

import type { Settings } from "../shared/types";
import { ALARM_NAME, MIN_INTERVAL_MINUTES } from "../shared/constants";

/** 設定の intervalMinutes に合わせてアラームを作成・更新・削除する */
export async function ensureAlarm(settings: Settings): Promise<void> {
  if (settings.intervalMinutes <= 0) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const periodInMinutes = Math.max(MIN_INTERVAL_MINUTES, settings.intervalMinutes);
  const current = await chrome.alarms.get(ALARM_NAME);
  if (current && current.periodInMinutes === periodInMinutes) {
    return;
  }

  await chrome.alarms.create(ALARM_NAME, { periodInMinutes, delayInMinutes: periodInMinutes });
}
