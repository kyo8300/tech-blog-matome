# 開発フロー — サブエージェント運用と「設計どおりになるまでループ」

親セッション（オーケストレーター）は自分でコードを書かず、以下の役割分担でサブエージェント（`Agent` ツール）に委譲する。
各エージェントには**必ず `docs/DESIGN.md` の該当セクションを読ませてから**作業させる。

| 役割 | model | subagent_type | やること |
|---|---|---|---|
| 実装 | **sonnet** | general-purpose | 設計書の指定セクションどおりにコードを書く。`npm run typecheck` が通るまで自分で直す |
| テスト作成 | **sonnet** | general-purpose | `docs/DESIGN.md` §15 のテストと fixture を書き、`npm test` が通るまで直す |
| レビュー | **opus** | general-purpose | 対象ファイルと設計書を突き合わせ、「設計との差分」「バグ」「MV3 の落とし穴（§13）違反」を **file:line 付きの一覧**で返す。修正はしない |
| 検証 | **opus** | general-purpose | `npm run typecheck && npm test && npm run build && npm run smoke` を実行し、結果と失敗原因を返す。修正はしない |

`Agent` 呼び出し時は `model: "sonnet"` / `model: "opus"` を明示する。互いに独立なフェーズ（例: フェーズ3 と 4）は**同じメッセージ内で並列起動**する。

## フェーズ（DESIGN.md の §番号に対応）

| # | フェーズ | 実装（Sonnet） | テスト（Sonnet） | 完了条件 |
|---|---|---|---|---|
| 1 | スキャフォールド | package.json / tsconfig / vite.config / vitest.config / manifest.config / .gitignore / 3つの index.html / `scripts/gen-icons.mjs` + アイコン生成 | — | `npm i` 成功、`npm run build` が空の SW でも通る |
| 2 | shared | §5 types / constants / sources(§6) / settings / db / messages(§7) | — | typecheck |
| 3 | lib（純粋TS） | §9 feedParser / urlNormalize / hash / htmlToText / concurrency、§11 summarySchema / prompts | §15 の feedParser / urlNormalize / htmlToText / summarySchema / prompts | typecheck + test |
| 4 | Claude連携 | §11 claudeClient（summarizeArticle / streamChat / testApiKey / エラー変換） | — | typecheck。`claude-api` スキルの TypeScript README に従う |
| 5 | offscreen + background | §10 offscreen / offscreenClient、§8 pipeline / feedFetcher / articleFetcher / summarizer / notifications / alarms / keepAlive / progress / messageRouter / index | §15 readability(jsdom) | typecheck + build |
| 6 | アプリページ | §12 hooks → components → styles | — | typecheck + build |
| 7 | 設定ページ | §12 設定ページ | — | typecheck + build |
| 8 | scripts + README | §14 check-feeds / smoke-extension、§16 README | — | `npm run smoke` 成功 |

## ループ手順（各フェーズごと）

```
1. 実装（Sonnet）  … 対象セクションを渡す。既存ファイルの一覧と、依存する型の所在も渡す
2. テスト（Sonnet）… そのフェーズにテストがあれば。1. と並列でよい（インターフェースは設計書で確定しているため）
3. レビュー（Opus）… 差分一覧を受け取る
4. 差分があれば → 1. に戻す（差分一覧をそのまま Sonnet に渡して修正させる）→ 3. を再実行
   差分ゼロになるまで繰り返す（上限は設けない。ただし同じ指摘が3回続いたら親が設計書の曖昧さを疑い、DESIGN.md を明確化してから続行）
5. 検証（Opus）  … typecheck / test / build（フェーズ8 以降は smoke も）
6. 失敗があれば → 1. に戻す → 3.〜5. を再実行
7. 全部緑になったらフェーズ完了。親が `git add -A && git commit` して次フェーズへ
```

最終フェーズ完了後、**全体レビュー（Opus）**を1回行う: DESIGN.md §3〜§16 を頭から順に読み、実装との差分を列挙 → 差分があればループ → ゼロになったら §17 の Definition of Done を満たしたと判断し push。

## サブエージェントへの指示テンプレート

### 実装（Sonnet）
```
あなたは Chrome 拡張（MV3）の実装担当です。
1. まず /home/user/tech-blog-matome/docs/DESIGN.md の §<番号> と §13（MV3 の落とし穴）を読む。
2. 次のファイルを設計書どおりに作成/修正する: <ファイル一覧>
3. 設計書に書かれていない判断が必要になったら、設計書の意図に最も近い方を選び、最後の報告に「判断した点」として列挙する。
4. 完了前に `npm run typecheck` を実行し、エラーがゼロになるまで直す。
5. 報告: 作成したファイル一覧、判断した点、未解決の懸念。
制約: UI 文言・コメントは日本語。Claude API は @anthropic-ai/sdk のみ。外部 CDN 禁止。モデルIDやセッションIDをコードに書かない。
```

### テスト（Sonnet）
```
あなたはテスト担当です。/home/user/tech-blog-matome/docs/DESIGN.md の §15 と、テスト対象の §<番号> を読み、
tests/ 配下に Vitest のテストと fixtures を作成する。`npm test` が通るまで直す。
実装側に明らかなバグがあればテストを緩めず、報告に「実装のバグ」として file:line で書く。
```

### レビュー（Opus）
```
あなたはレビュー担当です。修正はしません。
/home/user/tech-blog-matome/docs/DESIGN.md の §<番号> と §13 を読み、次のファイルを突き合わせる: <ファイル一覧>
出力形式（この形式以外は書かない）:
- [設計差分|バグ|MV3違反] file:line — 何が設計と違うか / 何が壊れるか — 期待される状態
差分がなければ「差分なし」とだけ書く。
```

### 検証（Opus）
```
あなたは検証担当です。修正はしません。
/home/user/tech-blog-matome で `npm run typecheck && npm test && npm run build`（フェーズ8以降は `&& npm run smoke`）を実行し、
各コマンドの成否と、失敗した場合はエラー出力の要点と原因の推定を file:line 付きで報告する。
注意: このサンドボックスは外部ブログのドメインに到達できない。ネットワーク起因の失敗はそのように分類する。
```

## 環境メモ
- ブランチ: `claude/sharp-hypatia-8zyy15`
- サンドボックスから到達可: npm registry、Anthropic API。到達不可: 15ブログのドメイン（フィードの実取得はユーザーのローカルで `npm run check-feeds`）。
- Playwright 用 Chromium: `/opt/pw-browsers/chromium`（`playwright install` は実行しない）。
- コミットは日本語でも英語でもよいが、モデルID・セッションIDを含めない。
