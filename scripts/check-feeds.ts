// 15本のフィード（既定では feedUrl のみ、--all-alternates で altFeedUrls も含む）に実際に fetch して
// 表で結果を出す検証スクリプト。`npx tsx scripts/check-feeds.ts` で実行する。
//
// 注意: Claude Code on the web のサンドボックスは対象15ブログのドメインに egress policy で到達できない
// （403 または接続不可）。その場合は全件エラーになり exit 1 になるのが正常な結果。実際のフィード疎通確認は
// ユーザーのローカル環境で行うこと（CLAUDE.md「環境の制約」参照）。

import { JSDOM } from "jsdom";
import { DEFAULT_SOURCES } from "../src/shared/sources";
import { parseFeed, NotXmlError, type FeedItem } from "../src/lib/feedParser";
import { extractListingItems } from "../src/lib/listingExtract";
import { extractPublishedAt } from "../src/lib/pageDate";
import { FEED_FETCH_TIMEOUT_MS } from "../src/shared/constants";
import { mapLimit } from "../src/lib/concurrency";
import type { Source } from "../src/shared/types";

const ALL_ALTERNATES = process.argv.includes("--all-alternates");
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
    return `記事ページの日付: ${new Date(publishedAt).toISOString().slice(0, 10)}`;
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

async function main(): Promise<void> {
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
