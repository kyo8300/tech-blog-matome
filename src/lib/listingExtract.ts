// §9.5: HTML 一覧ページから記事リンクを抽出する。フィードを提供しないソース（Uber / LinkedIn）向け。
// 引数で受け取った Document のみを操作し、グローバルの document/window には触れない
// （offscreen では DOMParser が、scripts / tests では jsdom が Document を渡す）。

import type { ListingItem } from "../shared/types";
import { normalizeUrl } from "./urlNormalize";

/** アンカー内の見出しとみなすタグ名 */
const HEADING_SELECTOR = "h1, h2, h3, h4";

/** ナビゲーション等とみなす祖先セレクタ（規則1'） */
const NAV_ANCESTOR_SELECTOR = "nav, header, footer, [role=navigation], [role=menu]";

/** 記事リンクらしさ判定のしきい値（アンカーテキストの文字数） */
const MIN_ANCHOR_TEXT_LENGTH = 20;

/** 祖先を遡って time[datetime] を探す最大階層 */
const MAX_ANCESTOR_DEPTH = 3;

/** ld+json で記事一覧とみなす @type（ItemList は別扱い） */
const LD_ARTICLE_TYPES = new Set(["BlogPosting", "NewsArticle", "Article"]);

/** 空白（改行含む）を1つのスペースに正規化してトリムする */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** リンク先として無視すべき href かどうか（javascript: / mailto: / フラグメントのみ） */
function isIgnorableHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  const lower = trimmed.toLowerCase();
  return lower.startsWith("javascript:") || lower.startsWith("mailto:");
}

/** ロケールコードらしいパスセグメント（"es" / "es-ES" / "en-us" / "us"(国) など、2文字±2文字ハイフン） */
const LOCALE_SEGMENT_RE = /^[a-z]{2}(-[a-z]{2})?$/i;

/** 先頭から LOCALE_SEGMENT_RE に一致する間だけ連続してセグメントを取り除く（ロケール接頭辞の除去） */
function stripLeadingLocaleSegments(segments: string[]): string[] {
  let i = 0;
  while (i < segments.length && LOCALE_SEGMENT_RE.test(segments[i])) i++;
  return segments.slice(i);
}

/** listingUrl（baseUrl）のオリジン・パスセグメント・ロケール接頭辞を除いた末尾セグメント列 */
interface ListingLocation {
  origin: string;
  segments: string[];
  /** 先頭のロケール接頭辞（"us/en", "es-ES" 等）を取り除いた末尾セグメント列。ロケール切替判定に使う */
  localeStrippedSegments: string[];
}

function listingLocation(listingUrl: string): ListingLocation | null {
  try {
    const u = new URL(listingUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    return { origin: u.origin, segments, localeStrippedSegments: stripLeadingLocaleSegments(segments) };
  } catch {
    return null;
  }
}

/** 正規化 URL が listingUrl 自身、またはその祖先パス（パスの先頭一致で同じか短いもの）かどうか */
function isListingSelfOrAncestor(normalizedUrl: string, listing: ListingLocation | null): boolean {
  if (!listing) return false;
  let u: URL;
  try {
    u = new URL(normalizedUrl);
  } catch {
    return false;
  }
  if (u.origin !== listing.origin) return false;
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length > listing.segments.length) return false;
  return segments.every((seg, i) => seg === listing.segments[i]);
}

/**
 * 正規化 URL が、listingUrl とパス末尾のセグメント列が同じで、ロケール接頭辞だけが違う
 * 言語切替バリアントかどうか。listingUrl 側・候補側それぞれの先頭からロケール接頭辞
 * （`es-ES` のような1セグメント、`us/en` のような2セグメントいずれも可）を取り除いた
 * 末尾セグメント列どうしを比較する（接頭辞の長さ・形が両者で異なっていてもよい）。
 * 例: listingUrl が `us/en/blog/engineering`、候補が `es-ES/blog/engineering` の場合、
 * どちらも接頭辞を除くと `blog/engineering` になるため一致する。
 */
function isListingLocaleVariant(normalizedUrl: string, listing: ListingLocation | null): boolean {
  if (!listing || listing.localeStrippedSegments.length === 0) return false;
  let u: URL;
  try {
    u = new URL(normalizedUrl);
  } catch {
    return false;
  }
  if (u.origin !== listing.origin) return false;
  const segments = u.pathname.split("/").filter(Boolean);
  const strippedCandidate = stripLeadingLocaleSegments(segments);
  if (strippedCandidate.length === 0) return false;
  if (strippedCandidate.length !== listing.localeStrippedSegments.length) return false;
  return strippedCandidate.every((seg, i) => seg === listing.localeStrippedSegments[i]);
}

