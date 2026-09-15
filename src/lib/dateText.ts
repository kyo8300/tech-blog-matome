// §9.5 規則4 / §10 のテキスト日付フォールバックで使う純粋関数。
// HTML の time[datetime] や meta / ld+json に日付が無いページ（LinkedIn 等）向けに、
// 本文テキストから「Sep 2, 2026」のような日付表記を検出して epoch ms に変換する。
// DOM には一切依存しない（文字列だけを受け取る）。

/** 月のフルネーム（0始まりの月番号に対応） */
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** 月の略称（0始まりの月番号に対応。"sept" は別表記として MONTH_NAME_PATTERN 側で追加する） */
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 月名（フルネーム・略称・"sept"）から 0始まりの月番号を返す。該当しなければ undefined */
function monthIndexFromName(name: string): number | undefined {
  const lower = name.toLowerCase();
  const fullIdx = MONTH_NAMES.indexOf(lower);
  if (fullIdx !== -1) return fullIdx;
  if (lower === "sept") return 8; // September の別表記
  const abbrIdx = MONTH_ABBR.indexOf(lower);
  return abbrIdx !== -1 ? abbrIdx : undefined;
}

// 月名の正規表現片。フルネームを先に並べ、"September" が "sept" 側で途中一致して
// 後続トークンに失敗しても、バックトラックでフルネーム側に再チャレンジできるようにする。
const MONTH_NAME_PATTERN = `(?:${MONTH_NAMES.join("|")}|sept|${MONTH_ABBR.join("|")})`;

interface RawDateMatch {
  index: number;
  epochMs: number;
}

/** 日付とみなす年の下限（西暦1990年）。これより古い年は電話番号等の誤検出とみなして拾わない */
const MIN_YEAR = 1990;

/** 日付とみなす年の上限（実行時の年+1）。今年+1 より先の年は誤検出とみなして拾わない */
function maxYear(): number {
  return new Date().getUTCFullYear() + 1;
}

/**
 * UTC 0時（timeMs 指定時はその時刻）の epoch ms を作る。
 * Date.UTC は月・日のオーバーフローを繰り上げてしまう（2月30日→3月2日等）ため、
 * 往復チェックで無効な日付を弾く。年が 1990〜今年+1 の範囲外（電話番号や無関係な数値の誤検出）も弾く。
 */
function makeUtcDate(year: number, monthIndex: number, day: number, timeMs?: number): number | undefined {
  if (year < MIN_YEAR || year > maxYear()) return undefined;
  if (monthIndex < 0 || monthIndex > 11) return undefined;
  if (day < 1 || day > 31) return undefined;
  const midnight = Date.UTC(year, monthIndex, day);
  const d = new Date(midnight);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return undefined;
  }
  return timeMs !== undefined ? midnight + timeMs : midnight;
}

/** regex を text 全体に適用し、toMatch が返した結果を out に集める */
function collectMatches(
  regex: RegExp,
  text: string,
  toMatch: (m: RegExpExecArray) => RawDateMatch | undefined,
  out: RawDateMatch[],
): void {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    const found = toMatch(m);
    if (found) out.push(found);
    if (m[0].length === 0) regex.lastIndex++; // ゼロ幅マッチでの無限ループ対策（念のため）
  }
}

// 1. "Month Day, Year"（"Sep 2, 2026" / "September 2, 2026"）
const MONTH_DAY_YEAR_RE = new RegExp(
  `(?<![A-Za-z])(${MONTH_NAME_PATTERN})\\.?\\s+(\\d{1,2}),\\s+(\\d{4})(?!\\d)`,
  "gi",
);

// 2. "Day Month Year"（"2 Sep 2026" / "2 September 2026"）
const DAY_MONTH_YEAR_RE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\s+(${MONTH_NAME_PATTERN})\\.?\\s+(\\d{4})(?!\\d)`,
  "gi",
);

// 3. ISO 8601（"2026-09-02"。"T10:00:00Z" / "T10:00:00+09:00" / "T10:00:00-0700" のような
//    タイムゾーンオフセット付き時刻も1件として扱う）
const ISO_DATE_RE =
  /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g;

// 4. "2026/09/02"
const SLASH_DATE_RE = /(?<![\d/])(\d{4})\/(\d{2})\/(\d{2})(?![\d/])/g;

/**
 * テキストから日付表記を検出し、出現順に epoch ms（UTC 0時。ISO で時刻が付いていればその時刻）
 * の配列を返す。対応する形式:
 * - "Sep 2, 2026" / "September 2, 2026"（"Sept." のような略称+ピリオドも許容）
 * - "2 Sep 2026" / "2 September 2026"
 * - "2026-09-02"（"2026-09-02T10:00:00Z" / "T10:00:00+09:00" / "T10:00:00-0700" のような
 *   タイムゾーンオフセット付き時刻も1件として扱う。オフセット無しの時刻は UTC 扱いに統一する）
 * - "2026/09/02"
 * "12/31" のような年なしの表記や、電話番号・年だけの数字列は拾わない
 * （いずれも上記の形に一致しないため自然に除外される）。年が 1990〜実行時の年+1 の範囲外の場合も
 * （すべての形式で共通）拾わない。月名は大文字小文字を区別しない。
 */
export function findDateTexts(text: string): number[] {
  const matches: RawDateMatch[] = [];

  collectMatches(
    MONTH_DAY_YEAR_RE,
    text,
    (m) => {
      const monthIndex = monthIndexFromName(m[1]!);
      if (monthIndex === undefined) return undefined;
      const epochMs = makeUtcDate(Number(m[3]), monthIndex, Number(m[2]));
      return epochMs === undefined ? undefined : { index: m.index, epochMs };
    },
    matches,
  );

  collectMatches(
    DAY_MONTH_YEAR_RE,
    text,
    (m) => {
      const monthIndex = monthIndexFromName(m[2]!);
      if (monthIndex === undefined) return undefined;
      const epochMs = makeUtcDate(Number(m[3]), monthIndex, Number(m[1]));
      return epochMs === undefined ? undefined : { index: m.index, epochMs };
    },
    matches,
  );

  collectMatches(
    ISO_DATE_RE,
    text,
    (m) => {
      const year = Number(m[1]);
      const monthIndex = Number(m[2]) - 1;
      const day = Number(m[3]);
      const timePart = m[4];
      // 年月日そのものの妥当性チェック（範囲・存在しない日付）は時刻の有無によらず先に行う
      const midnight = makeUtcDate(year, monthIndex, day);
      if (midnight === undefined) return undefined;
      if (timePart) {
        // オフセット（Z / +09:00 / -0700）が無い場合は Date.parse がローカルタイムとして
        // 解釈してしまう（日付のみの形式は UTC 扱いになるのに対し、日時形式は仕様上ローカル扱い）ため、
        // 明示的な Z を補ってオフセット無しは UTC 扱いに統一する。
        const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(timePart);
        const isoString = `${m[1]}-${m[2]}-${m[3]}${timePart}${hasOffset ? "" : "Z"}`;
        const parsed = Date.parse(isoString);
        if (!Number.isNaN(parsed)) return { index: m.index, epochMs: parsed };
      }
      return { index: m.index, epochMs: midnight };
    },
    matches,
  );

  collectMatches(
    SLASH_DATE_RE,
    text,
    (m) => {
      const epochMs = makeUtcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return epochMs === undefined ? undefined : { index: m.index, epochMs };
    },
    matches,
  );

  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => m.epochMs);
}
