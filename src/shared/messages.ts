// chrome.runtime.onMessage 上でやり取りするメッセージの判別共用体と、型付きの送受信ヘルパー。
// SW・offscreen・ページが同じ onMessage を共有するため target フィールドで振り分ける
// （target 未指定のメッセージは background 宛てとみなす）。

import type { ExtractResult, FeedTestResult, ListingItem, PipelineProgress } from "./types";

/** ページ→SW。今すぐ更新を実行する */
export interface FetchNowMessage {
  type: "FETCH_NOW";
}

/** 現在の進捗を取得する */
export interface GetProgressMessage {
  type: "GET_PROGRESS";
}

/** 指定記事の status を new に戻して1件だけ要約し直す */
export interface ResummarizeMessage {
  type: "RESUMMARIZE";
  articleId: string;
}

/** 指定記事の本文を再取得して再要約する */
export interface RefetchContentMessage {
  type: "REFETCH_CONTENT";
  articleId: string;
}

/** 設定→SW。フィードURLの接続テスト */
export interface TestFeedMessage {
  type: "TEST_FEED";
  url: string;
}

/** 設定→SW。一覧ページ抽出フォールバックのテスト（§9.5） */
export interface TestListingMessage {
  type: "TEST_LISTING";
  sourceId: string;
}

/** 設定→SW。設定が変わったのでアラームなどを再評価する */
export interface SettingsChangedMessage {
  type: "SETTINGS_CHANGED";
}

/** アプリページを開く（通知クリックなど） */
export interface OpenAppMessage {
  type: "OPEN_APP";
  articleId?: string;
}

/** 全データを削除して初期状態に戻す */
export interface ResetAllMessage {
  type: "RESET_ALL";
}

/** SW→ページ。進捗の変化を通知する（受信者がいなければ例外→握りつぶす） */
export interface ProgressMessage {
  type: "PROGRESS";
  progress: PipelineProgress;
}

/** SW→offscreen。記事HTMLから本文を抽出する */
export interface OffscreenExtractMessage {
  type: "OFFSCREEN_EXTRACT";
  target: "offscreen";
  html: string;
  url: string;
}

/** SW→offscreen。一覧ページのHTMLから記事リンクを抽出する（§9.5） */
export interface OffscreenExtractLinksMessage {
  type: "OFFSCREEN_EXTRACT_LINKS";
  target: "offscreen";
  html: string;
  url: string;
  pattern: string;
}

export type Message =
  | FetchNowMessage
  | GetProgressMessage
  | ResummarizeMessage
  | RefetchContentMessage
  | TestFeedMessage
  | TestListingMessage
  | SettingsChangedMessage
  | OpenAppMessage
  | ResetAllMessage
  | ProgressMessage
  | OffscreenExtractMessage
  | OffscreenExtractLinksMessage;

/** メッセージの type ごとの応答型 */
export interface MessageResponseMap {
  FETCH_NOW: { started: boolean; reason?: string };
  GET_PROGRESS: PipelineProgress;
  RESUMMARIZE: { ok: boolean; error?: string };
  REFETCH_CONTENT: { ok: boolean; error?: string };
  TEST_FEED: FeedTestResult;
  TEST_LISTING: FeedTestResult;
  SETTINGS_CHANGED: { ok: boolean };
  OPEN_APP: { ok: boolean };
  RESET_ALL: { ok: boolean };
  PROGRESS: { ok: boolean };
  OFFSCREEN_EXTRACT: ExtractResult;
  OFFSCREEN_EXTRACT_LINKS: { items: ListingItem[] };
}

/** メッセージ M に対応する応答型 */
export type ResponseFor<M extends Message> = MessageResponseMap[M["type"]];

/** 型付き chrome.runtime.sendMessage。受信者がいない場合は例外になる（ブロードキャストには broadcast() を使う） */
export async function send<M extends Message>(msg: M): Promise<ResponseFor<M>> {
  return (await chrome.runtime.sendMessage(msg)) as ResponseFor<M>;
}

/**
 * ブロードキャスト送信。受信者（開いているページ）がいない場合に発生する
 * 「Could not establish connection」等の例外は握りつぶす（MV3 の落とし穴 §13-4）。
 */
export async function broadcast(msg: Message): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // 受信者がいない場合は無視する
  }
}

/**
 * chrome.runtime.onMessage のリスナーを登録する。
 * target を指定すると、その target 宛て（msg.target が一致するもの）だけを処理する。
 * target 未指定のメッセージは background 宛てとみなす。
 * ハンドラが undefined を同期的に返した場合はそのメッセージを処理しないことを意味し、
 * sendResponse を呼ばず return false する（他のリスナーに委ねる）。
 * ハンドラの Promise が reject した場合も、送信側が「message port closed」で
 * 失敗しないよう必ず1回 sendResponse を呼ぶ（{ ok: false, error } を返す）。
 */
export function listen(
  handler: (msg: Message, sender: chrome.runtime.MessageSender) => Promise<unknown> | undefined,
  options?: { target?: "offscreen" | "background" },
): void {
  const target = options?.target ?? "background";
  chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
    const msgTarget = "target" in msg && msg.target ? msg.target : "background";
    if (msgTarget !== target) {
      return false;
    }
    let result: Promise<unknown> | undefined;
    try {
      result = handler(msg, sender);
    } catch (e) {
      // handler が同期的に throw した場合も必ず1回 sendResponse を呼ぶ
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return true;
    }
    if (result === undefined) {
      return false;
    }
    result.then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });
}
