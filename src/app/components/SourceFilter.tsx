// ソースの複数選択チップ。

import type { Source } from "../../shared/types";

interface Props {
  sources: Source[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function SourceFilter({ sources, selected, onChange }: Props) {
  if (sources.length === 0) return null;

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="source-filter" role="group" aria-label="ソースフィルタ">
      {sources.map((source) => (
        <button
          key={source.id}
          type="button"
          className={selected.includes(source.id) ? "chip chip-selected" : "chip"}
          onClick={() => toggle(source.id)}
        >
          {source.name}
        </button>
      ))}
      {selected.length > 0 && (
        <button type="button" className="chip chip-clear" onClick={() => onChange([])}>
          クリア
        </button>
      )}
    </div>
  );
}
