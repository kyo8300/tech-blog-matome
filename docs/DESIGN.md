# 設計書 — Tech Blog まとめ（Chrome拡張 / MV3）

最終更新: 2026-09-11

## 0. 目的と合意事項

海外トップテック企業のエンジニアリングブログ15本を1か所に集め、新着記事をClaudeで日本語の3段階要約にして読める個人用ツール。記事ごとにClaudeへ質問できるチャット付き。

| 項目 | 決定 |
|---|---|
| 形態 | **Chrome拡張（Manifest V3）だけで完結**。サーバー不要 |
| スタック | Vite 7 + React 19 + TypeScript 5.9、`@crxjs/vite-plugin` 2 |
| 閲覧UI | 拡張の**専用タブページ**（ツールバーアイコン／通知クリックで開く）。設定は別ページ |
| 自動取得 | `chrome.alarms` で **1日1回**（設定で変更可）+ 手動「今すぐ更新」 |
| 通知 | 新着があれば `chrome.notifications` でOS通知（1回の実行につき1通） |
| 初回取り込み | **各ブログ最新1件だけ**要約。以降は新着のみ |
| 3段階要約 | ① 見出し + 3文のざっくり紹介（一覧に表示） ② 忙しい人向け要点（クリックで表示） ③ 詳しく分かりやすい解説（クリックで表示）。**1回のAPI呼び出しでJSONとして3つ同時に生成** |
| AI質問 | 記事ごとのチャット。記事本文をsystemに入れて回答。履歴はIndexedDBに保存 |
| Claude | 公式SDK `@anthropic-ai/sdk`（`dangerouslyAllowBrowser: true`）。既定モデル `claude-opus-5`（設定で変更可） |
| 言語 | UI・要約・README すべて日本語 |

## 1. 主要な設計判断

| 項目 | 決定 | 理由 |
|---|---|---|
| ビルド | `@crxjs/vite-plugin` v2 + `@vitejs/plugin-react` v5 | manifestをTSで書け、SW/複数HTML/HMRを扱える。Vite 8 は plugin-react 6 の peer 依存が増えるので **Vite 7 系に固定** |
| 本文抽出 | `chrome.offscreen`（reason `DOM_PARSER`）内で `DOMParser` + `@mozilla/readability` | Service Worker にはDOMがない。Readabilityが最も精度が高い。失敗時はRSSの `content:encoded` / `description` にフォールバック |
| RSS解析 | `fast-xml-parser` v5（DOM不要） | SW・Node・テストで同じコードを使える |
| 保存 | Dexie 4（IndexedDB: `sources` / `articles` / `chats`）。設定は `chrome.storage.local`、実行ロック・進捗は `chrome.storage.session` | Dexie `liveQuery` でSWの書き込みがタブ側に自動反映 |
| host_permissions | `https://*/*` | フィードと記事ページのドメインが違う（medium→netflixtechblog 等）、リダイレクトが多い、将来フィード追加可。個人利用なので警告は無視できる |
| Claude呼び出し場所 | 要約: **SW**（タブが閉じていても動く）。チャット・APIキー検証: **拡張ページ内**（ストリーミングを直接Reactへ） | 同じ `src/lib/claudeClient.ts` を両方で使う |
| 要約の構造化 | `output_config.format` に `zodOutputFormat(SummarySchema)` | JSON形状を保証。`stop_reason === "refusal"` と `max_tokens` を明示ハンドリング |
| 拒否フォールバック | `betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"` を `USE_FALLBACKS` 定数でON/OFF | セキュリティ系記事（Cloudflare/GitHub）が拒否されにくくなる。structured output との併用がAPIに拒否された場合はOFFにする |

## 2. 依存パッケージ（確認済みバージョン）

dependencies: `@anthropic-ai/sdk ^0.125`, `@mozilla/readability ^0.6`, `dexie ^4.4`, `dexie-react-hooks ^4.4`, `fast-xml-parser ^5.11`, `react ^19.3`, `react-dom ^19.3`, `zod ^4.6`
devDependencies: `@crxjs/vite-plugin ^2.7`, `@types/chrome ^0.2`, `@types/node ^22`, `@types/react ^19`, `@types/react-dom ^19`, `@vitejs/plugin-react ^5.2`, `fake-indexeddb ^6`, `jsdom ^30`, `playwright ^1.63`, `tsx ^4.23`, `typescript ^5.9`, `vite ^7.3`, `vitest ^4.1`

npm scripts: `dev` / `build` / `typecheck`（tsc --noEmit）/ `test`（vitest run）/ `check-feeds`（tsx scripts/check-feeds.ts）/ `gen-icons` / `smoke`（Playwright煙テスト）

`.npmrc` に `legacy-peer-deps=true` を置く。npm 10.9 が vitest 4 の任意 peer（`@vitest/browser-playwright` → `playwright`）を解決する際に `Cannot read properties of null (reading 'edgesOut')` でクラッシュする npm 側のバグの回避で、バージョン範囲自体は上記のまま変更しない。

## 3. ファイル構成

```
tech-blog-matome/
├── package.json  tsconfig.json  vite.config.ts  vitest.config.ts  .gitignore  .npmrc  README.md（日本語）
├── manifest.config.ts            # crxjs defineManifest
├── public/icons/{16,48,128}.png  # scripts/gen-icons.mjs で生成（依存なしの最小PNGエンコーダ）
├── scripts/check-feeds.ts        # Node: 15本のフィード（+代替URL）を検証して表を出す
├── scripts/gen-icons.mjs
├── scripts/jsdom.d.ts            # check-feeds が使う jsdom の最小アンビエント型（@types/jsdom を入れない）
├── scripts/smoke-extension.mjs   # Playwright: dist/ を --load-extension で起動し SW とページの描画を確認
├── src/
│   ├── shared/      types.ts constants.ts sources.ts settings.ts db.ts messages.ts
│   ├── lib/         feedParser.ts urlNormalize.ts hash.ts htmlToText.ts summarySchema.ts prompts.ts claudeClient.ts concurrency.ts listingExtract.ts
│   ├── background/  index.ts alarms.ts pipeline.ts feedFetcher.ts articleFetcher.ts listingFetcher.ts offscreenClient.ts
│   │                summarizer.ts notifications.ts keepAlive.ts progress.ts messageRouter.ts
│   ├── offscreen/   index.html offscreen.ts
│   ├── app/         index.html main.tsx App.tsx styles.css
│   │   ├── components/ Toolbar StatusBar ArticleList ArticleCard ArticleDetail ChatPanel SourceFilter
│   │   └── hooks/      useArticles usePipelineProgress useChat useSettings
│   └── options/     index.html main.tsx Options.tsx styles.css
│                    components/ ApiKeyField ModelSelect IntervalSelect SourceRow DangerZone
└── tests/  fixtures/*.xml fixtures/*.html  feedParser urlNormalize htmlToText summarySchema prompts concurrency readability(jsdom) listingExtract(jsdom)
```

