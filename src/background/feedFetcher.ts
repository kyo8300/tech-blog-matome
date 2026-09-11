// フィードXMLの取得と、設定ページ用のフィード接続テスト。

import { parseFeed, NotXmlError, type FeedFormat } from "../lib/feedParser";
import type { FeedTestResult } from "../shared/types";

/** ブラウザ風の Accept ヘッダ（フィードによっては UA/Accept で挙動が変わるため） */
const FEED_ACCEPT_HEADER =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8";

export interface FetchFeedResult {
  status: number;
  notModified: boolean;
  text?: string;
  etag?: string;
  lastModified?: string;
  contentType?: string;
}

/**
 * フィードURLを取得する。ETag / Last-Modified による条件付きリクエストに対応する。
 * 304（未更新）は notModified:true を返す。それ以外の非2xxは throw する。
 */
export async function fetchFeed(
  url: string,
  cache: { etag?: string; lastModified?: string },
  timeoutMs: number,
): Promise<FetchFeedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: FEED_ACCEPT_HEADER };
    if (cache.etag) headers["If-None-Match"] = cache.etag;
    if (cache.lastModified) headers["If-Modified-Since"] = cache.lastModified;

    const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });

    if (res.status === 304) {
      return { status: 304, notModified: true };
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    return {
      status: res.status,
      notModified: false,
      text,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

const FEED_TEST_TIMEOUT_MS = 20_000;

/** フォーマット表示用（NotXmlError は "not-xml" とする） */
function formatOf(format: FeedFormat | "not-xml"): FeedFormat | "not-xml" {
  return format;
}

/** 設定ページの「フィード接続テスト」用。フィードを取得・解析して概要を返す */
export async function testFeed(url: string): Promise<FeedTestResult> {
  let status: number | undefined;
  try {
    const result = await fetchFeed(url, {}, FEED_TEST_TIMEOUT_MS);
    status = result.status;
    if (result.notModified || result.text === undefined) {
      return { ok: false, status, error: "フィードを取得できませんでした" };
    }

    const { format, items } = parseFeed(result.text);
    const newest = items[0];
    return {
      ok: true,
      status,
      format: formatOf(format),
      itemCount: items.length,
      newestTitle: newest?.title,
      newestDate: newest?.publishedAt?.toISOString(),
      hasFullContent: newest?.hasFullContent ?? false,
    };
  } catch (err) {
    if (err instanceof NotXmlError) {
      return { ok: false, status, format: "not-xml", error: err.message };
    }
    return { ok: false, status, error: err instanceof Error ? err.message : String(err) };
  }
}
