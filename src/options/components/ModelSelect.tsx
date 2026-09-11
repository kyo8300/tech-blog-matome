// モデル選択。MODEL_PRESETS + 「カスタム」（自由入力）。
// カスタム入力が空の間は onChange を呼ばない（空文字を Settings.model に反映しない）。
import { useEffect, useState } from "react";
import { MODEL_PRESETS } from "../../shared/constants";

const CUSTOM = "__custom__";

export function ModelSelect(props: {
  value: string;
  onChange: (model: string) => void;
  /** カスタム入力が空でモデルIDが未確定の間は false を通知する（保存ボタンの無効化に使う） */
  onValidityChange?: (valid: boolean) => void;
}) {
  const { value, onChange, onValidityChange } = props;
  const initialIsPreset = MODEL_PRESETS.includes(value);
  const [mode, setMode] = useState<"preset" | "custom">(initialIsPreset ? "preset" : "custom");
  const [draft, setDraft] = useState<string>(initialIsPreset ? "" : value);

  useEffect(() => {
    onValidityChange?.(mode === "preset" || draft.trim() !== "");
  }, [mode, draft, onValidityChange]);

  return (
    <div className="field">
      <label htmlFor="model">モデル</label>
      <select
        id="model"
        value={mode === "preset" ? value : CUSTOM}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setMode("custom");
            setDraft(MODEL_PRESETS.includes(value) ? "" : value);
          } else {
            setMode("preset");
            onChange(e.target.value);
          }
        }}
      >
        {MODEL_PRESETS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM}>カスタム</option>
      </select>
      {mode === "custom" && (
        <>
          <input
            type="text"
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              if (next.trim() !== "") {
                onChange(next.trim());
              }
            }}
            placeholder="モデルIDを入力"
            className="custom-model"
          />
          {draft.trim() === "" && <p className="result error">モデルIDを入力してください</p>}
        </>
      )}
    </div>
  );
}