- `src/shared/` はどのコンテキストからも import される。DOM禁止、`chrome.*` は `settings.ts`（storage）と `messages.ts`（runtime メッセージングのみ）に限る。
- `src/lib/` は純粋TS。Node（scripts / vitest）でも動く。例外として `listingExtract.ts` は引数で受け取った `Document` を操作する（グローバルの DOM には触れない。offscreen では DOMParser、scripts / tests では jsdom が渡す）。

## 4. manifest（`manifest.config.ts`）

```ts
import { defineManifest } from "@crxjs/vite-plugin";
export default defineManifest({
  manifest_version: 3,
  name: "Tech Blog まとめ",
  version: "0.1.0",
  icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
  action: { default_title: "Tech Blog まとめを開く" },   // default_popup は付けない（付けると onClicked が発火しない）
  background: { service_worker: "src/background/index.ts", type: "module" },
  options_ui: { page: "src/options/index.html", open_in_tab: true },
  permissions: ["alarms", "notifications", "storage", "offscreen", "unlimitedStorage", "tabs"],
  host_permissions: ["https://*/*"],
});
```
`src/app/index.html` と `src/offscreen/index.html` は manifest に載らないので `vite.config.ts` の `build.rollupOptions.input` に明示追加する。`tabs` は既存のアプリタブを `chrome.tabs.query({url})` で探すために必要。

## 5. データモデル（`src/shared/types.ts`）

```ts
type ArticleStatus = "new" | "summarizing" | "done" | "error";

interface Source {
  id: string; name: string; feedUrl: string; altFeedUrls: string[]; siteUrl: string;
  categoryFilter?: string[];       // <category> にこのいずれかを含む記事だけ採用（カテゴリ情報が無い場合は全件）
  initialized: boolean;            // false の間は最新1件だけ取り込む（初回バックフィル）
  etag?: string; lastModified?: string; lastFetchedAt?: number;
  listingUrl?: string;             // フィードが無い/壊れているソース用の HTML 一覧ページ（§9.5）
  listingLinkPattern?: string;     // 一覧ページ内で記事URLとみなす正規表現（正規化後の絶対URLに対して適用）
  listingExcludePattern?: string;  // 正規化後の絶対URLがこれに一致したら記事とみなさない（カテゴリ等。§9.5 規則 1'）
  latestPublishedAt?: number;      // これまでに登録した記事の最新公開日（epoch ms）。新着判定の基準（§8-3）。旧版の listingSeenIds は無視して捨てる
  lastStatus?: "ok" | "error"; lastError?: string; lastItemCount?: number;
  lastFetchMode?: "feed" | "listing";  // 直近の実行でどちらの経路で取得したか
}

interface Summary { headline: string; brief: string; digest: string[]; detail: string; tags: string[] }
// ① headline + brief（一覧）  ② digest（要点）  ③ detail（解説）

interface Article {
  id: string;                      // sha256Hex(normalizeUrl(link)) … 重複排除キー
  sourceId: string; guid?: string; title: string; url: string;
  publishedAt: number; createdAt: number;
  rssSummary?: string;             // description / summary / content:encoded をテキスト化したもの
  contentText?: string; contentSource: "page" | "rss" | "none"; contentChars: number;
  summary?: Summary; status: ArticleStatus; error?: string; attempts: number;
  model?: string; summarizedAt?: number; readAt?: number;
  summarizingAt?: number;          // status を "summarizing" にした時刻。§8-4 の孤児回収（15分）判定に使う
}

interface ChatThread {
  articleId: string;
  messages: { role: "user" | "assistant"; content: string; createdAt: number }[];
  updatedAt: number;
}

interface Settings {
  apiKey: string; model: string /* "claude-opus-5" */; effort: "low" | "medium" | "high" /* "medium" */;
  intervalMinutes: number /* 1440 */; notificationsEnabled: boolean /* true */;
  enabledSources: string[]; feedUrlOverrides: Record<string, string>;
  summaryConcurrency: number /* 3 */; maxContentChars: number /* 60000 */;
  maxNewPerSourcePerRun: number /* 20 */; maxSummariesPerRun: number /* 30 */; lastRunAt?: number;
}

interface PipelineProgress {
  running: boolean; trigger?: "alarm" | "manual" | "install" | "startup"; startedAt?: number;
  phase: "idle" | "feeds" | "summarizing" | "done";
  feedsDone: number; feedsTotal: number; articlesDone: number; articlesTotal: number;
  newCount: number; errors: string[]; finishedAt?: number;
}
```
Dexie スキーマ（`src/shared/db.ts`, version 1）:
`sources: "id"`, `articles: "id, sourceId, publishedAt, status, createdAt, [sourceId+publishedAt]"`, `chats: "articleId, updatedAt"`。
設定は `chrome.storage.local` のキー `settings`、進捗は `chrome.storage.session` のキー `pipelineProgress`。DBはモジュールトップではなくハンドラ内で遅延オープン。

## 6. フィード初期値（`src/shared/sources.ts`）

`docs/feeds.opml` の15本。ユーザー確認済みの変更: **Google は Chrome for Developers のフィードに差し替え**、**Stripe はOPMLのURLで確定**。

