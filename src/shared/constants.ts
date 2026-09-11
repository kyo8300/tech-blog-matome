// アプリ全体の定数。sources.ts を import してよい（DEFAULT_SETTINGS.enabledSources のため）。
// 循環 import 回避のため sources.ts はこのファイルを import しないこと。

import type { Settings } from "./types";
import { DEFAULT_SOURCES } from "./sources";

/** 要約・チャットの既定モデル */
export const DEFAULT_MODEL = "claude-opus-5";

/** 設定ページのモデル選択肢（カスタム入力も可） */
export const MODEL_PRESETS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

/** 拒否フォールバック（server-side-fallback）を使うかどうか */
export const USE_FALLBACKS = true;

/** chrome.alarms のアラーム名 */
export const ALARM_NAME = "fetch";

/** 自動更新間隔の最小値（分） */
export const MIN_INTERVAL_MINUTES = 15;

/** 実行ロックが古いとみなすまでの時間（ms）。SW 死亡後の孤児ロック対策 */
export const LOCK_STALE_MS = 20 * 60 * 1000;

/** status:"summarizing" が古いとみなすまでの時間（ms）。SW 死亡後の取り残し回収に使う */
export const SUMMARIZING_STALE_MS = 15 * 60 * 1000;

/** フィード取得のタイムアウト（ms） */
export const FEED_FETCH_TIMEOUT_MS = 20_000;

/** 記事ページ取得のタイムアウト（ms） */
export const PAGE_FETCH_TIMEOUT_MS = 20_000;

/** 記事ページ取得の最大バイト数（超えたら打ち切り） */
export const PAGE_MAX_BYTES = 3 * 1024 * 1024;

/** Readability 抽出結果がこの文字数未満なら RSS 概要にフォールバック */
export const MIN_PAGE_TEXT_CHARS = 800;

/** RSS 概要もこの文字数未満なら contentSource:"none" とする */
export const MIN_RSS_TEXT_CHARS = 200;

/** フィード取得の並列数 */
export const FEED_CONCURRENCY = 4;

/** SW の keepAlive 間隔（ms） */
export const KEEP_ALIVE_INTERVAL_MS = 20_000;

/** chrome.storage.local の設定キー */
export const SETTINGS_KEY = "settings";

/** chrome.storage.session の進捗キー */
export const PROGRESS_KEY = "pipelineProgress";

/** アプリページのパス（拡張ルートからの相対パス） */
export const APP_PAGE = "src/app/index.html";

/** offscreen ページのパス（拡張ルートからの相対パス） */
export const OFFSCREEN_PAGE = "src/offscreen/index.html";

/** 設定の既定値 */
export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: DEFAULT_MODEL,
  effort: "medium",
  intervalMinutes: 1440,
  notificationsEnabled: true,
  enabledSources: DEFAULT_SOURCES.map((s) => s.id),
  feedUrlOverrides: {},
  summaryConcurrency: 3,
  maxContentChars: 60000,
  maxNewPerSourcePerRun: 20,
};
