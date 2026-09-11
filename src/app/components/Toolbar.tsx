// 「今すぐ更新」/ ソースフィルタ / 未読のみ / 状態フィルタ / 設定リンク。

import { useState } from "react";
import type { PipelineProgress, Source } from "../../shared/types";
import { send } from "../../shared/messages";
import type { ArticleFilters, StatusFilter } from "../hooks/useArticles";
import { SourceFilter } from "./SourceFilter";

interface Props {
  progress: PipelineProgress;
  sources: Source[];
  filters: ArticleFilters;
  onFiltersChange: (filters: ArticleFilters) => void;
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "summarizing", label: "要約中" },
  { value: "error", label: "エラー" },
];

export function Toolbar({ progress, sources, filters, onFiltersChange }: Props) {
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);

  const handleFetchNow = async () => {
    setFetchMessage(null);
    try {
      const res = await send({ type: "FETCH_NOW" });
      if (!res.started) {
        setFetchMessage(res.reason ?? "更新を開始できませんでした");
      }
    } catch (err) {
      setFetchMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <button type="button" onClick={() => void handleFetchNow()} disabled={progress.running}>
          {progress.running ? "更新中…" : "今すぐ更新"}
        </button>
        {fetchMessage && <span className="toolbar-message">{fetchMessage}</span>}

        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.unreadOnly}
            onChange={(e) => onFiltersChange({ ...filters, unreadOnly: e.target.checked })}
          />
          未読のみ
        </label>

        <div className="status-filter" role="group" aria-label="状態フィルタ">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={filters.status === opt.value ? "chip chip-selected" : "chip"}
              onClick={() => onFiltersChange({ ...filters, status: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="link-button toolbar-settings"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          設定
        </button>
      </div>

      <SourceFilter
        sources={sources}
        selected={filters.sourceIds}
        onChange={(sourceIds) => onFiltersChange({ ...filters, sourceIds })}
      />
    </div>
  );
}