| id | name | feedUrl | 備考 |
|---|---|---|---|
| netflix | Netflix TechBlog | https://netflixtechblog.com/feed | Medium。本文全文入り |
| cloudflare | Cloudflare Blog | https://blog.cloudflare.com/rss/ | |
| stripe | Stripe Blog | https://stripe.com/blog/feed.rss | `categoryFilter: ["Engineering"]`（カテゴリが無ければ全件） |
| meta | Engineering at Meta | https://engineering.fb.com/feed/ | |
| shopify | Shopify Engineering | https://shopify.engineering/blog.atom | Atom |
| uber | Uber Engineering | https://www.uber.com/blog/engineering/rss/ | 2026-09 時点で 404（alt もすべて 404）。`listingUrl: "https://www.uber.com/us/en/blog/engineering/"`, `listingLinkPattern: "^https://www\\.uber\\.com/(?:[a-z]{2}-[A-Z]{2}/|[a-z]{2}/[a-z]{2}/)?blog/[^/]+/?$"` で §9.5 の一覧フォールバック。記事ページがJS描画の可能性 → RSS概要フォールバック |
| airbnb | Airbnb Engineering & Data Science | https://medium.com/feed/airbnb-engineering | Medium |
| github | GitHub Engineering | https://github.blog/engineering/feed/ | |
| google | Chrome for Developers (Google) | https://developer.chrome.com/static/blog/feed.xml | alt: `https://developers.googleblog.com/feeds/posts/default`, `https://developers.googleblog.com/feed/` |
| microsoft | Engineering at Microsoft | https://devblogs.microsoft.com/engineering-at-microsoft/feed/ | |
| linkedin | LinkedIn Engineering | https://engineering.linkedin.com/blog.rss.html | 2026-09 時点で 404。alt: `https://www.linkedin.com/blog/engineering/rss`（`/feed` は「Feed」カテゴリの HTML なので alt から外す）。`listingUrl: "https://www.linkedin.com/blog/engineering"`, `listingLinkPattern: "^https://www\\.linkedin\\.com/blog/engineering/[^/]+/[^/]+$"` で §9.5 の一覧フォールバック |
| spotify | Spotify Engineering | https://engineering.atspotify.com/feed | |
| pinterest | Pinterest Engineering | https://medium.com/feed/pinterest-engineering | Medium |
| atlassian | Atlassian Engineering | https://atlassianblog.wpengine.com/feed | OPML の URL は 2026-09 時点で 404 のため差し替え。alt: `https://www.atlassian.com/blog/atlassian-engineering/feed`, `https://www.atlassian.com/blog/feed`, `https://developer.atlassian.com/blog/feed.xml` |
| slack | Slack Engineering | https://slack.engineering/feed/ | |

各 `siteUrl` は OPML の `htmlUrl`（google は `https://developer.chrome.com/blog`）。

## 7. メッセージ設計（`src/shared/messages.ts`）

判別共用体 `Message` と型付き `send()` / `listen()`。SW・offscreen・ページが同じ `chrome.runtime.onMessage` を共有するので `target` フィールドで振り分ける。非同期応答は `handler().then(sendResponse, e => sendResponse({ ok: false, error: String(e) })); return true;`（Promise を return しない。ハンドラが reject しても必ず1回応答する）。

```ts
type Message =
  | { type: "FETCH_NOW" }                                   // ページ→SW。返答 { started: boolean; reason?: string }
  | { type: "GET_PROGRESS" }                                // → PipelineProgress
  | { type: "RESUMMARIZE"; articleId: string }              // "new" を経由せず直接 summarizing に遷移して1件だけ要約
  | { type: "REFETCH_CONTENT"; articleId: string }          // 本文を再取得して再要約
  | { type: "TEST_FEED"; url: string }                      // 設定→SW。返答 FeedTestResult { ok, status, format, itemCount, newestTitle, newestDate, hasFullContent, error? }
  | { type: "TEST_LISTING"; sourceId: string }              // 設定→SW。一覧フォールバックのテスト。返答 FeedTestResult（format は "listing"）
  | { type: "SETTINGS_CHANGED" }                            // 設定→SW。アラーム再評価
  | { type: "OPEN_APP"; articleId?: string }
  | { type: "RESET_ALL" }                                   // 全テーブル削除、sources を未初期化に
  | { type: "RESET_SOURCE"; sourceId: string }              // 設定→SW。そのソースの記事・チャットを削除し、initialized=false / latestPublishedAt=undefined / etag 等をクリア。返答 { ok, deleted, error? }。パイプライン実行中（progress.running かつ startedAt から LOCK_STALE_MS 未満）は { ok:false, error:"更新の実行中は削除できません" } を返す。設定ページも同じ判定（running かつ startedAt + LOCK_STALE_MS > now）でボタンを無効化し、古いロックが残っていても SW と同じタイミングで押せるようにする
  | { type: "PROGRESS"; progress: PipelineProgress }        // SW→ページ（受信者がいなければ例外→握りつぶす）
  | { type: "OFFSCREEN_EXTRACT"; target: "offscreen"; html: string; url: string }  // 返答 { title?, text, excerpt? }
  | { type: "OFFSCREEN_EXTRACT_LINKS"; target: "offscreen"; html: string; url: string; pattern: string; excludePattern?: string }; // 返答 { items: ListingItem[] }（§9.5）
```
チャット・既読・フィルタ・記事一覧はSWを通さず、ページから Dexie / SDK を直接使う。

## 8. パイプライン（`src/background/pipeline.ts`）

