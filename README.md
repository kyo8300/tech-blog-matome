# Tech Blog まとめ

海外テック企業のエンジニアリングブログ15本を1か所に集め、新着記事をClaudeで日本語の3段階要約にして読める個人用のChrome拡張（Manifest V3）です。記事ごとにClaudeへ質問できるチャットも付いています。サーバーは使わず、拡張だけで完結します。

## インストール

```bash
npm i
npm run build
```

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をONにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、このリポジトリの `dist/` フォルダを選ぶ

インストール直後は設定ページが自動で開きます（APIキーが未設定の場合のみ）。APIキー欄にAnthropicのAPIキーを入力し、「接続テスト」で疎通を確認してください（`client.models.retrieve()` を呼ぶだけなので出力トークンは消費しません）。APIキーを保存したら、ツールバーアイコンからアプリページを開き「今すぐ更新」を押すと初回の取り込み（各ブログ最新1件ずつの要約）が始まります。以降は設定した間隔で自動更新されます。

### 各ソースの接続確認

設定ページのソース一覧では、行ごとに以下が使えます。

- **フィード接続テスト**: そのブログのフィードURLに実際にアクセスし、`HTTP 200 / 記事数 / 本文全文の有無 / 最新記事タイトル` またはエラー内容を表示します
- **候補URLを試す**: フィードURLが変わっている場合に備えた代替URL（`altFeedUrls`）を順番に試し、成功したものをそのソースのフィードURLとして上書き保存します。代替URLが登録されているソースの行にだけ表示されます

フィードURLは行内で直接上書きできます（配信元がURLを変更した場合などに使ってください）。

### RSSが無いソース（Uber / LinkedIn）

Uber Engineering と LinkedIn Engineering は2026年9月時点でRSSフィードが提供されていません（フィードURL・代替URLとも404）。この2ソースは、フィード取得に失敗すると自動的に**一覧ページのHTMLから記事リンクを抽出するフォールバック**に切り替わります。一覧ページの記事一覧（構造化データ〈ld+json〉があればそれを優先し、無ければ見出しや十分な長さ・複数語のリンクテキストを持つものだけをナビゲーション等を除外しつつ）を上から順に拾い、通常のフィード記事と同じように取り込みます。日付が取得できない記事は取得時刻を公開日時として扱い、記事ページの公開日が取得できた時点で正しい値に更新されます。

設定ページのソース一覧では、この2ソースの行にだけ「**一覧ページ抽出テスト**」ボタンが表示されます。押すと一覧ページを取得して実際に何件の記事リンクが抽出できるかを確認でき、`一覧: 12件 / 最新: <タイトル>` のように結果が表示されます（失敗時はエラー内容を表示）。フィードが正常に取得できている間はこのフォールバックは使われません。

**新着判定について**: フィード・一覧のどちらの経路でも「前回取り込んだ最新記事より新しい記事だけを要約する」という基準で新着を判定します。RSSフィードにも一覧ページにも過去記事がずっと並び続けるため、「DBに未登録＝新着」という判定は使えません（過去記事を毎回新着として大量に取り込み、要約APIのクレジットを浪費してしまいます）。そこで各ソースは「これまでに取り込んだ記事の最新公開日」（`latestPublishedAt`）を保持し、**公開日がそれより新しい記事だけを新着**として扱います（並び順や時差のズレで遅れて載る記事を拾うため、数日分の猶予を設けます）。一覧経路で公開日が分からない記事は、記事ページを取得した時点で本当の公開日を確認し、実は基準以下（新着ではない）と分かった場合は要約せず取り消します。初回はさらに安全側に倒し、各ソース最新1件だけを取り込みます。設定ページの各ソース行にある「**このソースの記事を削除して再取得**」ボタンを押すと、そのソースの記事・要約・チャット履歴を削除し、`latestPublishedAt` を含めて未取得状態に戻せます（確認ダイアログあり）。

## 使い方

- ツールバーのアイコンをクリックすると、拡張の専用タブページ（アプリページ）が開きます
- 「今すぐ更新」ボタンで手動更新できます（自動更新は既定で24時間ごと。設定ページで変更可能）
- 記事カードには ① 見出し + 3文のざっくり紹介 が表示されます。カードを開くと ② 忙しい人向けの要点まとめ と ③ 詳しく分かりやすい解説 が読めます
- 記事詳細から「元記事を開く」で原文にアクセスできます。本文が取得できなかった場合はRSSの概要から要約している旨が明記されます
- 記事ごとにチャットで質問できます（記事本文を踏まえてClaudeが日本語で回答します。履歴はこのPCのIndexedDBに保存されます）
- 新着があればOS通知が届き、クリックするとアプリページが開きます（既に開いていればそのタブにフォーカス）

## フィード疎通確認スクリプト

ローカル環境でフィードの生死を一括確認できます。

```bash
npm run check-feeds
# 各ソースの feedUrl のみをチェック（既定）

npm run check-feeds -- --all-alternates
# altFeedUrls（代替候補URL）もあわせてチェック
```

