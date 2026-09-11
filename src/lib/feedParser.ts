// RSS2.0 / Atom / RSS1.0(RDF) フィードのパース。fast-xml-parser のみに依存する純粋TS。

import { XMLParser } from "fast-xml-parser";

/** XMLとして解釈できなかった場合に投げるエラー */
export class NotXmlError extends Error {
  constructor(message = "XMLとして解釈できませんでした") {
    super(message);
    this.name = "NotXmlError";
  }
}

/** フィード1件分の記事情報 */
export interface FeedItem {
  title: string;
  link: string;
  guid?: string;
  publishedAt?: Date;
  categories: string[];
  /** content:encoded | content | description | summary をそのままの（HTMLの可能性がある）テキストで保持 */
  contentHtml?: string;
  hasFullContent: boolean;
}

export type FeedFormat = "rss2" | "atom" | "rdf";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry", "link", "category"].includes(name),
  processEntities: true,
  trimValues: true,
});

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 値を配列に統一する（未定義は空配列） */
function arrayify<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** `{ "#text": ... }` 形式・プレーン文字列のどちらからもテキストを取り出す */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    const t = (value as Record<string, unknown>)["#text"];
    return t === undefined || t === null ? undefined : String(t);
  }
  return undefined;
}

function parseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toContentHtml(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const t = textOf(c);
    if (t !== undefined) return t;
  }
  return undefined;
}

function makeItem(
  title: string | undefined,
  link: string | undefined,
  guid: string | undefined,
  publishedAt: Date | undefined,
  categories: string[],
  contentHtml: string | undefined,
): FeedItem | null {
  if (!link) return null;
  return {
    title: title ?? "",
    link,
    guid,
    publishedAt,
    categories,
    contentHtml,
    hasFullContent: (contentHtml?.length ?? 0) > 2000,
  };
}

// ---- RSS 2.0 ----

function toRss2Item(raw: Record<string, unknown>): FeedItem | null {
  // "link" は isArray 設定により配列化されるため先頭要素を取り出す
  const link = textOf(arrayify(raw.link)[0]);
  const title = textOf(raw.title);
  const guid = textOf(raw.guid);
  const dateStr = textOf(raw.pubDate) ?? textOf(raw["dc:date"]);
  const categories = arrayify(raw.category)
    .map((c) => textOf(c))
    .filter((c): c is string => c !== undefined && c.length > 0);
  const contentHtml = toContentHtml(raw["content:encoded"], raw.description);
  return makeItem(title, link, guid, parseDate(dateStr), categories, contentHtml);
}

function parseRss2(channel: Record<string, unknown> | undefined): {
  format: FeedFormat;
  title?: string;
  items: FeedItem[];
} {
  const title = textOf(channel?.title);
  const items = arrayify(channel?.item)
    .map((raw) => toRss2Item(raw as Record<string, unknown>))
    .filter((item): item is FeedItem => item !== null);
  return { format: "rss2", title, items };
}

// ---- Atom ----

interface AtomLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_type"?: string;
}

function pickAtomLink(raw: Record<string, unknown>): string | undefined {
  const links = arrayify(raw.link).filter(
    (l): l is AtomLink => typeof l === "object" && l !== null,
  );
  const preferred = links.find((l) => l["@_rel"] === "alternate" && l["@_type"] === "text/html");
  const chosen = preferred ?? links[0];
  return chosen?.["@_href"];
}

function atomCategories(raw: Record<string, unknown>): string[] {
  return arrayify(raw.category)
    .map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>)["@_term"] : undefined))
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

function toAtomItem(raw: Record<string, unknown>): FeedItem | null {
  const link = pickAtomLink(raw);
  // title は { "#text": ..., "@_type": "html" } のような typed 形式もプレーン文字列もあり得るため textOf で unwrap
  const title = textOf(raw.title);
  const guid = textOf(raw.id);
  const dateStr = textOf(raw.published) ?? textOf(raw.updated);
  const categories = atomCategories(raw);
  const contentHtml = toContentHtml(raw.content, raw.summary);
  return makeItem(title, link, guid, parseDate(dateStr), categories, contentHtml);
}

function parseAtom(feed: Record<string, unknown>): { format: FeedFormat; title?: string; items: FeedItem[] } {
  const title = textOf(feed.title);
  const items = arrayify(feed.entry)
    .map((raw) => toAtomItem(raw as Record<string, unknown>))
    .filter((item): item is FeedItem => item !== null);
  return { format: "atom", title, items };
}

// ---- RSS 1.0 (RDF) ----

function toRdfItem(raw: Record<string, unknown>): FeedItem | null {
  const link = textOf(arrayify(raw.link)[0]);
  const title = textOf(raw.title);
  const dateStr = textOf(raw["dc:date"]);
  const categories = arrayify(raw.category)
    .map((c) => textOf(c))
    .filter((c): c is string => c !== undefined && c.length > 0);
  const contentHtml = toContentHtml(raw["content:encoded"], raw.description);
  return makeItem(title, link, undefined, parseDate(dateStr), categories, contentHtml);
}

function parseRdf(root: Record<string, unknown>): { format: FeedFormat; title?: string; items: FeedItem[] } {
  const channel = root.channel as Record<string, unknown> | undefined;
  const title = textOf(channel?.title);
  const items = arrayify(root.item)
    .map((raw) => toRdfItem(raw as Record<string, unknown>))
    .filter((item): item is FeedItem => item !== null);
  return { format: "rdf", title, items };
}

// ---- エントリポイント ----

/** フィードXML文字列をパースする。XMLとして解釈できない場合は NotXmlError を投げる */
export function parseFeed(xml: string): { format: FeedFormat; title?: string; items: FeedItem[] } {
  const cleaned = stripBom(xml);

  if (/^\s*<!DOCTYPE\s+html/i.test(cleaned)) {
    throw new NotXmlError();
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new NotXmlError();
  }

  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss?.channel) {
    return parseRss2(rss.channel as Record<string, unknown>);
  }
  if (doc.feed) {
    return parseAtom(doc.feed as Record<string, unknown>);
  }
  if (doc["rdf:RDF"]) {
    return parseRdf(doc["rdf:RDF"] as Record<string, unknown>);
  }

  throw new NotXmlError();
}

/**
 * カテゴリでフィルタする。filter が未指定（undefined）なら全件採用。
 * item.categories が空の記事はカテゴリ情報が無いとみなし常に採用する。
 * それ以外は大文字小文字を無視して filter のいずれかと一致するカテゴリを持つ記事だけ採用する
 * （filter が空配列の場合、カテゴリを持つ記事は一致しようがないため全て除外される）。
 */
export function filterByCategory(items: FeedItem[], filter?: string[]): FeedItem[] {
  if (filter === undefined) return items;
  const lowerFilter = filter.map((f) => f.toLowerCase());
  return items.filter((item) => {
    if (item.categories.length === 0) return true;
    return item.categories.some((c) => lowerFilter.includes(c.toLowerCase()));
  });
}