```
runPipeline(trigger)
 1. ロック: storage.session.pipelineProgress.running が true かつ startedAt から20分未満なら中止（SW死亡後の古いロックは無視）。running=true を書き、keepAlive.start()
 2. 設定読込 → 有効ソースを feedUrlOverrides でマージし db.sources に upsert
 3. FEEDS（並列4）: fetchFeed(url, {etag,lastModified}, 20s) → 304 なら skip
      → parseFeed(xml)（非XMLなら NotXmlError → lastStatus="error"）
      → フィード取得/解析に失敗し source.listingUrl があれば §9.5 の一覧フォールバック（成功なら lastStatus="ok", lastFetchMode="listing"。失敗なら両方のエラーを lastError に併記）
      → categoryFilter 適用 → URL正規化+sha256 で id を求める
      → **新着判定は「公開日が基準より新しい」**で行う（DB 未登録＝新着ではない。フィードにも過去記事が並ぶため）: 基準 = `source.latestPublishedAt - NEW_ITEM_GRACE_MS`（猶予 3 日。並び順や時差のズレで遅れて載った記事を拾うため）。公開日がこれ以下の記事は捨てる。同じ記事の再登録は DB 存在チェック（bulkGet）で防ぐ
      → 公開日不明の記事: フィード経路では捨てる（RSS で日付が無いのは稀）。一覧経路では通し、本文取得時にページの公開日で判定する（§8-5）
      → 未初期化、**または latestPublishedAt が未設定**（旧版からの移行）なら publishedAt 最新の1件を選ぶ。その1件が既に DB にあれば登録は 0 件だが、**latestPublishedAt はその公開日に設定する**（判定モードを通常に進めるため。設定しないと毎回「最新1件」判定に留まる）
      → 初期化済みなら基準を超えるもののうち **DB に無いもの**を publishedAt の古い順に maxNewPerSourcePerRun 件まで登録し、latestPublishedAt は、繰り越しが無い回は「基準を超えた候補のうち登録した分と既登録分」の最大値まで、**繰り越しがある回（carriedOver > 0）は登録した分（addedKnown）の最大値まで**しか進めない（既登録分の新しい日付で繰り越し候補を飛び越さないため）。既登録が猶予内に並んでいても枠を食い潰さない。残りは次回の実行で拾われ、何も失わない。carriedOver は実際に未登録で残った件数。上限に達したら errors に「N 件を次回に繰り越し」。比較は epoch ms のタイムスタンプで行うので同日の複数記事も区別できる。時刻の無いフィードで同一タイムスタンプになっても猶予 3 日と DB 重複排除で取りこぼさない
      → 登録した記事の最大 publishedAt で `latestPublishedAt` を更新（単調増加。304 のときは変更しない）
      → status:"new", rssSummary: htmlToText(content ?? description), contentSource:"none" で bulkAdd
      → source 更新（initialized=true, etag, lastItemCount）、progress.feedsDone++
 4. 取り残し回収: status:"new" 全件 + `summarizingAt` が15分以上前（SUMMARIZING_STALE_MS）の "summarizing"（SW死亡）を "new" に戻して対象に追加。`summarizingAt` が無い "summarizing" も孤児として回収する
 5. SUMMARIZE（並列 summaryConcurrency）: APIキー未設定なら "new" のまま残し errors に「APIキー未設定」。対象は publishedAt 降順（不明は末尾）で先頭 maxSummariesPerRun 件まで。残りは "new" のまま次回に回し、errors に「上限 N 件に達したため M 件を次回に繰り越し」
      課金・認証エラー（AuthenticationError、または 400 の message に "credit balance" を含む）が1件でも出たら、残りの記事は "new" に戻して即座にバッチを打ち切り、errors に「APIの残高不足または認証エラーのため中断」を1回だけ入れる
      各記事: status="summarizing"
        → fetchArticleHtml(url, 20s, 3MB上限, content-type が text/html でなければ null)
        → offscreen で Readability → text
        → text が 800 字未満なら rssSummary を使う（contentSource="rss"）。それも 200 字未満なら contentSource="none"
        → ページから公開日（ExtractResult.publishedAt）が取れ、Article.publishedAt が取得時刻の仮値（createdAt と等しい）なら publishedAt を更新する（**要約の成否・スキップにかかわらず**、本文取得直後に行う）
        → 一覧経路で登録時に公開日が不明だった記事は、ページから取れた公開日が `source.latestPublishedAt - NEW_ITEM_GRACE_MS` 以下なら **要約せず記事行を削除**する（progress.errors には入れず、newCount から減らす）。**この削除は runPipeline のバッチ経路に限る**。RESUMMARIZE / REFETCH_CONTENT の単発実行では削除せず、publishedAt を実日付に更新したうえで通常どおり要約する（ユーザーが明示的に要求した操作でカードが黙って消えないため）。ページからも公開日が取れない場合は要約する。取れた場合は source.latestPublishedAt も更新する
        → contentSource="none" かつ rssSummary が無い（一覧経路など）場合は **要約せず** status="error", error="本文を取得できなかったため要約をスキップしました"（attempts++。タイトルだけの要約に課金しない）
        → summarizeArticle(text, contentSource, maxContentChars) → status="done", summary, model, summarizedAt（切り詰めは summarizeArticle → buildSummaryUser の1か所で行う。DB に保存する contentText も maxContentChars まで）
        → 失敗: status="error", error=message, attempts++
      progress.articlesDone++ → PROGRESS 送信
 6. offscreen を release（参照カウントが0なら閉じる）→ notifyRun(newCount, doneCount, errorCount) → settings.lastRunAt=now（recoverOnly のときは更新しない）→ keepAlive.stop() → running=false → 実行中に届いた alarm/manual の要求が `storage.session.pendingTrigger` にあれば消してから runPipeline(pendingTrigger) を起動
    後片付けの各手順は個別に try/catch し、keepAlive.stop() と running=false には必ず到達する
```
- `RESUMMARIZE` / `REFETCH_CONTENT` は 5. を1件に対して実行（ロックは取らない）。"new" を経由せず直接 `status:"summarizing", summarizingAt` に遷移させてから本文取得・要約する（並行する runPipeline の 4. に拾われないため）。keepAlive と offscreen はどちらも参照カウントで共有し、単発実行も try/finally で start/stop・acquire/release する。
- `onInstalled`: sources 投入・アラーム作成。APIキー未設定なら `chrome.runtime.openOptionsPage()`、設定済みなら `runPipeline("install")`。
- `onStartup`: 取り残し（"new"、または summarizingAt が15分以上前の "summarizing"）を数え、1件以上かつ APIキーがあれば `runPipeline("startup", { recoverOnly: true })` で 4.+5. だけ実行（ロック・keepAlive・進捗・後片付けは通常実行と同じ枠組み）。ゼロなら何もしない。ロック中に来た alarm/manual は `pendingTrigger` に記録され、終了後に実行される。
- アラーム: `chrome.alarms.get("fetch")` で `periodInMinutes` が異なるときだけ再作成（毎回作り直すとカウントダウンがリセットされる）。最小15分にクランプ。`intervalMinutes <= 0` は無効（アラーム削除）。`storage.onChanged` で再評価。

## 9. フィード解析（`src/lib/feedParser.ts`, `urlNormalize.ts`）

