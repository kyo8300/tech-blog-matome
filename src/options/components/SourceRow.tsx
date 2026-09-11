// ソース一覧の1行。有効トグル・名前・フィードURL上書き・接続テスト・代替URL採用。
import { useState } from "react";
import { send } from "../../shared/messages";
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

export function SourceRow(props: {
  source: Source;
  enabled: boolean;
  feedUrlOverride: string | undefined;
  onToggle: (enabled: boolean) => void;
  onUrlChange: (url: string | undefined) => void;
}) {
  const { source, enabled, feedUrlOverride, onToggle, onUrlChange } = props;
  const effectiveUrl = feedUrlOverride ?? source.feedUrl;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<FeedTestResult | null>(null);
  const [tryingAlt, setTryingAlt] = useState(false);

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
      </div>
      {result && <p className={`result ${result.ok ? "ok" : "error"}`}>{formatResult(result)}</p>}
    </div>
  );
}
