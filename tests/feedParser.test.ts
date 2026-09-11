import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseFeed, filterByCategory, NotXmlError } from "../src/lib/feedParser";
import type { FeedItem } from "../src/lib/feedParser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("parseFeed / RSS 2.0", () => {
  const xml = fixture("rss2.xml");
  const result = parseFeed(xml);

  it("detects rss2 format and channel title", () => {
    expect(result.format).toBe("rss2");
    expect(result.title).toBe("Example Tech Blog");
  });

  it("parses all items", () => {
    expect(result.items).toHaveLength(2);
  });

  it("extracts content:encoded (unwrapped from CDATA) as contentHtml", () => {
    const first = result.items[0];
    expect(first.title).toBe("Scaling Our Database Layer");
    expect(first.link).toBe("https://example.com/blog/scaling-database-layer");
    expect(first.contentHtml).toBeDefined();
    expect(first.contentHtml).toContain("rearchitected our database layer");
    expect(first.contentHtml).toContain("<strong>bold</strong>");
  });

  it("collects multiple <category> elements", () => {
    expect(result.items[0].categories).toEqual(["Engineering", "Databases"]);
    expect(result.items[1].categories).toEqual(["Developer Experience"]);
  });

  it("parses guid", () => {
    expect(result.items[0].guid).toBe("https://example.com/blog/scaling-database-layer");
  });

  it("parses pubDate into a Date", () => {
    const first = result.items[0];
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.publishedAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("content:encoded shorter than 2000 chars does not count as full content", () => {
    expect(result.items[0].hasFullContent).toBe(false);
  });
});

describe("parseFeed / Atom", () => {
  const xml = fixture("atom.xml");
  const result = parseFeed(xml);

  it("detects atom format and feed title", () => {
    expect(result.format).toBe("atom");
    expect(result.title).toBe("Example Atom Engineering Blog");
  });

  it("parses all entries", () => {
    expect(result.items).toHaveLength(3);
  });

  it("unwraps title with @_type=html", () => {
    expect(result.items[0].title).toContain("Rewriting Our");
    expect(result.items[0].title).toContain("Deploy");
    // Must be a plain string, not a stringified object.
    expect(result.items[0].title).not.toContain("[object");
  });

  it("prefers rel=alternate type=text/html link over rel=self", () => {
    expect(result.items[0].link).toBe("https://example.org/blog/rewriting-deploy-pipeline");
  });

  it("uses plain <title> when not typed html", () => {
    expect(result.items[1].title).toBe("Second Entry Without Typed Title");
  });

  it("falls back to the first href when no rel=alternate link exists", () => {
    expect(result.items[2].link).toBe("https://example.org/feed/third-entry.atom");
  });

  it("collects category term attributes", () => {
    expect(result.items[0].categories).toEqual(["Infrastructure", "CI/CD"]);
    expect(result.items[1].categories).toEqual(["Backend"]);
    expect(result.items[2].categories).toEqual([]);
  });

  it("parses published date", () => {
    expect(result.items[0].publishedAt).toBeInstanceOf(Date);
    expect(result.items[0].publishedAt?.toISOString()).toBe("2026-09-03T09:00:00.000Z");
  });

  it("falls back to <summary> as contentHtml when no <content> is present", () => {
    expect(result.items[1].contentHtml).toContain("second entry for parser coverage");
  });
});

describe("parseFeed / Medium (guid + source param + full content)", () => {
  const xml = fixture("medium.xml");
  const result = parseFeed(xml);

  it("parses as rss2", () => {
    expect(result.format).toBe("rss2");
  });

  it("keeps the medium.com/p/<hash> guid", () => {
    expect(result.items[0].guid).toBe("https://medium.com/p/abcdef123456");
  });

  it("keeps the raw link including the ?source=rss-... query param (normalization is a separate concern)", () => {
    expect(result.items[0].link).toContain("?source=rss-");
    expect(result.items[0].link).toContain("medium.com/example-engineering/migrating-our-traffic-layer-at-scale-abcdef123456");
  });

  it("marks hasFullContent true when content:encoded exceeds 2000 chars", () => {
    expect(result.items[0].contentHtml!.length).toBeGreaterThan(2000);
    expect(result.items[0].hasFullContent).toBe(true);
  });
});

