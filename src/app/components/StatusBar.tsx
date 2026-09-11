// 最終更新時刻 / 進捗 / エラー件数。

import type { PipelineProgress, Settings } from "../../shared/types";

interface Props {
  settings: Settings | undefined;
  progress: PipelineProgress;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP");
}

function progressLabel(progress: PipelineProgress): string | null {
  if (!progress.running) return null;
  if (progress.phase === "feeds") {
    return `フィード取得中 ${progress.feedsDone}/${progress.feedsTotal}`;
  }
  if (progress.phase === "summarizing") {
    return `要約中 ${progress.articlesDone}/${progress.articlesTotal}`;
  }
  return "更新中…";
}

export function StatusBar({ settings, progress }: Props) {
  const label = progressLabel(progress);

  return (
    <div className="status-bar">
      <span className="status-bar-item">
        最終更新: {settings?.lastRunAt ? formatDateTime(settings.lastRunAt) : "未実行"}
      </span>
      {label && (
        <span className="status-bar-item status-bar-progress">
          <span className="spinner" aria-hidden="true" />
          {label}
        </span>
      )}
      {progress.errors.length > 0 && (
        <span className="status-bar-item status-bar-errors">エラー {progress.errors.length}件</span>
      )}
    </div>
  );
}
