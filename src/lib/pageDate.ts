// 記事ページの公開日時を抽出する純粋関数。DOM API（Document）だけに依存するため、
// offscreen（DOMParser が作る Document）と scripts/check-feeds.ts（jsdom の Document）の
// 両方から同じ抽出順で使える。§10 / §14。

import { findDateTexts } from "./dateText";
import { cleanTextContent } from "./domText";

/** 最初の h1 から祖先を遡ってテキスト日付を探す最大階層 */
const MAX_H1_ANCESTOR_DEPTH = 5;

/** h1 が無いときに body テキストの先頭何文字までを日付探索の対象にするか */
const BODY_TEXT_HEAD_CHARS = 3000;

/** 日付とみなす年の下限（西暦1990年）。これより古い年は誤検出とみなして拾わない */
const MIN_YEAR = 1990;

/** 日付とみなす年の上限（実行時の年+1）。今年+1 より先の年は誤検出とみなして拾わない */
function maxYear(): number {
  return new Date().getUTCFullYear() + 1;
}

/** epoch ms の年が 1990〜今年+1 の範囲内かどうか */
function isPlausibleEpoch(epochMs: number): boolean {
  if (Number.isNaN(epochMs)) return false;
  const year = new Date(epochMs).getUTCFullYear();
  return year >= MIN_YEAR && year <= maxYear();
}

/** 埋め込み JSON の公開日キー探索で 1 script あたり走査する最大文字数（巨大な script 対策） */
const MAX_EMBEDDED_JSON_SCAN_CHARS = 2 * 1024 * 1024;

/**
 * 埋め込み JSON（Next.js 等の state script）で見かける公開日キー名。
 * page_generated_at / createdAt / updatedAt はここに含めない（対象外）。
 * 数値 epoch は `(?<!\d)(?:\d{10}|\d{13})(?!\d)` で前後を数字境界にし、
 * 14桁以上の数値の先頭10桁/13桁に部分一致しないようにする（10桁・13桁以外は候補にしない）。
 */
const EMBEDDED_JSON_KEY_RE =
  /"(publishedAt|datePublished|published_at|date_published|publishDate|publish_date|published_time|publishedDate)"\s*:\s*("[^"]{8,40}"|(?<!\d)(?:\d{10}|\d{13})(?!\d))/g;

/**
 * `\"` と `\u0022` を `"` に戻す（script textContent 内でエスケープされた引用符を復元する）。
 * scripts/check-feeds.ts の --debug-dates 診断（項目4）からも同じデコードとして再利用する。
 */
export function unescapeEmbeddedQuotes(text: string): string {
  return text.replace(/\\u0022/gi, '"').replace(/\\"/g, '"');
}

/** マッチした値（クォート付き文字列 or 数字のみ）を epoch ms に変換する。妥当でなければ undefined */
function parseEmbeddedJsonValue(rawValue: string): number | undefined {
  if (rawValue.startsWith('"')) {
    const inner = rawValue.slice(1, -1);
    const parsed = Date.parse(inner);
    return isPlausibleEpoch(parsed) ? parsed : undefined;
  }
  // 数値 epoch: 10桁=秒, 13桁=ミリ秒
  const asNumber = Number(rawValue);
  const epochMs = rawValue.length === 10 ? asNumber * 1000 : asNumber;
  return isPlausibleEpoch(epochMs) ? epochMs : undefined;
}

/**
 * ld+json 以外の全 `<script>` の textContent から、埋め込み JSON の公開日キー
 * （publishedAt 等）を探し、最初に妥当な値を epoch ms で返す。Uber の記事ページはこの形。
 * script が大量・巨大な場合に備え、1 script あたり MAX_EMBEDDED_JSON_SCAN_CHARS を超える
 * 部分は走査しない。
 */
function findEmbeddedJsonPublishedAt(doc: Document): number | undefined {
  const scripts = Array.from(doc.querySelectorAll("script")).filter(
    (el) => el.getAttribute("type") !== "application/ld+json",
  );
  for (const script of scripts) {
    const raw = script.textContent;
    if (!raw) continue;
    const truncated =
      raw.length > MAX_EMBEDDED_JSON_SCAN_CHARS ? raw.slice(0, MAX_EMBEDDED_JSON_SCAN_CHARS) : raw;
    const decoded = unescapeEmbeddedQuotes(truncated);
    EMBEDDED_JSON_KEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMBEDDED_JSON_KEY_RE.exec(decoded))) {
      const epoch = parseEmbeddedJsonValue(m[2]!);
      if (epoch !== undefined) return epoch;
    }
  }
  return undefined;
}

/** 空白（改行含む）を1つのスペースに正規化してトリムする */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 最初の h1 から祖先を最大5階層上り、各祖先の除外済みテキスト（空白正規化）に
 * findDateTexts がちょうど1件返す最初の祖先の値を返す。h1 が無ければ undefined。
 */
