// 設定・進捗の読み書き。shared の中で chrome.storage を使うのはこのファイルだけ（runtime メッセージングは messages.ts）。

import type { PipelineProgress, Settings } from "./types";
import { DEFAULT_SETTINGS, LOCK_STALE_MS, PROGRESS_KEY, SETTINGS_KEY } from "./constants";

/** 進捗の初期値（アイドル状態） */
export const IDLE_PROGRESS: PipelineProgress = {
  running: false,
  phase: "idle",
  feedsDone: 0,
  feedsTotal: 0,
  articlesDone: 0,
  articlesTotal: 0,
  newCount: 0,
  errors: [],
};

/** chrome.storage.local から設定を読み込み、DEFAULT_SETTINGS とマージして返す */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    // 配列・オブジェクトは DEFAULT_SETTINGS の参照をそのまま返さないよう複製する
    enabledSources: [...(saved.enabledSources ?? DEFAULT_SETTINGS.enabledSources)],
    feedUrlOverrides: { ...DEFAULT_SETTINGS.feedUrlOverrides, ...saved.feedUrlOverrides },
  };
}

/** 設定の一部を更新して chrome.storage.local に保存する */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * chrome.storage.session からパイプライン進捗を読み込む（未設定なら IDLE_PROGRESS 相当を返す）。
 * 呼び出し側が返り値を直接書き換えても IDLE_PROGRESS 定数自体が汚染されないよう、
 * 未設定時は毎回新しいオブジェクトを複製して返す。
 */
export async function loadProgress(): Promise<PipelineProgress> {
  const stored = await chrome.storage.session.get(PROGRESS_KEY);
  const saved = stored[PROGRESS_KEY] as PipelineProgress | undefined;
  return saved ?? structuredClone(IDLE_PROGRESS);
}

/** パイプライン進捗を chrome.storage.session に保存する */
export async function saveProgress(progress: PipelineProgress): Promise<void> {
  await chrome.storage.session.set({ [PROGRESS_KEY]: progress });
}

/**
 * 実行ロックが有効かどうか（running かつ startedAt から LOCK_STALE_MS 未満）。
 * SW 死亡で running:true が古いまま残ったロックは無効（失効）とみなす。
 * SW 側（acquireLock / RESET_SOURCE の拒否判定）と設定ページ（削除ボタンの無効化）が
 * 同じ判定を共有するための純粋関数。`now` を渡さない場合は呼び出し時点の Date.now() を使う。
 */
export function isLockActive(progress: Pick<PipelineProgress, "running" | "startedAt">, now: number = Date.now()): boolean {
  return progress.running && progress.startedAt !== undefined && now - progress.startedAt < LOCK_STALE_MS;
}
