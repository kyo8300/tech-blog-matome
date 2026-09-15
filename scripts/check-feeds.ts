// 15本のフィード（既定では feedUrl のみ、--all-alternates で altFeedUrls も含む）に実際に fetch して
// 表で結果を出す検証スクリプト。`npx tsx scripts/check-feeds.ts` で実行する。
//
// 注意: Claude Code on the web のサンドボックスは対象15ブログのドメインに egress policy で到達できない
// （403 または接続不可）。その場合は全件エラーになり exit 1 になるのが正常な結果。実際のフィード疎通確認は
// ユーザーのローカル環境で行うこと（CLAUDE.md「環境の制約」参照）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { DEFAULT_SOURCES } from "../src/shared/sources";
import { parseFeed, NotXmlError, type FeedItem } from "../src/lib/feedParser";
import { extractListingItems } from "../src/lib/listingExtract";
import { extractPublishedAt, unescapeEmbeddedQuotes } from "../src/lib/pageDate";
import { findDateTexts } from "../src/lib/dateText";
import { normalizeUrl } from "../src/lib/urlNormalize";
import { FEED_FETCH_TIMEOUT_MS } from "../src/shared/constants";
import { mapLimit } from "../src/lib/concurrency";
import type { ListingItem, Source } from "../src/shared/types";

const ALL_ALTERNATES = process.argv.includes("--all-alternates");
const DEBUG_DATES = process.argv.includes("--debug-dates");
const FIXTURE_MODE = process.argv.includes("--fixture");
const CONCURRENCY = 4;

// フィード配信元にブラウザとして認識してもらうための UA（一部のブログは非ブラウザUAを弾く）
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

interface CheckTarget {
  sourceName: string;
  url: string;
  isPrimary: boolean;
}

interface CheckResult {
  sourceName: string;
  url: string;
  isPrimary: boolean;
  status: string;
  contentType: string;
  format: string;
  itemCount: string;
  newest: string;
  hasFullContent: string;
  /** §14: 一覧行のみ。先頭1件の記事ページから公開日が取れるかどうか（offscreen と同じ抽出順） */
  pageDate: string;
  error: string;
  /** exit code 判定に使う。primary URL が成功したかどうか */
  ok: boolean;
}

function buildTargets(): CheckTarget[] {
  const targets: CheckTarget[] = [];
  for (const source of DEFAULT_SOURCES) {
    targets.push({ sourceName: source.name, url: source.feedUrl, isPrimary: true });
    if (ALL_ALTERNATES) {
      for (const alt of source.altFeedUrls) {
        targets.push({ sourceName: source.name, url: alt, isPrimary: false });
      }
    }
  }
  return targets;
}

function formatDate(d: Date | undefined): string {
  if (!d) return "(日付不明)";
  return d.toISOString().slice(0, 10);
}

