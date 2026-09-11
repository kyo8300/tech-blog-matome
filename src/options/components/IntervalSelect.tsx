// 自動更新間隔の選択（分単位で保持）。
const OPTIONS: { value: number; label: string }[] = [
  { value: 360, label: "6時間" },
  { value: 720, label: "12時間" },
  { value: 1440, label: "24時間（既定）" },
  { value: 2880, label: "48時間" },
  { value: 0, label: "無効" },
];

export function IntervalSelect(props: { value: number; onChange: (minutes: number) => void }) {
  const { value, onChange } = props;
  return (
    <div className="field">
      <label htmlFor="interval">自動更新間隔</label>
      <select id="interval" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