function findDateFromH1Ancestor(doc: Document): number | undefined {
  const h1 = doc.querySelector("h1");
  if (!h1) return undefined;
  let ancestor: Element | null = h1.parentElement;
  for (let depth = 0; depth < MAX_H1_ANCESTOR_DEPTH && ancestor; depth++) {
    const text = normalizeWhitespace(cleanTextContent(ancestor));
    const found = findDateTexts(text);
    if (found.length === 1) return found[0];
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

/** body テキスト（script/style/noscript/template 除外）先頭 BODY_TEXT_HEAD_CHARS 字の中で最初に見つかった日付テキスト */
function findDateFromBodyText(doc: Document): number | undefined {
  const bodyText = (doc.body ? cleanTextContent(doc.body) : "").slice(0, BODY_TEXT_HEAD_CHARS);
  return findDateTexts(bodyText)[0];
}

/**
 * selector に一致する全要素の datetime 属性値を文書順で返す（空文字は除外）。
 * 先頭の1要素だけを見ると、読了時間表示の `<time datetime="PT8M">` や空の datetime が
 * 最初に来た場合に後続の本当の日付を持つ time 要素が一切評価されなくなるため、全件集める。
 */
function allDatetimeAttrs(doc: Document, selector: string): string[] {
  return Array.from(doc.querySelectorAll(selector))
    .map((el) => el.getAttribute("datetime"))
    .filter((v): v is string => !!v && v.trim() !== "");
}

/** meta タグの content 属性値を返す（空文字は undefined 扱い） */
function metaContent(doc: Document, selector: string): string | undefined {
  const content = doc.querySelector(selector)?.getAttribute("content");
  return content && content.trim() ? content : undefined;
}

/** ld+json（配列・@graph 配列にも対応）から最初に見つかった datePublished を返す */
function findDatePublishedInJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findDatePublishedInJson(v);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.datePublished === "string" && obj.datePublished.trim()) return obj.datePublished;
    if (Array.isArray(obj["@graph"])) {
      return findDatePublishedInJson(obj["@graph"]);
    }
  }
  return undefined;
}

function findPublishedAtFromLd(doc: Document): string | undefined {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent;
    if (!raw || !raw.trim()) continue;
    try {
      const found = findDatePublishedInJson(JSON.parse(raw));
      if (found) return found;
    } catch {
      // 壊れた JSON-LD は無視する
    }
  }
  return undefined;
}

/**
 * §10: 記事の公開日時を探す。Readability で本文が書き換えられる前に呼ぶこと（offscreen 側）。
 * meta[property="article:published_time"] → meta[name="date"|"pubdate"|"publish-date"|"dc.date"]
 * → ld+json の datePublished → 埋め込み JSON の公開日キー（ld+json 以外の script textContent から
 *   publishedAt 等のキーを探す。Uber の記事ページはこの形）
 * → article time[datetime] / time[datetime]（各セレクタとも該当する
 *   全要素を文書順に候補にする。読了時間表示の `<time datetime="PT8M">` のような日付でない
 *   time 要素や空の datetime が先頭にあっても、後続の time 要素が評価される）
 * → テキスト日付（最初の h1 から祖先を最大5階層上り、findDateTexts がちょうど1件の祖先の値。
 *   h1 が無ければ本文先頭3000字の最初の日付テキスト）の順に探し、
 * Date.parse できた最初の値（テキスト日付は findDateTexts が返す epoch ms をそのまま使う）を返す。
 */
export function extractPublishedAt(doc: Document): number | undefined {
  // `??` で1候補に畳むと、優先度の高い候補が「存在するが Date.parse できない」場合に
  // 後続候補が一切試されなくなる。そのため各候補を個別の要素として並べ、
  // 存在するものを優先順に1つずつ Date.parse し、成功した最初の値を採用する
  // （存在するが parse できない候補は飛ばして次へ進む）。
  const preEmbeddedCandidates: (string | undefined)[] = [
    metaContent(doc, 'meta[property="article:published_time"]'),
    metaContent(doc, 'meta[name="date"]'),
    metaContent(doc, 'meta[name="pubdate"]'),
    metaContent(doc, 'meta[name="publish-date"]'),
    metaContent(doc, 'meta[name="dc.date"]'),
    findPublishedAtFromLd(doc),
  ];
  for (const candidate of preEmbeddedCandidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const embedded = findEmbeddedJsonPublishedAt(doc);
  if (embedded !== undefined) return embedded;

  const timeCandidates: (string | undefined)[] = [
    ...allDatetimeAttrs(doc, "article time[datetime]"),
    ...allDatetimeAttrs(doc, "time[datetime]"),
  ];
  for (const candidate of timeCandidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const h1Date = findDateFromH1Ancestor(doc);
  if (h1Date !== undefined) return h1Date;
  return findDateFromBodyText(doc);
}
