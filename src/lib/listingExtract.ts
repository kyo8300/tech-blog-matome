// §9.5: HTML 一覧ページから記事リンクを抽出する。フィードを提供しないソース（Uber / LinkedIn）向け。
// 引数で受け取った Document のみを操作し、グローバルの document/window には触れない
// （offscreen では DOMParser が、scripts / tests では jsdom が Document を渡す）。

import type { ListingItem } from "../shared/types";
import { normalizeUrl } from "./urlNormalize";
import { findDateTexts } from "./dateText";
import { cleanTextContent } from "./domText";

/** アンカー内の見出しとみなすタグ名 */
const HEADING_SELECTOR = "h1, h2, h3, h4";

/** ナビゲーション等とみなす祖先セレクタ（規則1'） */
const NAV_ANCESTOR_SELECTOR = "nav, header, footer, [role=navigation], [role=menu]";

/** 記事リンクらしさ判定のしきい値（アンカーテキストの文字数） */
const MIN_ANCHOR_TEXT_LENGTH = 20;

/** 祖先を遡って time[datetime] を探す最大階層 */
const MAX_ANCESTOR_DEPTH = 3;

/** 規則4: time[datetime] が無いときにテキスト日付を探して遡る最大階層 */
const MAX_TEXT_DATE_ANCESTOR_DEPTH = 6;

/**
 * 規則4のテキスト日付探索で評価する祖先の掃除済みテキスト（cleanTextContent の結果）の
 * 最大文字数。これを超える祖先は「一覧全体」を含んでいるとみなし、評価せずに探索を打ち切る
 * （一覧ページ全体を毎回 findDateTexts に通すと、リンク数×祖先の重複走査で著しく遅くなるため）。
 */
const MAX_TEXT_DATE_ANCESTOR_TEXT_LENGTH = 20_000;

/**
 * 規則4のテキスト日付探索で祖先要素ごとに使うメモ化キャッシュ。
 * 一覧ページでは多数のアンカーが同じ祖先（カードのコンテナ等）を共有するため、
 * extractListingItems の呼び出し単位でキャッシュを使い回し、同じ祖先を何度も走査しない。
 * cleanText: cleanTextContent(祖先) の結果（巨大祖先ガードの判定にも使う）。
 * dates: findDateTexts(normalizeWhitespace(cleanText)) の結果。
 */
interface AncestorTextCache {
  cleanText: WeakMap<Element, string>;
  dates: WeakMap<Element, number[]>;
}

function createAncestorTextCache(): AncestorTextCache {
  return { cleanText: new WeakMap(), dates: new WeakMap() };
}

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

/**
 * 規則4': href を絶対化し、フラグメント（#以降）だけを取り除いた「元の URL」を返す。
 * 末尾スラッシュやクエリはそのまま保持する（normalizeUrl はパターン判定・重複除去のキーにのみ使い、
 * 返り値の url には使わない。Uber は末尾スラッシュ無しの URL に 404 を返すため）。
 * パースできない場合は null。
 */
