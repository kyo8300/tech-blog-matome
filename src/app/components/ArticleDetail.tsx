// 記事の詳細（要点まとめ・解説・チャット）。

import { useEffect, useState } from "react";
import type { Article, Settings } from "../../shared/types";
import { getDb } from "../../shared/db";
import { send } from "../../shared/messages";
import { ChatPanel } from "./ChatPanel";

interface Props {
  article: Article;
  sourceName: string;
  settings: Settings | undefined;
  onClose: () => void;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP");
}

/** tags の重複を除去する（Claude の出力が重複を含む場合に key 衝突を避ける） */
function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags));
}

export function ArticleDetail({ article, sourceName, settings, onClose }: Props) {
  const [refetching, setRefetching] = useState(false);
  const [refetchMessage, setRefetchMessage] = useState<string | null>(null);
  const [resummarizing, setResummarizing] = useState(false);
  const [resummarizeMessage, setResummarizeMessage] = useState<string | null>(null);

  // 開いたら readAt を記録する（未設定のときだけ）
  useEffect(() => {
    if (!article.readAt) {
      void getDb().articles.update(article.id, { readAt: Date.now() });
    }
  }, [article.id, article.readAt]);

  const handleRefetch = async () => {
    setRefetching(true);
    setRefetchMessage(null);
    try {
      const res = await send({ type: "REFETCH_CONTENT", articleId: article.id });
      if (!res.ok) {
        setRefetchMessage(res.error ?? "再取得に失敗しました");
      }
    } catch (err) {
      setRefetchMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRefetching(false);
    }
  };

  const handleResummarize = async () => {
    setResummarizing(true);
    setResummarizeMessage(null);
    try {
      const res = await send({ type: "RESUMMARIZE", articleId: article.id });
      if (!res.ok) {
        setResummarizeMessage(res.error ?? "再試行に失敗しました");
      }
    } catch (err) {
      setResummarizeMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setResummarizing(false);
    }
  };

  return (
    <div className="article-detail">
      <div className="article-detail-header">
        <button type="button" className="link-button" onClick={onClose}>
          ← 閉じる
        </button>
      </div>

      <h2 className="article-detail-title">{article.title}</h2>
      <div className="article-detail-meta">
        <span className="source-badge">{sourceName}</span>
        <span>{formatDateTime(article.publishedAt)}</span>
        <a href={article.url} target="_blank" rel="noopener">
          元記事を開く
        </a>
      </div>

      {article.summary ? (
        <>
          <section>
            <h3>要点まとめ</h3>
            <ul className="article-digest">
              {article.summary.digest.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3>解説</h3>
            <p className="article-detail-text">{article.summary.detail}</p>
          </section>
          {article.summary.tags.length > 0 && (
            <div className="tag-list">
              {uniqueTags(article.summary.tags).map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <section className="article-detail-placeholder">
          {article.status === "summarizing" && (
            <p>
              <span className="spinner" aria-hidden="true" /> 要約中…
            </p>
          )}
          {article.status === "new" && <p>未要約です。</p>}
          {article.status === "error" && (
            <p className="chip-error">
              エラー: {article.error ?? "不明なエラー"}
              <button type="button" onClick={() => void handleResummarize()} disabled={resummarizing}>
                {resummarizing ? "再試行中…" : "再試行"}
              </button>
            </p>
          )}
          {resummarizeMessage && <p className="error-message">{resummarizeMessage}</p>}
        </section>
      )}

      {article.contentSource === "rss" && (
        <p className="note">本文を取得できなかったためRSSの概要に基づく要約です</p>
      )}
      {article.contentSource === "none" && (
        <p className="note">本文も概要も取得できなかったためタイトルに基づく要約です</p>
      )}

      <button type="button" onClick={() => void handleRefetch()} disabled={refetching}>
        {refetching ? "再取得中…" : "本文を再取得して再要約"}
      </button>
      {refetchMessage && <p className="error-message">{refetchMessage}</p>}

      <ChatPanel article={article} sourceName={sourceName} settings={settings} />
    </div>
  );
}
