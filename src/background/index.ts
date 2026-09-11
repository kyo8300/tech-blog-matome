// Service Worker のエントリポイント。
// §13-1: 全リスナーをこのファイルの先頭で同期登録する（top-level await 禁止）。

import { loadSettings } from "../shared/settings";
import { ALARM_NAME, SETTINGS_KEY } from "../shared/constants";
import { runPipeline, upsertSources } from "./pipeline";
import { ensureAlarm } from "./alarms";
import { registerMessageRouter } from "./messageRouter";
import { openApp } from "./openApp";
import { onNotificationClicked } from "./notifications";

// runtime.onMessage
registerMessageRouter();

// onInstalled: sources 投入・アラーム作成。APIキー未設定なら設定ページを開き、
// 設定済みならその場でパイプラインを実行する。
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const settings = await loadSettings();
    await upsertSources(settings);
    await ensureAlarm(settings);
    if (!settings.apiKey) {
      chrome.runtime.openOptionsPage();
    } else {
      await runPipeline("install");
    }
  })();
});

// onStartup: APIキーが設定済みなら、取り残し回収と要約だけを行う
// （フィード取得はアラームまたは手動更新に任せる）。
// runPipeline の recoverOnly モードに乗せることで、ロック・keepAlive・progress 更新・
// 後片付け（offscreen close / 通知 / lastRunAt）を通常の実行と同じ枠組みで行う
// （§13-2: 長時間の await を keepAlive 無しで行わない）。
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const settings = await loadSettings();
    if (!settings.apiKey) return;
    await runPipeline("alarm", { recoverOnly: true });
  })();
});

// alarms.onAlarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void runPipeline("alarm");
});

// action.onClicked（default_popup を付けていないので発火する。§13-7）
chrome.action.onClicked.addListener(() => {
  void openApp();
});

// notifications.onClicked
chrome.notifications.onClicked.addListener((notificationId) => {
  void onNotificationClicked(notificationId);
});

// storage.onChanged（設定変更でアラームを再評価する）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(SETTINGS_KEY in changes)) return;
  void (async () => {
    const settings = await loadSettings();
    await ensureAlarm(settings);
  })();
});
