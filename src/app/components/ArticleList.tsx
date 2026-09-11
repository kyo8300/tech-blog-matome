// 記事一覧。

import type { Article, Source } from "../../shared/types";
import { ArticleCard } from "./ArticleCard";

interface Props {
  articles: Article[];
  sourceById: Map<string, Source>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

export function ArticleList({ articles, sourceById, selectedId, onSelect }: Props) {
  if (articles.length === 0) {
    return <p className="empty-state">記事がありません。「今すぐ更新」を試してください。</p>;
  }

  return (
    <ul className="article-list">
      {articles.map((article) => (
        <li key={article.id}>
          <ArticleCard
            article={article}
            source={sourceById.get(article.sourceId)}
            selected={article.id === selectedId}
            onSelect={() => onSelect(article.id)}
          />
        </li>
      ))}
    </ul>
  );
}
