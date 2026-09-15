// アプリ全体で共有する型定義。
// このファイルは DOM を使わず、どのコンテキスト（SW / offscreen / ページ / Node）からも import 可能であること。

/** 記事のパイプライン上の状態 */
export type ArticleStatus = "new" | "summarizing" | "done" | "error";

/** フィード（購読元ブログ）の情報 */
export interface Source {
  id: string;
  name: string;
  feedUrl: string;
  altFeedUrls: string[];
  siteUrl: string;
  /** <category> にこのいずれかを含む記事だけ採用（カテゴリ情報が無い場合は全件） */
  categoryFilter?: string[];
  /** false の間は最新1件だけ取り込む（初回バックフィル） */
  initialized: boolean;
  etag?: string;
  lastModified?: string;
  lastFetchedAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastItemCount?: number;
  /** フィードが無い/壊れているソース用の HTML 一覧ページ（§9.5） */
  listingUrl?: string;
  /** 一覧ページ内で記事URLとみなす正規表現（正規化後の絶対URLに対して適用） */
  listingLinkPattern?: string;
  /** 正規化後の絶対URLがこれに一致したら記事とみなさない（カテゴリ等。§9.5 規則 1'） */
  listingExcludePattern?: string;
  /** 一覧経路で「見たことがある」記事ID（sha256）。新着判定に使う。最大 LISTING_SEEN_MAX 件、古いものから捨てる（§9.5） */
  listingSeenIds?: string[];
  /** 直近の実行でどちらの経路で取得したか */
  lastFetchMode?: "feed" | "listing";
}

/** Claude が生成する3段階要約 */
export interface Summary {
  /** 記事の内容が一目で分かる日本語の見出し（①一覧に表示） */
  headline: string;
  /** 3文程度のざっくり紹介（①一覧に表示） */
  brief: string;
  /** 忙しい人向けの要点まとめ（②クリックで表示） */
  digest: string[];
  /** より詳しく分かりやすい解説（③クリックで表示） */
  detail: string;
  tags: string[];
}

/** 記事1件のデータ */
export interface Article {
  /** sha256Hex(normalizeUrl(link)) … 重複排除キー */
  id: string;
  sourceId: string;
  guid?: string;
  title: string;
  url: string;
  publishedAt: number;
  createdAt: number;
  /** description / summary / content:encoded をテキスト化したもの */
  rssSummary?: string;
  contentText?: string;
  contentSource: "page" | "rss" | "none";
  contentChars: number;
  summary?: Summary;
  status: ArticleStatus;
  error?: string;
  attempts: number;
  model?: string;
  /** status を "summarizing" にした時刻（取り残し回収の経過時間判定に使う） */
  summarizingAt?: number;
  summarizedAt?: number;
  readAt?: number;
}

/** 記事ごとのAI質問チャット履歴 */
export interface ChatThread {
  articleId: string;
  messages: { role: "user" | "assistant"; content: string; createdAt: number }[];
  updatedAt: number;
}

/** 拡張の設定 */
export interface Settings {
  apiKey: string;
  /** 既定値: "claude-opus-5" */
  model: string;
  /** 要約の思考量。既定値: "medium" */
  effort: "low" | "medium" | "high";
  /** 自動更新間隔（分）。既定値: 1440 */
  intervalMinutes: number;
  /** 既定値: true */
  notificationsEnabled: boolean;
  enabledSources: string[];
  feedUrlOverrides: Record<string, string>;
  /** 同時要約数。既定値: 3 */
  summaryConcurrency: number;
  /** 本文の最大文字数。既定値: 60000 */
  maxContentChars: number;
  /** 1回の更新あたりソースごとの最大新着数。既定値: 20 */
  maxNewPerSourcePerRun: number;
  /** 1回の更新あたりの最大要約数（全体）。既定値: 30 */
  maxSummariesPerRun: number;
  lastRunAt?: number;
}

/** 取得・要約パイプラインの進捗（chrome.storage.session に保存） */
export interface PipelineProgress {
  running: boolean;
  trigger?: "alarm" | "manual" | "install" | "startup";
  startedAt?: number;
  phase: "idle" | "feeds" | "summarizing" | "done";
  feedsDone: number;
  feedsTotal: number;
  articlesDone: number;
  articlesTotal: number;
  newCount: number;
  errors: string[];
  finishedAt?: number;
}

/** TEST_FEED メッセージの応答（設定ページのフィード接続テスト） */
export interface FeedTestResult {
  ok: boolean;
  status?: number;
  format?: "rss2" | "atom" | "rdf" | "not-xml" | "listing";
  itemCount?: number;
  newestTitle?: string;
  newestDate?: string;
  hasFullContent?: boolean;
  error?: string;
}

/** OFFSCREEN_EXTRACT メッセージの応答（Readability による本文抽出結果） */
export interface ExtractResult {
  title?: string;
  text: string;
  excerpt?: string;
  /** 公開日時（epoch ミリ秒）。§10 の探索順で見つかった最初の値 */
  publishedAt?: number;
}

/** 一覧ページから抽出した記事リンク1件分（§9.5） */
export interface ListingItem {
  url: string;
  title: string;
  publishedAt?: number;
}