function pickNewest(items: FeedItem[]): FeedItem | undefined {
  if (items.length === 0) return undefined;
  return items.reduce((newest, item) => {
    if (!item.publishedAt) return newest;
    if (!newest.publishedAt) return item;
    return item.publishedAt > newest.publishedAt ? item : newest;
  }, items[0]!);
}

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "(不明)",
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(target: CheckTarget): Promise<CheckResult> {
  const base = { sourceName: target.sourceName, url: target.url, isPrimary: target.isPrimary };
  try {
    const { status, contentType, text } = await fetchText(target.url, FEED_FETCH_TIMEOUT_MS);
    if (status !== 200) {
      return {
        ...base,
        status: String(status),
        contentType,
        format: "-",
        itemCount: "-",
        newest: "-",
        hasFullContent: "-",
        pageDate: "-",
        error: `HTTP ${status}`,
        ok: false,
      };
    }
    try {
      const parsed = parseFeed(text);
      const newestItem = pickNewest(parsed.items);
      return {
        ...base,
        status: String(status),
        contentType,
        format: parsed.format,
        itemCount: String(parsed.items.length),
        newest: newestItem ? `${newestItem.title} (${formatDate(newestItem.publishedAt)})` : "(記事なし)",
        hasFullContent: newestItem?.hasFullContent ? "yes" : "no",
        pageDate: "-",
        error: "",
        ok: true,
      };
    } catch (e) {
      const message = e instanceof NotXmlError ? e.message : String(e instanceof Error ? e.message : e);
      return {
        ...base,
        status: String(status),
        contentType,
        format: "not-xml",
        itemCount: "-",
        newest: "-",
        hasFullContent: "-",
        pageDate: "-",
        error: message,
        ok: false,
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const reason = (e as { name?: string } | undefined)?.name === "AbortError" ? "タイムアウト" : message;
    return {
      ...base,
      status: "ERR",
      contentType: "-",
      format: "-",
      itemCount: "-",
      newest: "-",
      hasFullContent: "-",
      pageDate: "-",
      error: reason,
      ok: false,
    };
  }
}

/**
 * §14: 記事ページを1件取得し、offscreen（src/lib/pageDate.ts）と同じ抽出順で公開日が取れるかを確認する。
 * 取得や抽出に失敗した場合も例外にせず「取れず」を返す（あくまで診断用の付加情報のため）。
 */
async function checkArticlePageDate(url: string): Promise<string> {
  try {
    const { status, text } = await fetchText(url, FEED_FETCH_TIMEOUT_MS);
    if (status !== 200) return "取れず";
    const dom = new JSDOM(text, { url });
    const publishedAt = extractPublishedAt(dom.window.document);
    if (publishedAt === undefined) return "取れず";
    // 表の列見出しが既に「記事ページの日付」なので、セル値には日付文字列だけを入れる
    // （見出しの重複を避ける）。
    return new Date(publishedAt).toISOString().slice(0, 10);
  } catch {
    return "取れず";
  }
}

/**
 * §9.5: 主URLが失敗し listingUrl を持つソース向けの一覧ページフォールバック確認。
 * 一覧ページを取得し jsdom で extractListingItems を実行する。1件以上取れれば ok:true。
 */
async function checkListing(source: Source): Promise<CheckResult> {
  const base = { sourceName: source.name, url: source.listingUrl!, isPrimary: false as const };
  try {
    const { status, contentType, text } = await fetchText(source.listingUrl!, FEED_FETCH_TIMEOUT_MS);
    if (status !== 200) {
      return {
        ...base,
        status: String(status),
        contentType,
        format: "listing",
        itemCount: "-",
        newest: "-",
        hasFullContent: "-",
        pageDate: "-",
        error: `HTTP ${status}`,
        ok: false,
      };
    }

    const dom = new JSDOM(text, { url: source.listingUrl });
    const items = extractListingItems(dom.window.document, {
      baseUrl: source.listingUrl!,
      pattern: source.listingLinkPattern!,
      excludePattern: source.listingExcludePattern,
    });

    if (items.length === 0) {
      return {
        ...base,
        status: String(status),
        contentType,
        format: "listing",
        itemCount: "0",
        newest: "-",
        hasFullContent: "-",
        pageDate: "-",
        error: "一覧ページから記事リンクを抽出できませんでした",
        ok: false,
      };
    }

    // §14: 件数欄に一覧から公開日が取れた件数も添える
    const withDate = items.filter((i) => i.publishedAt !== undefined).length;
    const newest = items[0]!;
    // §14: 先頭1件の記事ページを取得し、offscreen と同じ抽出順で公開日が取れるか確認する
    const pageDate = await checkArticlePageDate(newest.url);

    return {
      ...base,
      status: String(status),
      contentType,
      format: "listing",
      itemCount: `${items.length}件（日付あり ${withDate}）`,
      newest: newest.title,
      hasFullContent: "-",
      pageDate,
      error: "",
      ok: true,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      status: "ERR",
      contentType: "-",
      format: "listing",
      itemCount: "-",
      newest: "-",
      hasFullContent: "-",
      pageDate: "-",
      error: message,
      ok: false,
    };
  }
}

/** セル1個分の最大幅。これを超える値は末尾を省略する（URL列は対象外。§下記 formatCell 参照） */
const MAX_CELL_WIDTH = 60;

/**
 * 表のセル値を1レコード1行に保つための正規化。
 * 改行・タブは空白に潰し、連続する空白は1個にまとめる。
 * `truncate` が true（既定）のときのみ、MAX_CELL_WIDTH を超える値の末尾を「…」で省略する。
 * URL列は完全な値を確認できる必要があるため `truncate: false` で呼び出し、省略しない。
 */
function formatCell(value: string, truncate = true): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (!truncate || normalized.length <= MAX_CELL_WIDTH) return normalized;
  return `${normalized.slice(0, MAX_CELL_WIDTH - 1)}…`;
}

function printTable(results: CheckResult[]): void {
  const columns: { key: keyof CheckResult; label: string; truncate: boolean }[] = [
    { key: "sourceName", label: "name", truncate: true },
    { key: "url", label: "URL", truncate: false },
    { key: "status", label: "status", truncate: true },
    { key: "contentType", label: "content-type", truncate: true },
    { key: "format", label: "形式", truncate: true },
    { key: "itemCount", label: "件数", truncate: true },
    { key: "newest", label: "最新タイトル+日付", truncate: true },
    { key: "hasFullContent", label: "本文全文あり", truncate: true },
    { key: "pageDate", label: "記事ページの日付", truncate: true },
    { key: "error", label: "エラー", truncate: true },
  ];
  const rows = results.map((r) => columns.map((c) => formatCell(String(r[c.key]), c.truncate)));
  const widths = columns.map((col, i) =>
    Math.max(col.label.length, ...rows.map((row) => row[i]!.length)),
  );
  const sep = "-+-";
  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ");

  console.log(formatRow(columns.map((c) => c.label)));
  console.log(widths.map((w) => "-".repeat(w)).join(sep));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

// ---------------------------------------------------------------------------
// §14 診断用: --debug-dates
// Uber / LinkedIn のように一覧ページ/記事ページから公開日が取れないソースについて、
// 実ページのどこに日付情報があるかをユーザーの手元で洗い出すための追加診断。
// `--debug-dates` を付けたときだけ実行され、通常の main() のフロー・出力は一切変更しない。
// ---------------------------------------------------------------------------

/** 診断1項目あたりの最大表示件数 */
const DEBUG_MAX_ITEMS = 10;
/** 診断1件あたりの最大表示文字数（省略時は末尾に … を付ける） */
const DEBUG_MAX_CHARS = 200;

function debugTruncate(value: string, max = DEBUG_MAX_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function printDebugHeading(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function printDebugList(items: string[]): void {
  if (items.length === 0) {
    console.log("  (該当なし)");
    return;
  }
  for (const item of items.slice(0, DEBUG_MAX_ITEMS)) {
    console.log(`  - ${debugTruncate(item)}`);
  }
}

/** 1. <time ...> タグ全文（属性込み） */
function debugTimeTags(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("time")).map((el) => el.outerHTML);
}

/** 2. name/property/itemprop に date/time/publish/modified を含む <meta ...> 全文 */
function debugMetaTags(doc: Document): string[] {
  const keywordRe = /date|time|publish|modified/i;
  return Array.from(doc.querySelectorAll("meta"))
    .filter((el) => {
      const key = el.getAttribute("name") ?? el.getAttribute("property") ?? el.getAttribute("itemprop") ?? "";
      return keywordRe.test(key);
    })
    .map((el) => el.outerHTML);
}

/** ld+json（配列・@graph 配列含む）をフラットなノード列にする（診断用の簡易版） */
function debugFlattenJsonNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const v of value) debugFlattenJsonNodes(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    out.push(obj);
    if (Array.isArray(obj["@graph"])) debugFlattenJsonNodes(obj["@graph"], out);
  }
  return out;
}

/** 3. script[type="application/ld+json"] ごとの @type / datePublished / dateModified / uploadDate */
function debugLdJson(doc: Document): string[] {
  const out: string[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent ?? "";
    if (!raw.trim()) continue;
    try {
      const nodes = debugFlattenJsonNodes(JSON.parse(raw));
      if (nodes.length === 0) {
        out.push(`(型情報なし) ${raw}`);
        continue;
      }
      for (const node of nodes) {
        const rawType = node["@type"];
        const type = Array.isArray(rawType) ? rawType.join(",") : typeof rawType === "string" ? rawType : "(なし)";
        const field = (key: string): string => {
          const v = node[key];
          return typeof v === "string" && v ? v : "-";
        };
        out.push(
          `@type=${type} datePublished=${field("datePublished")} dateModified=${field("dateModified")} uploadDate=${field("uploadDate")}`,
        );
      }
    } catch {
      out.push(`(JSONパース失敗) ${raw}`);
    }
  }
  return out;
}

/**
 * key: value（date/publish/created/updated 系）を最大 DEBUG_MAX_ITEMS 件抜き出す正規表現。
 * 値は `"..."`（8〜40字ではなく診断用に4〜40字と緩め）の文字列、または10〜13桁の数値 epoch。
 */
const DEBUG_BIG_JSON_KEY_RE =
  /"((?:published|publish|date|created|updated)[A-Za-z_]*)"\s*:\s*("[^"]{4,40}"|\d{10,13})/gi;

/**
 * 4. __NEXT_DATA__ / __INITIAL_STATE__ / `self.__next_f.push(...)` 等、大きな JSON を
 * 含みうる script 内の日付らしき key: value。
 * pageDate.ts の埋め込みJSON抽出（findEmbeddedJsonPublishedAt）と同じ範囲、
 * すなわち「ld+json 以外の全 script（type 不問）」を走査対象にする（キーワード絞り込みはしない）。
 */
function debugBigJson(doc: Document): string[] {
  const texts = Array.from(doc.querySelectorAll("script"))
    .filter((el) => el.getAttribute("type") !== "application/ld+json")
    .map((el) => el.textContent ?? "");

  // 探索前に \u0022 / \" を " に戻す（pageDate.ts の埋め込みJSON抽出と同じデコード）
  const combined = unescapeEmbeddedQuotes(texts.join("\n"));
  const out: string[] = [];
  DEBUG_BIG_JSON_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < DEBUG_MAX_ITEMS && (m = DEBUG_BIG_JSON_KEY_RE.exec(combined))) {
    out.push(`${m[1]}: ${m[2]}`);
  }
  return out;
}

