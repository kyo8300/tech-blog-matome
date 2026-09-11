// 記事についてのAI質問チャット。

import { useState } from "react";
import type { KeyboardEvent } from "react";
import type { Article, Settings } from "../../shared/types";
import { useChat } from "../hooks/useChat";

interface Props {
  article: Article;
  sourceName: string;
  settings: Settings | undefined;
}

export function ChatPanel({ article, sourceName, settings }: Props) {
  const { messages, draft, sending, error, refusal, send, clear } = useChat(
    article,
    sourceName,
    settings,
  );
  const [input, setInput] = useState("");
  const hasApiKey = Boolean(settings?.apiKey);

  const handleSend = async () => {
    if (!input.trim() || sending || !hasApiKey) return;
    const text = input;
    setInput("");
    await send(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <section className="chat-panel">
      <div className="chat-panel-header">
        <h3>この記事について質問する</h3>
        {messages.length > 0 && (
          <button type="button" className="link-button" onClick={() => void clear()}>
            履歴を消去
          </button>
        )}
      </div>

      {!hasApiKey && <p className="chat-disabled-note">設定ページでAPIキーを登録してください</p>}

      {messages.length > 0 && (
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble chat-bubble-${m.role}`}>
              {m.content}
            </div>
          ))}
        </div>
      )}

      {sending && (
        <div className="chat-messages chat-messages-streaming">
          <div className="chat-bubble chat-bubble-assistant">
            {draft || <span className="spinner" aria-hidden="true" />}
          </div>
        </div>
      )}

      {refusal && (
        <p className="error-message">
          Claudeが回答を拒否しました（カテゴリ: {refusal.category ?? "不明"}）
        </p>
      )}
      {error && <p className="error-message">{error}</p>}

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="記事について質問する（Ctrl+Enterで送信）"
          disabled={!hasApiKey || sending}
          rows={3}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!hasApiKey || sending || !input.trim()}
        >
          送信
        </button>
      </div>
    </section>
  );
}
