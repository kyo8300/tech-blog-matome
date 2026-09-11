# Tech Blog まとめ（Chrome拡張）

海外テック企業のエンジニアリングブログ15本を集め、新着記事をClaudeで日本語3段階要約にして読む個人用Chrome拡張（MV3）。

## まず読むもの
1. `docs/DESIGN.md` … 設計（構成・データモデル・メッセージ・パイプライン・プロンプト・UI・落とし穴）。**実装はこのファイルが正**。
2. `docs/WORKFLOW.md` … 開発フロー。サブエージェントの割り当てと、設計どおりになるまでのループ手順。
3. `docs/feeds.opml` … フィード初期値（15本）。

## 必須ルール
- 開発ブランチ: `claude/sharp-hypatia-8zyy15`。ここにコミット・push する。
- 実装・テスト作成は **Sonnet** のサブエージェント、レビュー・検証は **Opus** のサブエージェントに委譲する（`docs/WORKFLOW.md` 参照）。親セッションは指示・統合・判断に徹する。
- レビューまたは検証で「設計との差分」「バグ」が出たら、修正→再レビュー→再検証を**差分ゼロになるまでループ**する。
- UI・要約・README はすべて日本語。
- Claude API は公式SDK `@anthropic-ai/sdk` のみ使う（fetch直叩き禁止）。既定モデル `claude-opus-5`。
- モデルIDやセッションIDをコード・コミットに書かない。

## 環境の制約（Claude Code on the web のサンドボックス）
- 15ブログのドメインには egress policy で到達できない（403）。フィードの実取得はユーザーのローカルでのみ可能。
- サンドボックスでできる検証: `npm run typecheck` / `npm test`（fixture XML）/ `npm run build` / Playwright + 同梱Chromium（`/opt/pw-browsers/chromium`）で `dist/` を `--load-extension` した煙テスト。
- npm registry と Anthropic API には到達できる。