const DEBUG_MONTH_NAME = "January|February|March|April|May|June|July|August|September|October|November|December";
const DEBUG_MONTH_ABBR = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DEBUG_BODY_DATE_PATTERNS = [
  new RegExp(`\\b(?:${DEBUG_MONTH_NAME})\\s+\\d{1,2},\\s+\\d{4}\\b`, "g"),
  new RegExp(`\\b\\d{1,2}\\s+(?:${DEBUG_MONTH_ABBR})[a-z]*\\s+\\d{4}\\b`, "g"),
  new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b`, "g"),
  new RegExp(`\\b(?:${DEBUG_MONTH_ABBR})[a-z]*\\s+\\d{1,2},\\s+\\d{4}\\b`, "g"),
];

/** script/style を除去した本文テキスト（textContent） */
function debugBodyText(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  const clone = body.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll("script, style"))) el.remove();
  return clone.textContent ?? "";
}

/** 5補足: 本文テキストに findDateTexts（src/lib/dateText.ts）を通した結果を ISO 日付文字列で返す */
function debugFindDateTexts(doc: Document): string[] {
  const text = debugBodyText(doc);
  return findDateTexts(text).map((epochMs) => new Date(epochMs).toISOString().slice(0, 10));
}

/** 5. 本文テキストから日付らしき文字列を前後30文字の文脈付きで抜き出す */
function debugBodyDates(doc: Document): string[] {
  const text = debugBodyText(doc);
  const matches: { index: number; text: string }[] = [];
  for (const re of DEBUG_BODY_DATE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      matches.push({ index: m.index, text: m[0] });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  const seenIndex = new Set<number>();
  for (const m of matches) {
    if (seenIndex.has(m.index)) continue;
    seenIndex.add(m.index);
    const start = Math.max(0, m.index - 30);
    const end = Math.min(text.length, m.index + m.text.length + 30);
    out.push(text.slice(start, end));
    if (out.length >= DEBUG_MAX_ITEMS) break;
  }
  return out;
}

/** アンカー自身、または最も近い祖先 article/li/div（3階層まで）の textContent を返す（見つからなければ空文字） */
function debugNearestAncestorText(anchor: Element): string {
  let ancestor: Element | null = anchor.parentElement;
  for (let depth = 0; depth < 3 && ancestor; depth++) {
    const tag = ancestor.tagName.toLowerCase();
    if (tag === "article" || tag === "li" || tag === "div") {
      return ancestor.textContent ?? "";
    }
    ancestor = ancestor.parentElement;
  }
  return "";
}

/**
 * targetUrl に一致する href を持つ最初のアンカー要素を探す。
 * extractListingItems が返す ListingItem.url は規則4'（元 URL。末尾スラッシュ等は正規化されていない）
 * なので、両辺を normalizeUrl してから比較する。
 */
function debugFindAnchorForUrl(doc: Document, baseUrl: string, targetUrl: string): Element | null {
  const normalizedTarget = normalizeUrl(targetUrl);
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    try {
      const absolute = new URL(href, baseUrl).href;
      if (normalizeUrl(absolute) === normalizedTarget) return anchor;
    } catch {
      continue;
    }
  }
  return null;
}

/** 6. 一覧ページ限定: 先頭3件の記事リンクについて、アンカー outerHTML と最も近い祖先の textContent */
function printDebugListingAnchors(doc: Document, baseUrl: string, items: ListingItem[]): void {
  printDebugHeading("6. 一覧: 先頭3件のアンカーと最も近い祖先(article/li/div)");
  const top3 = items.slice(0, 3);
  if (top3.length === 0) {
    console.log("  (抽出できた記事リンクなし)");
    return;
  }
  for (const item of top3) {
    console.log(`  * ${item.url}`);
    const anchor = debugFindAnchorForUrl(doc, baseUrl, item.url);
    if (!anchor) {
      console.log("      anchor: (対応するアンカー要素が見つからず)");
      continue;
    }
    console.log(`      anchor:   ${debugTruncate(anchor.outerHTML, 300)}`);
    const ancestorText = debugNearestAncestorText(anchor);
    console.log(`      ancestor: ${ancestorText ? debugTruncate(ancestorText, 200) : "(なし)"}`);
  }
}

/** 1〜5 の共通診断（一覧ページ・記事ページどちらにも使う） */
function printDebugPageDiagnostics(doc: Document): void {
  printDebugHeading("1. <time> タグ");
  printDebugList(debugTimeTags(doc));

  printDebugHeading("2. <meta> (name/property/itemprop に date/time/publish/modified を含む)");
  printDebugList(debugMetaTags(doc));

  printDebugHeading("3. ld+json の @type / datePublished / dateModified / uploadDate");
  printDebugList(debugLdJson(doc));

  printDebugHeading("4. 大きなJSON (__NEXT_DATA__ / __INITIAL_STATE__ 等) 内の日付らしきキー");
  printDebugList(debugBigJson(doc));

  printDebugHeading("5. 本文テキスト中の日付らしき文字列（前後30文字）");
  printDebugList(debugBodyDates(doc));
  const foundDates = debugFindDateTexts(doc);
  console.log(
    `  findDateTexts の結果: ${foundDates.length > 0 ? foundDates.slice(0, DEBUG_MAX_ITEMS).join(", ") : "(該当なし)"}`,
  );
}

/** --debug-dates --fixture: ネットワークに出ず、tests/fixtures の HTML を読んで自己テストする */
async function runDebugDatesFixture(): Promise<void> {
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
  const listingUrl = "https://www.uber.com/us/en/blog/engineering/";
  const listingHtml = fs.readFileSync(path.join(fixturesDir, "listing-uber-like.html"), "utf8");
  const articleHtml = fs.readFileSync(path.join(fixturesDir, "article.html"), "utf8");

  console.log(`\n${"=".repeat(70)}`);
  console.log("# fixture: tests/fixtures/listing-uber-like.html + tests/fixtures/article.html");
  console.log("=".repeat(70));

  const listingDoc = new JSDOM(listingHtml, { url: listingUrl }).window.document;
  console.log(`\n## 一覧ページ: ${listingUrl} (fixture: listing-uber-like.html)`);
  printDebugPageDiagnostics(listingDoc);

  const uberSource = DEFAULT_SOURCES.find((s) => s.name === "Uber Engineering");
  const items = extractListingItems(listingDoc, {
    baseUrl: listingUrl,
    pattern: uberSource?.listingLinkPattern ?? "^https://www\\.uber\\.com/us/en/blog/[^/]+/?$",
    excludePattern: uberSource?.listingExcludePattern,
  });
  printDebugListingAnchors(listingDoc, listingUrl, items);

  // fixture には記事ページ自体は1本しかないので、抽出できた先頭URL（無ければダミーURL）に
  // article.html の内容を紐づけて診断する。
  const articleUrl = items[0]?.url ?? "https://example.com/blog/fixture-article";
  const articleDoc = new JSDOM(articleHtml, { url: articleUrl }).window.document;
  console.log(`\n## 記事ページ: ${articleUrl} (fixture: article.html)`);
  printDebugPageDiagnostics(articleDoc);
}