function toOriginalUrl(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
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

/**
 * cache から祖先の cleanTextContent 結果を取得する。未計算ならその場で計算してキャッシュする。
 * ancestor.textContent をそのまま使うと、空白の無い SSR 出力（`<h1>Title</h1><p>Sep 2, 2026</p>`）で
 * 要素をまたいだテキストが `TitleSep 2, 2026` のように連結され、月名形式の日付が単語境界を失って
 * 取りこぼされる。§10 と同じ `cleanTextContent`（script/style/noscript/template を除き、
 * 要素境界に空白を1つ挟んで連結）を使うことでこれを避ける。巨大祖先ガード（MAX_TEXT_DATE_ANCESTOR_TEXT_LENGTH）
 * の判定にも同じ結果を使うため、findDateTextsForAncestor とは別にメモ化する。
 */
function cleanTextForAncestor(ancestor: Element, cache: AncestorTextCache): string {
  const cached = cache.cleanText.get(ancestor);
  if (cached !== undefined) return cached;
  const text = cleanTextContent(ancestor);
  cache.cleanText.set(ancestor, text);
  return text;
}

/** cache から祖先の findDateTexts 結果を取得する。未計算ならその場で計算してキャッシュする */
function findDateTextsForAncestor(ancestor: Element, cache: AncestorTextCache): number[] {
  const cached = cache.dates.get(ancestor);
  if (cached) return cached;
  const found = findDateTexts(normalizeWhitespace(cleanTextForAncestor(ancestor, cache)));
  cache.dates.set(ancestor, found);
  return found;
}

/**
 * 規則4のテキスト日付フォールバック: アンカーから祖先を最大6階層上り、各祖先の
 * 掃除済みテキスト（cleanTextContent の結果。空白正規化後）に findDateTexts がちょうど1件
 * 返す最初の祖先の値を採用する（複数件含む祖先は一覧全体を含んでいる可能性が高いため採用しない。
 * LinkedIn の一覧はこの形）。祖先ごとの cleanTextContent / findDateTexts の結果は cache
 * （WeakMap）でメモ化し（同じ祖先を複数のアンカーが共有するため）、祖先の掃除済みテキストが
 * MAX_TEXT_DATE_ANCESTOR_TEXT_LENGTH 字を超える場合は「一覧全体」とみなして評価せず探索を打ち切る。
 * （生の textContent 長で判定すると、カード自体は小さくても中に巨大なインライン script が
 * 埋め込まれているだけで日付が評価されなくなってしまうため、script 等を除いた掃除済みテキストの
 * 長さで判定する）。
 */
function findDateFromAncestorText(anchor: Element, cache: AncestorTextCache): number | undefined {
  let ancestor: Element | null = anchor.parentElement;
  for (let depth = 0; depth < MAX_TEXT_DATE_ANCESTOR_DEPTH && ancestor; depth++) {
    if (cleanTextForAncestor(ancestor, cache).length > MAX_TEXT_DATE_ANCESTOR_TEXT_LENGTH) break;
    const found = findDateTextsForAncestor(ancestor, cache);
    if (found.length === 1) return found[0];
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

/**
 * 日時（ms epoch）を取り出す。time[datetime] があればそれを優先し、無ければ
 * 規則4のテキスト日付フォールバックを試す。どちらも取れなければ undefined。
 */
function parseDateFromAnchor(anchor: Element, cache: AncestorTextCache): number | undefined {
  const timeEl = findDateElement(anchor);
  const datetime = timeEl?.getAttribute("datetime");
  if (datetime) {
    const parsed = Date.parse(datetime);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return findDateFromAncestorText(anchor, cache);
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
    const originalUrl = toOriginalUrl(raw.url, opts.baseUrl);
    if (originalUrl === null) continue;
    // パターン判定・除外・重複除去は正規化 URL をキーにする（規則4'）。返す url は元の URL のまま。
    const normalized = normalizeUrl(originalUrl);
    if (!opts.regex.test(normalized)) continue;
    if (isExcludedByUrl(normalized, opts.listing, opts.excludeRegex)) continue;
    if (!raw.title) continue;
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    items.push({ url: originalUrl, title: raw.title, publishedAt: raw.publishedAt });
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
 *   無ければテキスト日付を探す: アンカーから祖先を6階層まで順に上り、各祖先の textContent に
 *   findDateTexts（src/lib/dateText.ts）がちょうど1件返す最初の祖先の値を採用する
 *   （複数件含む祖先は一覧全体なので採用しない）。それでも無ければ undefined。
 * 4'. url: 返す url はフラグメントだけを除去した絶対化済みの元の URL（末尾スラッシュ・クエリは保持）。
 *   normalizeUrl はパターン判定（規則1）・除外判定（規則1'）・規則5の重複除去のキーにのみ使う。
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
  // 規則4のテキスト日付探索用キャッシュ。この呼び出し内の全アンカーで共有し、
  // 同じ祖先要素への cleanTextContent / findDateTexts の再計算を避ける。
  const textDateCache: AncestorTextCache = createAncestorTextCache();

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href || isIgnorableHref(href)) continue;

    const originalUrl = toOriginalUrl(href, opts.baseUrl);
    if (originalUrl === null) continue;

    // パターン判定・除外・重複除去は正規化 URL をキーにする（規則4'）。返す url は元の URL のまま
    // （Uber は末尾スラッシュ無しの URL に 404 を返すため、正規化 URL で取得してはいけない）。
    const normalized = normalizeUrl(originalUrl);
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
      url: originalUrl,
      title,
      publishedAt: parseDateFromAnchor(anchor, textDateCache),
    });
  }

  return items;
}