/** URL が `page=` クエリを含むかどうか */
function hasPageQuery(normalizedUrl: string): boolean {
  try {
    return new URL(normalizedUrl).searchParams.has("page");
  } catch {
    return false;
  }
}

/**
 * 規則1'のうち URL だけで判定できる除外（listingUrl 自身・祖先パス、言語切替バリアント、
 * page= クエリ、source.listingExcludePattern）。アンカー/ld+json 共通。
 * 規則1''（単語カテゴリ除外）はここには含めない。ld+json 由来の項目には適用せず、
 * かつタイトルも参照する必要があるため、アンカー走査側で個別に判定する。
 */
function isExcludedByUrl(normalizedUrl: string, listing: ListingLocation | null, excludeRegex: RegExp | null): boolean {
  return (
    isListingSelfOrAncestor(normalizedUrl, listing) ||
    isListingLocaleVariant(normalizedUrl, listing) ||
    hasPageQuery(normalizedUrl) ||
    (excludeRegex !== null && excludeRegex.test(normalizedUrl))
  );
}

/** 正規化 URL のパス末尾セグメント（末尾スラッシュを除く）が、ハイフンも数字も含まない1単語かどうか */
function isSingleWordUrlSlug(normalizedUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(normalizedUrl);
  } catch {
    return false;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return false;
  return !/[-0-9]/.test(last);
}

/** 空白正規化後のタイトルが、空白を含まない1単語かどうか */
function isSingleWordTitle(title: string): boolean {
  return title.length > 0 && !/\s/.test(title);
}

/**
 * 規則1''（アンカー経路のみ。ld+json 由来の項目には適用しない）: 正規化 URL のパス末尾セグメントが
 * ハイフンも数字も含まない1単語で、**かつ**規則3で決まるタイトル（空白正規化後）も空白を含まない
 * 1単語（`Health`, `Autonomous` など）なら除外する。カテゴリカードは「1単語スラッグ＋1単語見出し」に
 * なりがちな一方、1単語スラッグの実記事（`/blog/michelangelo/` など）は見出しが複数語
 * （`Michelangelo: Uber's Machine Learning Platform`）になるのが通例なので残る。
 * どちらか一方だけでは除外しない。`listingExcludePattern` の列挙漏れに対する補助的な防御。
 */
function isExcludedByWordCategory(normalizedUrl: string, title: string): boolean {
  return isSingleWordUrlSlug(normalizedUrl) && isSingleWordTitle(title);
}

/** 規則1'のうちアンカー要素の属性・祖先で判定する除外（nav/header/footer 等の祖先、hreflang、rel nofollow/tag） */
function isExcludedByAnchor(anchor: Element): boolean {
  if (anchor.closest(NAV_ANCESTOR_SELECTOR)) return true;
  if (anchor.hasAttribute("hreflang")) return true;
  const rel = (anchor.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (rel.includes("nofollow") || rel.includes("tag")) return true;
  return false;
}

/** アンカー自身、または最も近い祖先 article/li/div（3階層まで）の中の time[datetime] を探す */
function findDateElement(anchor: Element): Element | null {
  const own = anchor.querySelector("time[datetime]");
  if (own) return own;

  let ancestor: Element | null = anchor.parentElement;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && ancestor; depth++) {
    const tag = ancestor.tagName.toLowerCase();
    if (tag === "article" || tag === "li" || tag === "div") {
      const found = ancestor.querySelector("time[datetime]");
      if (found) return found;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/** time[datetime] から日時（ms epoch）を取り出す。無効なら undefined */
function parseDateFromAnchor(anchor: Element): number | undefined {
  const timeEl = findDateElement(anchor);
  const datetime = timeEl?.getAttribute("datetime");
  if (!datetime) return undefined;
  const parsed = Date.parse(datetime);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** アンカーのタイトルを決める: 見出しテキスト → アンカーのテキスト → aria-label / title 属性 */
function resolveTitle(anchor: Element, heading: Element | null): string {
  const headingText = heading ? normalizeWhitespace(heading.textContent ?? "") : "";
  if (headingText) return headingText;

  const anchorText = normalizeWhitespace(anchor.textContent ?? "");
  if (anchorText) return anchorText;

  const ariaLabel = anchor.getAttribute("aria-label");
  if (ariaLabel && normalizeWhitespace(ariaLabel)) return normalizeWhitespace(ariaLabel);

  const titleAttr = anchor.getAttribute("title");
  if (titleAttr && normalizeWhitespace(titleAttr)) return normalizeWhitespace(titleAttr);

  return "";
}

// ---- 規則0: ld+json 構造化データ ----

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ld+json の parse 結果（配列トップレベル・@graph 配列）を平坦なノード列にする */
function flattenLdNodes(value: unknown, out: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const v of value) flattenLdNodes(v, out);
    return;
  }
  if (!isRecord(value)) return;
  const graph = value["@graph"];
  if (Array.isArray(graph)) {
    flattenLdNodes(graph, out);
    return;
  }
  out.push(value);
}

/** doc 内の <script type="application/ld+json"> をすべて集めてノード列にする（壊れたJSONは無視） */
function collectLdNodes(doc: Document): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent;
    if (!raw || !raw.trim()) continue;
    try {
      flattenLdNodes(JSON.parse(raw), nodes);
    } catch {
      // 壊れた JSON-LD は無視する
    }
  }
  return nodes;
}

