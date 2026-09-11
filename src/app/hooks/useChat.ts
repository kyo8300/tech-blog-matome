// 記事ごとのAI質問チャット。履歴は db.chats に保存し、送信は streamChat でストリーミング表示する。

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "../../shared/db";
import type { Article, ChatThread, Settings } from "../../shared/types";
import { streamChat, describeApiError, type ChatHistoryMessage } from "../../lib/claudeClient";
import { summaryAsText } from "../../lib/prompts";

interface RefusalInfo {
  category?: string;
  explanation?: string;
}

const EMPTY_MESSAGES: ChatThread["messages"] = [];

/**
 * チャットに渡す記事本文。
 * contentText ?? summaryAsText(summary)（どちらも無ければ rssSummary ?? title）
 */
function contentForChat(article: Article): string {
  if (article.contentText) return article.contentText;
  if (article.summary) return summaryAsText(article.summary);
  return article.rssSummary ?? article.title;
}

export function useChat(
  article: Article | undefined,
  sourceName: string,
  settings: Settings | undefined,
) {
  const thread = useLiveQuery(
    () => (article ? getDb().chats.get(article.id) : undefined),
    [article?.id],
  );
  const messages = thread?.messages ?? EMPTY_MESSAGES;

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalInfo | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // 記事を切り替えたら進行中の送信を中断し、表示状態をリセットする
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setDraft("");
    setSending(false);
    setError(null);
    setRefusal(null);
  }, [article?.id]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!article || !settings?.apiKey || !trimmed || sending) return;

      setError(null);
      setRefusal(null);
      setDraft("");
      setSending(true);

      const db = getDb();
      const now = Date.now();
      const existing = (await db.chats.get(article.id)) ?? {
        articleId: article.id,
        messages: [],
        updatedAt: now,
      };
      const withUser: ChatThread["messages"] = [
        ...existing.messages,
        { role: "user", content: trimmed, createdAt: now },
      ];
      await db.chats.put({ articleId: article.id, messages: withUser, updatedAt: now });

      const history: ChatHistoryMessage[] = withUser.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const result = await streamChat({
          apiKey: settings.apiKey,
          model: settings.model,
          article: {
            title: article.title,
            url: article.url,
            publishedAt: article.publishedAt,
            sourceName,
          },
          contentText: contentForChat(article),
          history,
          onText: (delta) => setDraft((d) => d + delta),
          signal: controller.signal,
        });

        if (result.refused) {
          setRefusal(result.refused);
        } else {
          const finishedAt = Date.now();
          const latest = (await db.chats.get(article.id)) ?? {
            articleId: article.id,
            messages: withUser,
            updatedAt: finishedAt,
          };
          await db.chats.put({
            articleId: article.id,
            messages: [
              ...latest.messages,
              { role: "assistant", content: result.text, createdAt: finishedAt },
            ],
            updatedAt: finishedAt,
          });
        }
      } catch (err) {
        setError(describeApiError(err));
      } finally {
        setDraft("");
        setSending(false);
      }
    },
    [article, settings, sending, sourceName],
  );

  const clear = useCallback(async () => {
    if (!article) return;
    await getDb().chats.delete(article.id);
    setError(null);
    setRefusal(null);
    setDraft("");
  }, [article]);

  return { messages, draft, sending, error, refusal, send, clear };
}
