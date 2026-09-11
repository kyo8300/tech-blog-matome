// 記事一覧の取得・フィルタリング。db.articles / db.sources を useLiveQuery で購読する。

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "../../shared/db";
import type { Article, Source } from "../../shared/types";

/** 状態フィルタの選択肢（Toolbar の「すべて・要約中・エラー」に対応） */
export type StatusFilter = "all" | "summarizing" | "error";

export interface ArticleFilters {
  /** 選択中のソースID。空配列は「すべて」を意味する */
  sourceIds: string[];
  unreadOnly: boolean;
  status: StatusFilter;
}

export const DEFAULT_FILTERS: ArticleFilters = {
  sourceIds: [],
  unreadOnly: false,
  status: "all",
};

const EMPTY_ARTICLES: Article[] = [];
const EMPTY_SOURCES: Source[] = [];

/** publishedAt 降順・フィルタ適用済みの記事一覧と、ソース一覧・ID引きの Map を返す */
export function useArticles(filters: ArticleFilters) {
  const sourceKey = filters.sourceIds.slice().sort().join(",");

  const sources =
    useLiveQuery(() => getDb().sources.toArray(), [], EMPTY_SOURCES) ?? EMPTY_SOURCES;

  const articles =
    useLiveQuery(
      async () => {
        const all = await getDb().articles.orderBy("publishedAt").reverse().toArray();
        return all.filter((article) => {
          if (filters.sourceIds.length > 0 && !filters.sourceIds.includes(article.sourceId)) {
            return false;
          }
          if (filters.unreadOnly && article.readAt) return false;
          if (filters.status === "summarizing" && article.status !== "summarizing") return false;
          if (filters.status === "error" && article.status !== "error") return false;
          return true;
        });
      },
      [sourceKey, filters.unreadOnly, filters.status],
      EMPTY_ARTICLES,
    ) ?? EMPTY_ARTICLES;

  const sourceById = useMemo(() => {
    const map = new Map<string, Source>();
    for (const source of sources) map.set(source.id, source);
    return map;
  }, [sources]);

  return { articles, sources, sourceById };
}
