// 記事一覧の1件分のカード。

import { useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { Article, Source } from "../../shared/types";
import { send } from "../../shared/messages";

interface Props {
  article: Article;
  source: Source | undefined;
  selected: boolean;
  onSelect: () => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("ja-JP");
}

/** tags の重複を除去する（Claude の出力が重複を含む場合に key 衝突を避ける） */
function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags));
}

export function ArticleCard({ article, source, selected, onSelect }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const handleRetry = async (e: MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await send({ type: "RESUMMARIZE", articleId: article.id });
      if (!res.ok) {
        setRetryMessage(res.error ?? "再試行に失敗しました");
      }
    } catch (err) {
      setRetryMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // カード内の「再試行」ボタンなど、入れ子の要素上のキー操作はここでは扱わない
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  const classNames = ["article-card"];
  if (selected) classNames.push("selected");
  if (!article.readAt) classNames.push("unread");

  return (
    <div
      className={classNames.join(" ")}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="article-card-meta">
        <span className="source-badge">{source?.name ?? article.sourceId}</span>
        <span className="article-date">{formatDate(article.publishedAt)}</span>
      </div>

      <h2 className="article-headline">{article.summary?.headline ?? article.title}</h2>
      {article.summary?.brief && <p className="article-brief">{article.summary.brief}</p>}

      {article.status === "summarizing" && (
        <span className="chip chip-status">
          <span className="spinner" aria-hidden="true" />
          要約中…
        </span>
      )}
      {article.status === "new" && <span className="chip chip-status">未要約</span>}
      {article.status === "error" && (
        <span className="chip chip-status chip-error">
          エラー: {article.error ?? "不明なエラー"}
          <button type="button" onClick={(e) => void handleRetry(e)} disabled={retrying}>
            {retrying ? "再試行中…" : "再試行"}
          </button>
        </span>
      )}
      {retryMessage && <p className="error-message">{retryMessage}</p>}

      {article.summary && article.summary.tags.length > 0 && (
        <div className="tag-list">
          {uniqueTags(article.summary.tags).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
