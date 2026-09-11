// アプリページのルートコンポーネント。900px程度の中央カラムに一覧、選択中は右ペイン（狭い幅では全幅）に詳細を表示する。

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "../shared/db";
import { DEFAULT_FILTERS, useArticles, type ArticleFilters } from "./hooks/useArticles";
import { usePipelineProgress } from "./hooks/usePipelineProgress";
import { useSettings } from "./hooks/useSettings";
import { Toolbar } from "./components/Toolbar";
import { StatusBar } from "./components/StatusBar";
import { ArticleList } from "./components/ArticleList";
import { ArticleDetail } from "./components/ArticleDetail";

/** ?article=<id> のディープリンクから記事IDを読み取る（通知クリック用） */
function readArticleIdFromUrl(): string | undefined {
  try {
    return new URLSearchParams(window.location.search).get("article") ?? undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const [filters, setFilters] = useState<ArticleFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => readArticleIdFromUrl());

  const { articles, sources, sourceById } = useArticles(filters);
  const progress = usePipelineProgress();
  const settings = useSettings();

  // 選択中の記事はフィルタの影響を受けずに直接取得する（一覧から外れていてもディープリンクで開ける）
  const selectedArticle = useLiveQuery(
    () => (selectedId ? getDb().articles.get(selectedId) : undefined),
    [selectedId],
  );

  // 選択状態をURLに反映し、リロードやブックマークでも同じ記事を開けるようにする
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) {
      url.searchParams.set("article", selectedId);
    } else {
      url.searchParams.delete("article");
    }
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  const selectedSource = selectedArticle ? sourceById.get(selectedArticle.sourceId) : undefined;
  const hasDetail = Boolean(selectedArticle);

  return (
    <div className={hasDetail ? "page has-detail" : "page"}>
      <header className="app-header">
        <h1>Tech Blog まとめ</h1>
      </header>

      <Toolbar progress={progress} sources={sources} filters={filters} onFiltersChange={setFilters} />
      <StatusBar settings={settings} progress={progress} />

      <div className={hasDetail ? "layout has-detail" : "layout"}>
        <div className="article-list-pane">
          <ArticleList
            articles={articles}
            sourceById={sourceById}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {selectedArticle && (
          <div className="article-detail-pane">
            <ArticleDetail
              key={selectedArticle.id}
              article={selectedArticle}
              sourceName={selectedSource?.name ?? selectedArticle.sourceId}
              settings={settings}
              onClose={() => setSelectedId(undefined)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