ブラウザ風のUser-Agentで各URLに20秒タイムアウトでアクセスし、`name / URL / HTTPステータス / content-type / 形式（rss2・atom・rdf・not-xml）/ 記事数 / 最新タイトル+日付 / 本文全文の有無` を表で出力します。**いずれかのソースの主URL（feedUrl）が失敗すると exit code 1** になります（CIなどでの自動チェックに使えます）。フィードの主URLが失敗し、かつ一覧ページフォールバック（Uber / LinkedIn）が設定されているソースは、一覧ページも取得して記事リンクを抽出し（形式=`listing`の行として表に追加）、1件以上抽出できればそのソースは失敗に数えません。

> **注意**: このスクリプトをClaude Code on the webのサンドボックス上で実行すると、egress policyにより15ブログのドメインへ到達できず（403）、全件失敗してexit 1になります。これは環境の制約による想定内の結果です。実際のフィード疎通確認は、このリポジトリをローカル環境にcloneして `npm run check-feeds` を実行してください。

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | Vite開発サーバー（拡張のHMR。`chrome://extensions` から `dist/` を読み込んだ状態で使う） |
| `npm run build` | 本番ビルド（`dist/` を生成） |
| `npm run typecheck` | `tsc --noEmit` による型チェック |
| `npm test` | Vitestによる単体テスト（fixtureのXML・HTMLを使用。ネットワークアクセスなし） |
| `npm run check-feeds` | 上記のフィード疎通確認スクリプト |
| `npm run smoke` | Playwrightで `dist/` を拡張として読み込み、アプリページ・設定ページが正常に描画されるかを確認する煙テスト（先に `npm run build` が必要） |
| `npm run gen-icons` | アイコン（16/48/128px）を生成 |

## 料金の目安

要約は記事1件あたり入力トークン約5,000〜15,000 + 出力トークン約2,000程度です。既定モデルのOpus 5では、1記事あたりおおむね**数円〜10円程度**です（実際の料金は記事の長さやモデル・思考量の設定によって変動します）。チャットでの質問はこれとは別に消費されます。

### 想定外の大量課金を防ぐしくみ

- **1回の更新あたりの最大要約数**（設定ページの「詳細」。既定30件）を超えた分は要約せず、`status: "new"` のまま次回の更新に繰り越します（公開日が新しい記事を優先）。
- 本文もRSSの概要も取得できなかった記事（一覧ページ経由で本文取得に失敗した場合など）は、タイトルだけでAPIに課金するのを避けるため**要約自体を行わずエラー扱い**にします。
- 要約中にAPIキーの認証エラー、またはAPI残高不足のエラーが発生した場合は、その回の残りの要約をただちに打ち切り（進行中の呼び出しは完了を待ちます）、未着手の記事は `status: "new"` のまま次回に持ち越します。

## 既知の制約

- **Chromeを閉じている間は更新されません**。自動更新は `chrome.alarms` によるものなので、Chromeが起動していない時間帯の新着は次回起動後（または次のアラーム）にまとめて取り込まれます
- **データはこのPCのChromeの中だけ**に保存されます（IndexedDB / `chrome.storage`）。同期はされないので、他の端末やプロファイルには引き継がれません
- **`host_permissions` が `https://*/*` と広い理由**: フィードのドメインと記事ページのドメインが異なるブログがある（例: Medium配信のブログなど）、リダイレクトを挟むフィードがある、将来的にソースを追加できるようにするため、といった理由からです。個人利用のローカル拡張のため、この権限範囲を許容しています
- **記事ページがJavaScriptで描画される場合**、本文抽出（Readability）が失敗することがあります。その場合は自動的にRSSの概要（`description` など）にフォールバックして要約します。要約の末尾に「（本文を取得できなかったためRSSの概要に基づく要約）」と明記されます

## 収録ブログ（15本）

| ブログ | サイト |
|---|---|
| Netflix TechBlog | https://netflixtechblog.com/ |
| Cloudflare Blog | https://blog.cloudflare.com/ |
| Stripe Blog | https://stripe.com/blog/engineering |
| Engineering at Meta | https://engineering.fb.com/ |
| Shopify Engineering | https://shopify.engineering/ |
| Uber Engineering | https://www.uber.com/us/en/blog/engineering/ |
| Airbnb Engineering & Data Science | https://medium.com/airbnb-engineering |
| GitHub Engineering | https://github.blog/engineering/ |
| Chrome for Developers (Google) | https://developer.chrome.com/blog |
| Engineering at Microsoft | https://devblogs.microsoft.com/engineering-at-microsoft/ |
| LinkedIn Engineering | https://www.linkedin.com/blog/engineering |
| Spotify Engineering | https://engineering.atspotify.com/ |
| Pinterest Engineering | https://medium.com/pinterest-engineering |
| Atlassian Engineering | https://www.atlassian.com/blog/atlassian-engineering/cloud-overview |
| Slack Engineering | https://slack.engineering/ |