describe("parseFeed / RSS2 without guid", () => {
  it("leaves guid undefined", () => {
    const result = parseFeed(fixture("rss2-noguid.xml"));
    expect(result.format).toBe("rss2");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].guid).toBeUndefined();
    expect(result.items[0].link).toBe("https://noguid.example.com/posts/post-without-a-guid");
  });
});

describe("parseFeed / single item (isArray coverage)", () => {
  it("still returns an array with one item", () => {
    const result = parseFeed(fixture("rss2-single.xml"));
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("The Only Post");
    expect(result.items[0].categories).toEqual(["Announcements"]);
  });
});

describe("parseFeed / RDF (RSS 1.0)", () => {
  const result = parseFeed(fixture("rdf.xml"));

  it("detects rdf format", () => {
    expect(result.format).toBe("rdf");
    expect(result.title).toBe("RDF Legacy Blog");
  });

  it("parses items with dc:date", () => {
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe("Legacy Post One");
    expect(result.items[0].link).toBe("https://rdf.example.com/posts/legacy-post-one");
    expect(result.items[0].publishedAt).toBeInstanceOf(Date);
    expect(result.items[0].publishedAt?.toISOString()).toBe("2026-07-10T10:00:00.000Z");
  });
});

describe("parseFeed / RDF (RSS 1.0) with content:encoded and category", () => {
  const result = parseFeed(fixture("rdf-full.xml"));

  it("prefers content:encoded over description as contentHtml", () => {
    const first = result.items[0];
    expect(first.contentHtml).toContain("full article body from content:encoded");
    expect(first.contentHtml).not.toContain("should be ignored");
  });

  it("collects <category> elements", () => {
    expect(result.items[0].categories).toEqual(["Legacy", "RDF"]);
  });
});

describe("parseFeed / non-XML response", () => {
  it("throws NotXmlError when given an HTML page", () => {
    expect(() => parseFeed(fixture("html-page.html"))).toThrow(NotXmlError);
  });

  it("throws NotXmlError for garbage input", () => {
    expect(() => parseFeed("this is not xml at all")).toThrow(NotXmlError);
  });

  it("throws NotXmlError for XML without a known feed root", () => {
    expect(() => parseFeed(`<?xml version="1.0"?><foo><bar/></foo>`)).toThrow(NotXmlError);
  });
});

describe("filterByCategory", () => {
  const items: FeedItem[] = [
    { title: "A", link: "https://x.example.com/a", categories: ["Engineering", "Backend"], hasFullContent: false },
    { title: "B", link: "https://x.example.com/b", categories: ["Marketing"], hasFullContent: false },
    { title: "C", link: "https://x.example.com/c", categories: [], hasFullContent: false },
  ];

  it("returns all items when filter is not specified", () => {
    expect(filterByCategory(items, undefined)).toHaveLength(3);
    expect(filterByCategory(items)).toHaveLength(3);
  });

  it("with an empty (but specified) filter, only items without categories are kept", () => {
    // filter が指定されている場合、categories が空の item は採用、
    // それ以外は filter のいずれかを含むものだけ採用。空配列とは何も一致しないので、
    // カテゴリを持つ item はすべて除外される。
    const out = filterByCategory(items, []);
    expect(out.map((i) => i.title)).toEqual(["C"]);
  });

  it("keeps items with no categories regardless of filter", () => {
    const out = filterByCategory(items, ["Engineering"]);
    expect(out.map((i) => i.title)).toContain("C");
  });

  it("keeps items matching any filter value, case-insensitively", () => {
    const out = filterByCategory(items, ["engineering"]);
    expect(out.map((i) => i.title).sort()).toEqual(["A", "C"]);
  });

  it("excludes items whose categories match none of the filter values", () => {
    const out = filterByCategory(items, ["Engineering"]);
    expect(out.map((i) => i.title)).not.toContain("B");
  });

  it("matches when any of multiple filter values hits", () => {
    const out = filterByCategory(items, ["Marketing", "Nonexistent"]);
    expect(out.map((i) => i.title).sort()).toEqual(["B", "C"]);
  });
});