function ldTypeNames(node: JsonRecord): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((v): v is string => typeof v === "string");
  return [];
}

function ldUrl(node: JsonRecord): string | undefined {
  if (typeof node.url === "string" && node.url) return node.url;
  const mainEntity = node.mainEntityOfPage;
  if (typeof mainEntity === "string" && mainEntity) return mainEntity;
  if (isRecord(mainEntity) && typeof mainEntity["@id"] === "string" && mainEntity["@id"]) {
    return mainEntity["@id"] as string;
  }
  return undefined;
}

function ldTitle(node: JsonRecord): string | undefined {
  if (typeof node.headline === "string" && normalizeWhitespace(node.headline)) {
    return normalizeWhitespace(node.headline);
  }
  if (typeof node.name === "string" && normalizeWhitespace(node.name)) {
    return normalizeWhitespace(node.name);
  }
  return undefined;
}

function ldDate(node: JsonRecord): number | undefined {
  const raw = node.datePublished;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface RawLdItem {
  url: string;
  title?: string;
  publishedAt?: number;
}

/** ItemList の itemListElement 1件（{url,name,...} または {item:{...}}）から記事情報を取り出す */
function resolveListElement(element: unknown): RawLdItem | null {
  if (!isRecord(element)) return null;
  const item = isRecord(element.item) ? element.item : null;
  const url = ldUrl(element) ?? (item ? ldUrl(item) : undefined);
  if (!url) return null;
  const title = ldTitle(element) ?? (item ? ldTitle(item) : undefined);
  const publishedAt = ldDate(element) ?? (item ? ldDate(item) : undefined);
  return { url, title, publishedAt };
}

/** doc から ld+json の ItemList / BlogPosting / NewsArticle / Article を抽出する（出現順） */
function extractLdItems(doc: Document): RawLdItem[] {
  const items: RawLdItem[] = [];
  for (const node of collectLdNodes(doc)) {
    const types = ldTypeNames(node);
    if (types.includes("ItemList")) {
      const list = Array.isArray(node.itemListElement) ? node.itemListElement : [];
      for (const element of list) {
        const resolved = resolveListElement(element);
        if (resolved) items.push(resolved);
      }
      continue;
    }
    if (types.some((t) => LD_ARTICLE_TYPES.has(t))) {
      const url = ldUrl(node);
      if (url) items.push({ url, title: ldTitle(node), publishedAt: ldDate(node) });
    }
  }
  return items;
}

/**
 * ld+json から抽出した RawLdItem を、アンカー抽出と同じパターン一致・URLベースの除外
 * （規則1・1'）に通して ListingItem[] にする。タイトルが取れない項目はスキップする。
 */
function buildLdListingItems(
  rawItems: RawLdItem[],
  opts: { baseUrl: string; regex: RegExp; listing: ListingLocation | null; excludeRegex: RegExp | null },
): ListingItem[] {
  const items: ListingItem[] = [];
  const seenUrls = new Set<string>();

  for (const raw of rawItems) {
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(raw.url, opts.baseUrl).href;
    } catch {
      continue;
    }
    const normalized = normalizeUrl(absoluteUrl);
    if (!opts.regex.test(normalized)) continue;
    if (isExcludedByUrl(normalized, opts.listing, opts.excludeRegex)) continue;
    if (!raw.title) continue;
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    items.push({ url: normalized, title: raw.title, publishedAt: raw.publishedAt });
  }
  return items;
}