- `XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", isArray: name => ["item","entry","link","category"].includes(name), processEntities: true, trimValues: true })`
- ルート判定: `rss.channel`（RSS 2.0）/ `feed`（Atom）/ `rdf:RDF`（RSS 1.0）。BOM を除去。本文が `<!DOCTYPE html` で始まる、または既知ルートが無い場合は `NotXmlError`。
- 出力 `FeedItem { title, link, guid?, publishedAt?: Date, categories: string[], contentHtml?: string /* content:encoded | content | description | summary */, hasFullContent: boolean /* contentHtml > 2000字 */ }`
- Atom の link は `rel="alternate"` かつ `type="text/html"` を優先、無ければ最初の `@_href`。title が `{ "#text", "@_type": "html" }` の形なら unwrap。
- `normalizeUrl`: host 小文字化、hash 除去、`utm_*` / `source` / `ref` / `mkt_tok` / `fbclid` / `gi` を除去、末尾スラッシュ除去、`http`→`https`。冪等であること。
- Medium の guid（`https://medium.com/p/<hash>`）は `guid` に保存（副次キー、インデックス不要）。

## 9.5 HTML 一覧フォールバック（`src/lib/listingExtract.ts`, `src/background/listingFetcher.ts`）

RSS を提供しないソース（2026-09 時点で Uber / LinkedIn）向けに、一覧ページの HTML から記事リンクを拾って通常のパイプラインに流す。

- 発動条件: `source.listingUrl` が設定されていて、かつフィード取得（主URL）が HTTP エラー / NotXmlError / ネットワークエラーのいずれかで失敗したとき。フィードが成功したときは使わない。
- 取得: SW で `fetchArticleHtml(listingUrl, 20s, 3MB)`（`articleFetcher.ts` を再利用。text/html 以外は失敗扱い）。条件付き GET は使わない。
- 抽出（offscreen、`OFFSCREEN_EXTRACT_LINKS`）: `DOMParser` で解析 → `<base href={url}>` を挿入 → `extractListingItems(doc, { baseUrl, pattern, excludePattern? })`（`src/lib/listingExtract.ts`）。
- `extractListingItems` の規則:
  1. `doc.querySelectorAll("a[href]")` を文書順に走査し、`new URL(href, baseUrl)` で絶対化 → `normalizeUrl` → `new RegExp(pattern)` にマッチするものだけ候補にする。`javascript:` / `mailto:` / `#` は除外。
  1'. 除外: 祖先に `nav` / `header` / `footer` / `[role=navigation]` / `[role=menu]` がある、`hreflang` 属性を持つ、`rel` に `nofollow`/`tag` を含む、正規化 URL が listingUrl 自身またはその祖先パス（セグメント単位の前方一致）と一致する、listingUrl とパス末尾のセグメント列が同じでロケール接頭辞だけ違う（`/es-ES/blog/engineering/` のような言語切替）、クエリに `page=` を含む、`source.listingExcludePattern` に一致する。カテゴリ・言語切替・ページ送りを落とすため。
     注: 「listingUrl の兄弟パス」の一律除外は採らない。Uber の記事 URL は `/us/en/blog/<slug>/` でカテゴリ（`/us/en/blog/health/`）と同じ深さのため、記事まで落ちてしまう。代わりに Uber は `listingLinkPattern` をロケール固定 `^https://www\\.uber\\.com/us/en/blog/[^/]+/?$` にし、`listingExcludePattern` に既知カテゴリ `^https://www\\.uber\\.com/us/en/blog/(engineering|health|ride|eats|transit|business|earn|merchants|community|freight|safety|company|culture|data|ai|mobile|backend|web|security|research|careers|products?)/?$` を指定して落とす。LinkedIn は記事がカテゴリより 1 段深いので既存パターンで足りる。
  1''. 単語カテゴリ除外（アンカー経路のみ。ld+json 由来の項目には適用しない）: 正規化 URL のパス末尾セグメント（末尾スラッシュを除く）がハイフンも数字も含まない 1 単語で、**かつ**規則 3 で決まるタイトル（空白正規化後）も空白を含まない 1 単語（`Health`, `Autonomous` など）なら除外する。カテゴリカードは「1 単語スラッグ＋1 単語見出し」になりがちな一方、1 単語スラッグの実記事（`/blog/michelangelo/` など）は見出しが複数語（`Michelangelo: Uber's Machine Learning Platform`）なので残る。`listingExcludePattern` の列挙漏れに対する補助的な防御。
     残存リスク: 上記をすり抜けた未知カテゴリ・一覧ページは、本文が 800 字を超えていれば 1 件だけ記事として登録・要約（課金）され得る。DB の重複排除により同じ URL が再び対象になることはなく、maxSummariesPerRun の上限内に収まる。Uber がカテゴリを増やしたら `listingExcludePattern` を更新する。
  2. 記事リンクらしさの判定（どちらか満たせば採用）: (a) アンカー内に `h1`〜`h4` がある、(b) アンカーのテキスト（空白正規化後）が 20 文字以上かつ空白を1つ以上含む（複数語の見出しらしさ）。
  0. 構造化データ優先: `<script type="application/ld+json">` に `ItemList`（`itemListElement[].url` / `name`）または `BlogPosting` / `NewsArticle` / `Article`（`url` or `mainEntityOfPage`, `headline`, `datePublished`）があれば、それらを規則 1・1' のパターン・除外に通したうえで**優先**して採用し、アンカー走査は ld+json から 1 件も取れなかったときだけ行う。
  3. タイトル: アンカー内の見出しテキスト → 無ければアンカーのテキスト → 無ければ `aria-label` / `title` 属性。空ならスキップ。
  4. 日付: アンカー自身、または最も近い祖先 `article` / `li` / `div`（3 階層まで）の中の `time[datetime]` を `Date.parse`。無ければ `undefined`。
  5. 正規化 URL で重複除去（先勝ち）。返り値 `ListingItem { url: string; title: string; publishedAt?: number }[]`。文書順を保つ（一覧の上ほど新しいとみなす）。
