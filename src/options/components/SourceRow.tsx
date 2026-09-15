// ソース一覧の1行。有効トグル・名前・フィードURL上書き・接続テスト・代替URL採用。
import { useState } from "react";
import { send } from "../../shared/messages";
import { isLockActive } from "../../shared/settings";
import type { FeedTestResult, Source } from "../../shared/types";

function formatResult(result: FeedTestResult): string {
  if (!result.ok) {
    return result.error ?? "接続テストに失敗しました";
  }
  const status = result.status ?? "?";
  const count = result.itemCount ?? 0;
  const content = result.hasFullContent ? "本文あり" : "本文なし";
  const newest = result.newestTitle ?? "-";
  return `HTTP ${status} / ${count}件 / ${content} / 最新: ${newest}`;
}

/** 一覧ページ抽出テスト（§9.5）の結果表示 */
function formatListingResult(result: FeedTestResult): string {
  if (!result.ok) {
    return result.error ?? "一覧ページ抽出テストに失敗しました";
  }
  const count = result.itemCount ?? 0;
  const newest = result.newestTitle ?? "-";
  return `一覧: ${count}件 / 最新: ${newest}`;
}

export function SourceRow(props: {
  source: Source;
  enabled: boolean;
  feedUrlOverride: string | undefined;
  /**
   * 実行ロックが有効かどうか（親コンポーネントが isLockActive で判定した表示時点の値）。
   * true の間は「このソースの記事を削除して再取得」を無効化する。
   */
  resetLocked: boolean;
  onToggle: (enabled: boolean) => void;
  onUrlChange: (url: string | undefined) => void;
}) {
  const { source, enabled, feedUrlOverride, resetLocked, onToggle, onUrlChange } = props;
  const effectiveUrl = feedUrlOverride ?? source.feedUrl;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<FeedTestResult | null>(null);
  const [tryingAlt, setTryingAlt] = useState(false);
  const [listingTesting, setListingTesting] = useState(false);
  const [listingResult, setListingResult] = useState<FeedTestResult | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await send({ type: "TEST_FEED", url: effectiveUrl });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleTryAlternates() {
    setTryingAlt(true);
    setResult(null);
    try {
      for (const altUrl of source.altFeedUrls) {
        const r = await send({ type: "TEST_FEED", url: altUrl });
        if (r.ok) {
          onUrlChange(altUrl);
          setResult(r);
          return;
        }
      }
      setResult({ ok: false, error: "候補URLもすべて失敗しました" });
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTryingAlt(false);
    }
  }

  async function handleTestListing() {
    setListingTesting(true);
    setListingResult(null);
    try {
      const r = await send({ type: "TEST_LISTING", sourceId: source.id });
      setListingResult(r);
    } catch (err) {
      setListingResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setListingTesting(false);
    }
  }

  async function handleResetSource() {
    // ボタンの disabled は直近の PROGRESS 通知（最大1分ごとの再評価）に基づく表示なので、
    // 実際に送信する直前に GET_PROGRESS で再判定し、今まさにロックが有効なら
    // 確認ダイアログを出さずに案内だけ表示する（SW 側の RESET_SOURCE 拒否と二重に守る）。
    try {
      const fresh = await send({ type: "GET_PROGRESS" });
      if (isLockActive(fresh)) {
        setResetMessage("更新の実行中は削除できません。完了後に再度お試しください。");
        return;
      }
    } catch {
      // 再判定に失敗しても致命的ではない（このあとの RESET_SOURCE 自体が SW 側でロックを見て拒否する）
    }

    const confirmed = window.confirm(
      `「${source.name}」の記事・要約・チャット履歴を削除し、未取得状態に戻します。次回の更新で最新1件から取り込み直します。この操作は取り消せません。よろしいですか？`,
    );
    if (!confirmed) return;
    setResetting(true);
    setResetMessage(null);
    try {
      const r = await send({ type: "RESET_SOURCE", sourceId: source.id });
      setResetMessage(r.ok ? `削除しました（${r.deleted}件）。` : `削除に失敗しました: ${r.error ?? "不明なエラー"}`);
    } catch (err) {
      setResetMessage(`削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="source-row">
      <div className="source-row-main">
        <label className="toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span>{source.name}</span>
        </label>
      </div>
      <div className="row">
        <input
          type="text"
          value={feedUrlOverride ?? ""}
          placeholder={source.feedUrl}
          onChange={(e) => onUrlChange(e.target.value === "" ? undefined : e.target.value)}
          className="feed-url"
        />
        <button type="button" className="secondary" onClick={handleTest} disabled={testing}>
          {testing ? "テスト中…" : "フィード接続テスト"}
        </button>
        {source.altFeedUrls.length > 0 && (
          <button type="button" className="secondary" onClick={handleTryAlternates} disabled={tryingAlt}>
            {tryingAlt ? "試行中…" : "候補URLを試す"}
          </button>
        )}
        {source.listingUrl && (
          <button type="button" className="secondary" onClick={handleTestListing} disabled={listingTesting}>
            {listingTesting ? "テスト中…" : "一覧ページ抽出テスト"}
          </button>
        )}
        <button type="button" className="danger" onClick={handleResetSource} disabled={resetting || resetLocked}>
          {resetting ? "削除中…" : "このソースの記事を削除して再取得"}
        </button>
      </div>
      {result && <p className={`result ${result.ok ? "ok" : "error"}`}>{formatResult(result)}</p>}
      {listingResult && (
        <p className={`result ${listingResult.ok ? "ok" : "error"}`}>{formatListingResult(listingResult)}</p>
      )}
      {resetLocked && <p className="result">更新の実行中は削除できません。完了後に再度お試しください。</p>}
      {resetMessage && <p className={`result ${resetMessage.startsWith("削除しました") ? "ok" : "error"}`}>{resetMessage}</p>}
    </div>
  );
}