/**
 * 一覧ページの Document から記事リンクを抽出する。
 * 0. ld+json（ItemList / BlogPosting / NewsArticle / Article。`@graph` 配列・配列トップレベルにも対応）に
 *    規則1・1'（パターン一致・URLベースの除外。規則1''は適用しない）を適用し、1件以上残ればそれを優先して
 *    返す（アンカー走査はしない）。
 * 1./1'. それ以外は `a[href]` を文書順に走査し、`new URL(href, baseUrl)` で絶対化 → `normalizeUrl` → pattern に
 *   一致するものだけ候補にする。javascript: / mailto: / # は除外。さらに、祖先に nav/header/footer/
 *   [role=navigation]/[role=menu] がある、hreflang 属性を持つ、rel に nofollow/tag を含む、
 *   listingUrl 自身またはその祖先パス、listingUrl とパス末尾のセグメント列が同じでロケール接頭辞だけ違う
 *   （言語切替）、クエリに page= を含む、excludePattern に一致する、のいずれかに該当するものを除外する。
 * 2. アンカー内に見出し（h1〜h4）がある、またはアンカーのテキスト（空白正規化後）が20文字以上かつ
 *    空白を1つ以上含む場合だけ記事リンクとみなす。
 * 3. タイトル: 見出しテキスト → アンカーのテキスト → aria-label / title 属性。空ならスキップ。
 * 1''. 単語カテゴリ除外（アンカー経路のみ。規則3で決まったタイトルを使うためここで判定する）:
 *   パス末尾セグメントがハイフンも数字も含まない1単語、かつタイトル（空白正規化後）も空白を含まない
 *   1単語なら除外する（`/blog/health/` 見出し `Health` は落ちるが、`/blog/michelangelo/` 見出し
 *   `Michelangelo: Uber's ML Platform` のような1単語スラッグの実記事は見出しが複数語なので残る）。
 * 4. 日付: アンカー自身、または最も近い祖先 article/li/div（3階層まで）の time[datetime]。
 * 5. 正規化 URL で重複除去（先勝ち）。返り値は文書順（一覧の上ほど新しいとみなす）。
 * pattern / excludePattern が無効な正規表現の場合は throw する。
 */
export function extractListingItems(
  doc: Document,
  opts: { baseUrl: string; pattern: string; excludePattern?: string },
): ListingItem[] {
  const regex = new RegExp(opts.pattern);
  const excludeRegex = opts.excludePattern !== undefined ? new RegExp(opts.excludePattern) : null;
  const listing = listingLocation(opts.baseUrl);

  // 規則0: 構造化データ優先
  const ldRawItems = extractLdItems(doc);
  if (ldRawItems.length > 0) {
    const ldItems = buildLdListingItems(ldRawItems, { baseUrl: opts.baseUrl, regex, listing, excludeRegex });
    if (ldItems.length > 0) return ldItems;
  }

  const anchors = Array.from(doc.querySelectorAll("a[href]"));

  const items: ListingItem[] = [];
  const seenUrls = new Set<string>();

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href || isIgnorableHref(href)) continue;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, opts.baseUrl).href;
    } catch {
      continue;
    }

    const normalized = normalizeUrl(absoluteUrl);
    if (!regex.test(normalized)) continue;
    if (isExcludedByUrl(normalized, listing, excludeRegex)) continue;
    if (isExcludedByAnchor(anchor)) continue;

    const heading = anchor.querySelector(HEADING_SELECTOR);
    const anchorText = normalizeWhitespace(anchor.textContent ?? "");
    const looksLikeArticle =
      heading !== null || (anchorText.length >= MIN_ANCHOR_TEXT_LENGTH && anchorText.includes(" "));
    if (!looksLikeArticle) continue;

    const title = resolveTitle(anchor, heading);
    if (!title) continue;
    if (isExcludedByWordCategory(normalized, title)) continue;

    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    items.push({
      url: normalized,
      title,
      publishedAt: parseDateFromAnchor(anchor),
    });
  }

  return items;
}