- パイプラインへの受け渡し（`listingFetcher.ts` の `fetchListingItems(source): Promise<ListingItem[]>`）: `FeedItem { title, link: url, publishedAt: publishedAt ? new Date(publishedAt) : undefined, categories: [], hasFullContent: false }` に変換し、フィード経路と共通の `commitNewItems(source, settings, candidates, "listing")`（`src/background/commit.ts`）に流す。新着判定は §8-3 と同じ「公開日が `latestPublishedAt - 猶予` より新しい」。一覧経路だけの違い:
  - 公開日不明の項目は捨てずに登録し、`Article.publishedAt = createdAt`（取得時刻の仮値）とする。本文取得時にページの公開日で §8-5 の判定を行う（古ければ削除）。ただし **初期化済みで公開日不明の項目は文書順の先頭 1 件までしか登録しない**（一覧の並びが新しい順である前提で、過去記事を大量に拾わないため）。**未初期化のときは合計 1 件だけ**登録する: 公開日ありの候補があればその最新 1 件、無ければ公開日不明の文書順先頭 1 件（§0 の「初回は各ブログ最新 1 件」を守る）。
  - `upsertSources`（§8-2）は `latestPublishedAt` を他の実行時フィールド（etag / lastStatus / lastFetchMode …）と同様に前回値から必ず維持する。
  - 残存リスク: 一覧に日付が無く、記事ページからも日付が取れないページ（カテゴリなど）は 1 回だけ要約され得る。同じ URL は DB 重複排除で二度目は対象にならない。
- 記事本文は通常どおり記事ページを Readability で抽出する。一覧ページが JS 描画のみで `<a href>` を含まない場合は 0 件になり、`lastError` に「一覧ページから記事リンクを抽出できませんでした」を記録する。
- 設定ページ: `listingUrl` を持つソースの行に「一覧ページ抽出テスト」ボタンを出し、`TEST_LISTING` の結果を `一覧: 12件 / 最新: <title>` またはエラーで表示する。`listingUrl` の上書きは対象外（既定値のみ）。全ソース共通で「このソースの記事を削除して再取得」ボタン（`RESET_SOURCE`、確認ダイアログ付き）を置く。
- `scripts/check-feeds.ts`: `listingUrl` を持つソースは主URL失敗時に一覧ページも取得し、jsdom で `extractListingItems` を実行して `形式=listing / 件数 / 最新タイトル` の行を追加する。件数欄は `12件（日付あり 12）` のように一覧から公開日が取れた件数も出す。さらに先頭1件の記事ページを取得し、offscreen と同じ順序（`meta[property=article:published_time]` → `meta[name=date|pubdate|publish-date|dc.date]` → ld+json の datePublished → `time[datetime]`）で公開日が取れるかを `記事ページの日付: 2026-09-10` または `取れず` として行末に添える。一覧が 1 件以上取れれば、そのソースは失敗に数えない。

## 10. 本文抽出（`src/offscreen/`, `src/background/offscreenClient.ts`）

```ts
let creating: Promise<void> | null = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url: "src/offscreen/index.html", reasons: ["DOM_PARSER"], justification: "記事HTMLから本文を抽出する" })
    .finally(() => { creating = null; });
  await creating;
}
```
offscreen 側: `new DOMParser().parseFromString(html, "text/html")` → `<base href={url}>` を挿入 → `new Readability(doc).parse()` → `{ title, text: textContent を空白正規化, excerpt, publishedAt? }` を返す。`publishedAt` は Readability の前に `meta[property="article:published_time"]` → `meta[name="date"|"pubdate"|"publish-date"|"dc.date"]` → ld+json の `datePublished` → `article time[datetime]` / `time[datetime]` の順で探し `Date.parse` できた最初の値（epoch ms）。fetch は SW 側で行い、offscreen は解析だけ。HTML は 3MB で打ち切ってから送る。offscreen の利用は `acquire()` / `release()` の参照カウントで管理し、利用者がゼロになったときだけ `chrome.offscreen.closeDocument()`（例外は無視）。

## 11. Claude 連携（`src/lib/claudeClient.ts`, `prompts.ts`, `summarySchema.ts`）

