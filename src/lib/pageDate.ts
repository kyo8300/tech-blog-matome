// 記事ページの公開日時を抽出する純粋関数。DOM API（Document）だけに依存するため、
// offscreen（DOMParser が作る Document）と scripts/check-feeds.ts（jsdom の Document）の
// 両方から同じ抽出順で使える。§10 / §14。

import { findDateTexts } from "./dateText";

/** 最初の h1 から祖先を遡ってテキスト日付を探す最大階層 */
const MAX_H1_ANCESTOR_DEPTH = 5;

/** h1 が無いときに body テキストの先頭何文字までを日付探索の対象にするか */
const BODY_TEXT_HEAD_CHARS = 3000;

/** 空白（改行含む）を1つのスペースに正規化してトリムする */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 最初の h1 から祖先を最大5階層上り、各祖先の textContent（空白正規化）に
 * findDateTexts がちょうど1件返す最初の祖先の値を返す。h1 が無ければ undefined。
 */
function findDateFromH1Ancestor(doc: Document): number | undefined {
  const h1 = doc.querySelector("h1");
  if (!h1) return undefined;
  let ancestor: Element | null = h1.parentElement;
  for (let depth = 0; depth < MAX_H1_ANCESTOR_DEPTH && ancestor; depth++) {
    const text = normalizeWhitespace(ancestor.textContent ?? "");
    const found = findDateTexts(text);
    if (found.length === 1) return found[0];
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

/** body テキスト先頭 BODY_TEXT_HEAD_CHARS 字の中で最初に見つかった日付テキスト */
function findDateFromBodyText(doc: Document): number | undefined {
  const bodyText = (doc.body?.textContent ?? "").slice(0, BODY_TEXT_HEAD_CHARS);
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
 * → ld+json の datePublished → article time[datetime] / time[datetime]（各セレクタとも該当する
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
  const candidates: (string | undefined)[] = [
    metaContent(doc, 'meta[property="article:published_time"]'),
    metaContent(doc, 'meta[name="date"]'),
    metaContent(doc, 'meta[name="pubdate"]'),
    metaContent(doc, 'meta[name="publish-date"]'),
    metaContent(doc, 'meta[name="dc.date"]'),
    findPublishedAtFromLd(doc),
    ...allDatetimeAttrs(doc, "article time[datetime]"),
    ...allDatetimeAttrs(doc, "time[datetime]"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const h1Date = findDateFromH1Ancestor(doc);
  if (h1Date !== undefined) return h1Date;
  return findDateFromBodyText(doc);
}