/** --debug-dates（fixture なし）: listingUrl を持つ各ソースの一覧ページ・記事ページを実際に fetch して診断する */
async function runDebugDatesLive(): Promise<void> {
  const sources = DEFAULT_SOURCES.filter((s) => s.listingUrl && s.listingLinkPattern);
  for (const source of sources) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`# ${source.name}`);
    console.log("=".repeat(70));
    try {
      const { status, text } = await fetchText(source.listingUrl!, FEED_FETCH_TIMEOUT_MS);
      if (status !== 200) {
        console.log(`一覧ページ取得失敗: HTTP ${status} (${source.listingUrl})`);
        continue;
      }
      const listingDoc = new JSDOM(text, { url: source.listingUrl }).window.document;
      console.log(`\n## 一覧ページ: ${source.listingUrl}`);
      printDebugPageDiagnostics(listingDoc);

      const items = extractListingItems(listingDoc, {
        baseUrl: source.listingUrl!,
        pattern: source.listingLinkPattern!,
        excludePattern: source.listingExcludePattern,
      });
      printDebugListingAnchors(listingDoc, source.listingUrl!, items);

      if (items.length === 0) {
        console.log("\n(一覧から記事リンクを抽出できなかったため、記事ページの診断はスキップ)");
        continue;
      }

      const articleUrl = items[0]!.url;
      const { status: articleStatus, text: articleText } = await fetchText(articleUrl, FEED_FETCH_TIMEOUT_MS);
      if (articleStatus !== 200) {
        console.log(`\n記事ページ取得失敗: HTTP ${articleStatus} (${articleUrl})`);
        continue;
      }
      const articleDoc = new JSDOM(articleText, { url: articleUrl }).window.document;
      console.log(`\n## 記事ページ: ${articleUrl}`);
      printDebugPageDiagnostics(articleDoc);
    } catch (e) {
      console.log(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  if (DEBUG_DATES) {
    if (FIXTURE_MODE) {
      await runDebugDatesFixture();
    } else {
      await runDebugDatesLive();
    }
    return;
  }

  const targets = buildTargets();
  console.log(
    `フィード疎通確認: ${DEFAULT_SOURCES.length}ソース ${targets.length}URL${
      ALL_ALTERNATES ? "（代替URLを含む）" : ""
    } / タイムアウト ${FEED_FETCH_TIMEOUT_MS / 1000}s / 並列 ${CONCURRENCY}\n`,
  );

  const settled = await mapLimit(targets, CONCURRENCY, (target) => checkOne(target));
  const results: CheckResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // checkOne 内で例外を捕捉しているため通常ここには来ないが、念のためのフォールバック
    const target = targets[i]!;
    return {
      sourceName: target.sourceName,
      url: target.url,
      isPrimary: target.isPrimary,
      status: "ERR",
      contentType: "-",
      format: "-",
      itemCount: "-",
      newest: "-",
      hasFullContent: "-",
      pageDate: "-",
      error: String(s.reason),
      ok: false,
    };
  });

  // §9.5: 主URLが失敗し listingUrl を持つソースは一覧ページも確認し、表に行を追加する。
  // 一覧ページから1件以上取れれば、そのソースは失敗に数えない。
  const primaryFailedInitially = results.filter((r) => r.isPrimary && !r.ok);
  const listingRescued = new Set<string>();
  for (const failed of primaryFailedInitially) {
    const source = DEFAULT_SOURCES.find((s) => s.name === failed.sourceName);
    if (!source?.listingUrl || !source.listingLinkPattern) continue;
    const listingResult = await checkListing(source);
    results.push(listingResult);
    if (listingResult.ok) {
      listingRescued.add(source.name);
    }
  }

  printTable(results);

  const primaryFailed = primaryFailedInitially.filter((r) => !listingRescued.has(r.sourceName));
  const primaryTotal = results.filter((r) => r.isPrimary).length;
  // 表示上の成功数には一覧ページフォールバックで救済したソースを含めない（主URL自体は失敗のため）。
  // 救済は「一覧ページフォールバックで救済:」の行と exit code 0 のみで表現する。
  const primarySucceeded = primaryTotal - primaryFailedInitially.length;
  console.log();
  console.log(`主URL: ${primarySucceeded}/${primaryTotal} 成功`);
  if (listingRescued.size > 0) {
    console.log(`一覧ページフォールバックで救済: ${[...listingRescued].join(", ")}`);
  }
  if (primaryFailed.length > 0) {
    console.log("失敗した主URL:");
    for (const r of primaryFailed) {
      console.log(`  - ${r.sourceName}: ${r.url} (${r.error})`);
    }
    console.log(
      "\n注: サンドボックス環境ではブログドメインへの到達が egress policy でブロックされ、全件失敗（exit 1）が正常です。実際の疎通確認はローカル環境の `npm run check-feeds` で行ってください。",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("予期しないエラー:", e);
  process.exitCode = 1;
});