- クライアント: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3, timeout: 120_000 })`
- スキーマ（zod。長さ制約はプロンプト側で指示し、スキーマは型だけ）:
```ts
export const SummarySchema = z.object({
  headline: z.string(),          // 40字以内の日本語見出し
  brief: z.string(),             // 3文程度のざっくり紹介（①）
  digest: z.array(z.string()),   // 忙しい人向け要点 3〜7項目（②）
  detail: z.string(),            // 400〜800字の解説。改行で段落分け（③）
  tags: z.array(z.string()),     // 最大5つ
});
```
- 要約呼び出し:
```ts
const msg = await client.beta.messages.create({
  model: settings.model, max_tokens: 8000,
  ...(USE_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  system: SUMMARY_SYSTEM,                                         // 固定文字列（キャッシュ効率）
  output_config: { effort: settings.effort, format: zodOutputFormat(SummarySchema) },
  messages: [{ role: "user", content: buildSummaryUser(article, text, contentSource, maxContentChars) }],  // 切り詰めはここで1回だけ
});
if (msg.stop_reason === "refusal") throw new SummaryRefusedError(msg.stop_details?.category, msg.stop_details?.explanation);
if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました");
const text = msg.content.find(b => b.type === "text")?.text ?? "";
return parseSummaryText(text);   // JSON.parse → SummarySchema.safeParse。失敗時は最初の {...} を抽出して再試行。それでも駄目なら throw
```
- `SUMMARY_SYSTEM`（日本語・固定）:
```
あなたは海外テック企業のエンジニアリングブログを日本の技術者向けに紹介する編集者です。与えられた記事を読み、日本語で3段階の要約をJSONで返してください。
- headline: 記事の内容が一目で分かる日本語の見出し（40字以内。原題の直訳ではなく内容を表す）
- brief: 3文程度のざっくり紹介（何についての記事か、なぜ注目に値するか）
- digest: 忙しい人向けの要点まとめ。3〜7項目の箇条書き。各項目1〜2文で、具体的な数値・技術名・結論を含める
- detail: より詳しく分かりやすい解説（400〜800字）。背景→課題→アプローチ→結果→学びの順。専門用語には短い補足を添える。段落は改行で区切り、マークダウン記法は使わない
- tags: 技術トピックのタグを最大5つ
固有名詞・製品名・技術名は原語のまま。記事に書かれていないことは推測しない。本文の取得元が「RSS概要」の場合は分かる範囲で書き、detail の末尾に「（本文を取得できなかったためRSSの概要に基づく要約）」と付記する。
```
- user ターン: `タイトル / ソース名 / URL / 公開日 / 本文の取得元: ページ本文|RSS概要|なし` の後に `<article>…本文…</article>`。
- チャット（アプリページで実行）:
```ts
const stream = client.beta.messages.stream({
  model, max_tokens: 8000, ...(USE_FALLBACKS ? { betas, fallbacks: "default" } : {}),
  system: [{ type: "text", text: buildChatSystem(article, contentText ?? summaryAsText), cache_control: { type: "ephemeral" } }],
  messages: history.map(m => ({ role: m.role, content: m.content })),
});
stream.on("text", delta => setDraft(d => d + delta));
const final = await stream.finalMessage();
// refusal → 「Claudeが回答を拒否しました（カテゴリ: …）」を表示し、assistant ターンは保存しない
```
チャット system: `あなたは技術記事についての質問に日本語で答えるアシスタントです。以下の記事の内容に基づいて回答し、記事に書かれていない事柄は「記事には記載がありません」と明示したうえで一般知識として補足してください。` + メタ情報 + `<article>…</article>`。記事ブロックがキャッシュ対象の安定プレフィックスになる。
- APIキー検証: `client.models.retrieve(settings.model)`（出力トークンを消費しない）。エラー変換は `instanceof` を most-specific-first で判定（文字列マッチ禁止）: `AuthenticationError`→「APIキーが無効です」、`NotFoundError`→「モデルIDが見つかりません」、`RateLimitError`→「レート制限中です」、`APIConnectionError`→「APIに接続できません（ネットワークを確認してください）」（`APIError` のサブクラスで status が無いので `APIError` より先に判定）、その他 `APIError`→ status と message。
- 料金目安（README に記載）: 1記事あたり入力 約5k〜15k トークン + 出力 約2k。Opus 5 で数円〜10円程度。

## 12. UI

### アプリページ（`src/app/`）
- **Toolbar**: 「今すぐ更新」（実行中は無効化）/ ソースフィルタチップ / 「未読のみ」トグル / 状態フィルタ（要約中・エラー）/ 設定リンク
- **StatusBar**: 最終更新時刻 / 進捗「要約中 3/12」/ エラー件数
- **ArticleList**: `useLiveQuery`、`publishedAt` 降順。ソースフィルタ・未読フィルタを適用
- **ArticleCard**: ソースバッジ・日付・`summary.headline`（無ければ原題）・`summary.brief`・状態チップ（`要約中…` スピナー / `エラー: …` + 「再試行」→ `RESUMMARIZE`）・tags
- **ArticleDetail**（カードクリックで展開。右ペインまたは全幅）: 原題 + 「元記事を開く」/ セクション「要点まとめ」= `digest` の `<ul>` / セクション「解説」= `detail`（`white-space: pre-wrap`）/ 本文取得元の注記（RSS概要なら明示）/ 「本文を再取得して再要約」→ `REFETCH_CONTENT` / 開いたら `readAt` を記録
- **ChatPanel**: `db.chats` の履歴 / textarea + 送信 / ストリーミング表示の assistant バブル / 「履歴を消去」/ エラー・拒否の表示 / APIキー未設定時は案内を出して無効化
- `?article=<id>` のディープリンク（通知クリック用）。既に開いているアプリタブがあればそれをフォーカスして再利用。

### 設定ページ（`src/options/`）
- APIキー（伏字 + 表示切替 + 「接続テスト」結果行）
- モデル（select: `claude-opus-5`（既定）/ `claude-sonnet-5` / `claude-haiku-4-5` / カスタム入力）
- 要約の思考量 effort（低 / 中（既定）/ 高）
- 自動更新間隔（6時間 / 12時間 / 24時間（既定）/ 48時間 / 無効）
- 新着通知 ON/OFF
- ソース一覧: 行ごとに 有効トグル・名前・フィードURL入力（上書き）・「フィード接続テスト」→ `HTTP 200 / 25件 / 本文あり / 最新: <title>` またはエラー ・「候補URLを試す」（`altFeedUrls` を順にテストし、成功したものを上書きに採用）・「一覧ページ抽出テスト」（`listingUrl` があるソースのみ。§9.5）
- 詳細: 同時要約数（1〜4）/ 本文の最大文字数 / 1回の更新あたりの最大新着数（ソースごと）/ 1回の更新あたりの最大要約数（全体。既定 30）
- 危険な操作: 「全データを削除して初期状態に戻す」→ `RESET_ALL`（確認ダイアログ付き）
- 保存で `chrome.storage.local` に書き `SETTINGS_CHANGED` を送る

### 見た目
- システムフォント、ライト/ダーク両対応（`prefers-color-scheme`）、幅 900px 程度の中央カラム。外部CSS/フォント/CDNは使わない（拡張のCSP）。

## 13. MV3 の落とし穴（対処必須）

1. 全リスナー（`onInstalled` / `onStartup` / `alarms.onAlarm` / `action.onClicked` / `notifications.onClicked` / `runtime.onMessage` / `storage.onChanged`）を `background/index.ts` の**先頭で同期登録**。top-level await 禁止。
2. SW は約30秒でアイドル終了 → 実行中は `keepAlive`（20秒ごと `chrome.runtime.getPlatformInfo()`）。単一 fetch は5分未満（SDK timeout 120s、feed/page fetch 20s の AbortController）。
3. メモリ上の状態に頼らない（ロック/進捗は `storage.session`、孤児 `summarizing` は起動時に回収）。
4. SW からの `chrome.runtime.sendMessage` は受信者がいないと例外 → broadcast ヘルパで握りつぶす。
5. offscreen document は1つだけ（`getContexts` で存在確認 + 作成 Promise のシングルトン）。`closeDocument` の例外は無視。
6. 通知の `iconUrl` はパッケージ内アセット（`icons/128.png`）。通知ID `run-<timestamp>`。クリックで `openApp()` と `notifications.clear`。
7. `action.onClicked` は `default_popup` があると発火しない。
8. Vite で `process` 参照に困ったら `define: { "process.env": {} }`。SW は `type: "module"`。
9. `crypto.subtle.digest` は非同期。`hash.ts` の `sha256Hex` は `globalThis.crypto.subtle` を使い、Node（scripts / tests）でも同じコードで動かす。
10. crxjs dev モードは `server.port` / `server.hmr.port` を固定。HMR が不調なら `vite build --watch` + 手動リロード。

## 14. scripts

- `scripts/check-feeds.ts`（`npx tsx`）: `DEFAULT_SOURCES` を読み、各 feedUrl（`--all-alternates` で alt も）を 20s タイムアウト・ブラウザ風 UA で fetch → 表を出力: name / URL / HTTP status / content-type / 形式（rss2・atom・rdf・not-xml）/ 件数 / 最新タイトル+日付 / 本文全文あり(yes/no)。主URLがひとつでも失敗したら exit 1（§9.5 の一覧フォールバックで 1 件以上取れたソースは失敗に数えない）。
- `scripts/gen-icons.mjs`: 依存なしの最小PNGエンコーダ（zlib + CRC32）で 16/48/128 px のアイコンを生成。
- `scripts/smoke-extension.mjs`: Playwright の `chromium.launchPersistentContext` に `--disable-extensions-except=dist --load-extension=dist` を渡して起動し、`context.serviceWorkers()` / `waitForEvent("serviceworker")` で SW が登録されること、`chrome-extension://<id>/src/app/index.html` と `src/options/index.html` がエラーなく描画されること（`h1` が出る）を確認。`executablePath` は `/opt/pw-browsers/chromium` 配下（サンドボックス）またはデフォルト。

## 15. テスト（Vitest）

- `tests/feedParser.test.ts`: RSS2 + `content:encoded` + CDATA / Atom（複数 `<link rel>`・typed title）/ Medium フィード（guid `medium.com/p/...`、link に `?source=rss`）/ guid なし RSS2 / RDF / HTML ページが返った場合 → `NotXmlError` / item が1件だけ（isArray）/ categoryFilter
- `tests/urlNormalize.test.ts`: utm・source 除去、末尾スラッシュ、hash、http→https、冪等性
- `tests/htmlToText.test.ts`: タグ除去、`<br>`/`<p>` → 改行、エンティティ、script/style 除去
- `tests/summarySchema.test.ts`: 正常 JSON / 文章に包まれた JSON / 欠損フィールド → エラー / 型違い
- `tests/prompts.test.ts`: user プロンプトに本文取得元マーカーと切り詰めが反映される
- `tests/readability.test.ts`（`// @vitest-environment jsdom`）: fixture HTML から 800 字以上抽出できる
- `tests/commit.test.ts`（`fake-indexeddb/auto` を import して Dexie を Node で動かす。`chrome.storage` は使わない経路のみ）: `upsertSources` を通しても `latestPublishedAt` / etag / lastFetchMode が保持される / `commitNewItems` が未初期化または latestPublishedAt 未設定なら最新1件だけ登録し latestPublishedAt をその公開日にする / 初期化済みなら基準（latestPublishedAt − 猶予）より新しいものだけ登録し latestPublishedAt が進む / 猶予内の遅れ記事は拾い、DB 重複は再登録しない / **初期化済み・latestPublishedAt 未設定のソースに過去記事20件のフィードを与えても新規登録は0件**（最新1件が既に DB にある場合）**で、かつ latestPublishedAt がその最新1件の公開日に設定され、同じ候補で2回目を実行しても added=0 のまま判定モードが通常に進んでいる** / 初期化済みで猶予内に既登録記事が maxNewPerSourcePerRun 件以上並んでいても、より新しい未登録記事が登録される（maxNewPerSourcePerRun=1 で検証）/ 一覧経路で公開日不明の項目は初期化済みでも先頭1件までしか登録されない / 未初期化の一覧経路で公開日あり2件＋不明2件を与えると公開日ありの最新1件だけが登録される / 上限超過の回に既登録の新しい候補があっても latestPublishedAt は登録分の最大値で止まり、繰り越し候補が次回拾われる
- `tests/listingExtract.test.ts`（`// @vitest-environment jsdom`）: fixture の一覧 HTML から、パターン一致かつ見出し/20文字以上のリンクだけが文書順・重複なしで取れる / 相対 href の絶対化 / `time[datetime]` の日付 / カテゴリリンク・ページネーションが落ちる / パターン不一致で 0 件 / nav・header・footer 内、hreflang 付き、listingUrl の祖先パス、`page=` 付きが落ちる / ld+json の ItemList・BlogPosting があればそれを優先し datePublished が publishedAt になる / `listingExcludePattern` に一致する URL が落ちる / Uber の実 URL 形（記事 `/us/en/blog/<slug>/`、カテゴリ `/us/en/blog/health/`、言語切替 `/es-ES/blog/engineering/`、トップ `/us/en/blog/`）で記事だけが残る / 列挙に無い 1 単語カテゴリ（`/us/en/blog/autonomous/`、見出し `Autonomous`）が規則 1'' で落ち、1 単語スラッグでも見出しが複数語の記事（`/us/en/blog/michelangelo/`、見出し `Michelangelo: Uber's ML Platform`）と ld+json 由来の 1 単語スラッグは残る
- `vitest.config.ts`: `environment: "node"` 既定、`include: ["tests/**/*.test.ts"]`

## 16. README.md（日本語）に書くこと

インストール（`npm i` → `npm run build`）/ `chrome://extensions` で「デベロッパーモード」→「パッケージ化されていない拡張機能を読み込む」で `dist/` を選ぶ / 初回に設定ページが開くので APIキーを入れて「接続テスト」/ 各ソースの「フィード接続テスト」/ `npm run check-feeds` の使い方 / 料金の目安 / 既知の制約（Chrome を閉じている間は更新されない、データはこの PC の Chrome 内だけ）。

## 17. 完了の定義（Definition of Done）

- `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` がサンドボックスで全て成功する。
- 本設計書の §3〜§15 に書かれた要素がすべて実装されている（Opus レビューで差分ゼロ）。
- README が §16 を満たす。
- `claude/sharp-hypatia-8zyy15` に push 済み。
