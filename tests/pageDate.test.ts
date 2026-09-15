// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractPublishedAt } from "../src/lib/pageDate";

function docFromHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("extractPublishedAt", () => {
  it("returns undefined when the page has no date information at all", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>A Post With No Dates Anywhere</h1>
    <p>Just some body text, nothing date-shaped in it.</p>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBeUndefined();
  });

  it("uses meta[property=article:published_time] when present", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta property="article:published_time" content="2026-09-02T10:00:00Z">
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-02T10:00:00Z"));
  });

  it("falls back to meta[name=date] when article:published_time is absent", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta name="date" content="2026-08-15">
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-08-15"));
  });

  it("falls back to meta[name=pubdate] / publish-date / dc.date when name=date is absent", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta name="dc.date" content="2026-07-01">
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-07-01"));
  });

  it("falls back to ld+json datePublished when no meta tags are present", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <script type="application/ld+json">
    { "@context": "https://schema.org", "@type": "BlogPosting", "datePublished": "2026-06-10T09:00:00Z" }
  </script>
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-06-10T09:00:00Z"));
  });

  it("falls back to time[datetime] when no meta or ld+json is present", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>Title</h1>
    <time datetime="2026-05-05T00:00:00Z">May 5, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-05-05T00:00:00Z"));
  });

  it("skips a leading reading-time <time datetime=\"PT8M\"> and uses the later time element instead", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>Title</h1>
    <span>Reading time: <time datetime="PT8M">8 min</time></span>
    <time datetime="2026-05-05T00:00:00Z">May 5, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-05-05T00:00:00Z"));
  });

  it("falls back to the h1-adjacent text date when there is no meta, ld+json, or time element", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>A Post Dated Only In Prose</h1>
    <p class="byline">Sep 2, 2026</p>
    <p>Some more body copy that has nothing date-shaped in it.</p>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });

  it("skips an unparseable article:published_time and falls through to meta[name=date] instead of returning undefined", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta property="article:published_time" content="not-a-real-date">
  <meta name="date" content="2026-08-15">
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-08-15"));
  });

  it("skips unparseable meta[name=date] and meta[name=pubdate] and falls through to meta[name=dc.date]", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta name="date" content="garbage">
  <meta name="pubdate" content="also garbage">
  <meta name="dc.date" content="2026-07-01">
</head><body>
  <article><h1>Title</h1></article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-07-01"));
  });

  it("skips an unparseable ld+json datePublished and falls through to time[datetime]", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <script type="application/ld+json">
    { "@type": "BlogPosting", "datePublished": "not-a-real-date" }
  </script>
</head><body>
  <article>
    <h1>Title</h1>
    <time datetime="2026-04-04T00:00:00Z">Apr 4, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-04-04T00:00:00Z"));
  });

  it("prefers meta over ld+json, time, and h1-adjacent text when all are present", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <meta property="article:published_time" content="2026-01-01T00:00:00Z">
  <script type="application/ld+json">
    { "@type": "BlogPosting", "datePublished": "2026-02-02T00:00:00Z" }
  </script>
</head><body>
  <article>
    <h1>Title</h1>
    <p class="byline">Mar 3, 2026</p>
    <time datetime="2026-04-04T00:00:00Z">Apr 4, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("prefers ld+json over time and h1-adjacent text when meta is absent", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <script type="application/ld+json">
    { "@type": "BlogPosting", "datePublished": "2026-02-02T00:00:00Z" }
  </script>
</head><body>
  <article>
    <h1>Title</h1>
    <p class="byline">Mar 3, 2026</p>
    <time datetime="2026-04-04T00:00:00Z">Apr 4, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-02-02T00:00:00Z"));
  });

  it("prefers time[datetime] over h1-adjacent text when meta and ld+json are both absent", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>Title</h1>
    <p class="byline">Mar 3, 2026</p>
    <time datetime="2026-04-04T00:00:00Z">Apr 4, 2026</time>
  </article>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-04-04T00:00:00Z"));
  });

  it("LinkedIn-shaped page: picks the h1-adjacent byline date over a top banner date and footer related-article dates", () => {
    const doc = docFromHtml(`<!doctype html>
<html>
<body>
  <div class="top-banner">
    <p>Site notice dated January 21, 2026 regarding scheduled maintenance.</p>
  </div>
  <article>
    <h1>Reimagining LinkedIn's search tech stack</h1>
    <div class="byline"><span>Sep 2, 2026</span></div>
    <p>A long article body about search infrastructure, with no other dates in it.</p>
  </article>
  <footer>
    <h2>Related articles</h2>
    <ul>
      <li>Aug 27, 2026</li>
      <li>Aug 24, 2026</li>
    </ul>
  </footer>
</body>
</html>`);
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });

  it("climbs past an h1 ancestor with zero dates to find the one above it that has exactly one", () => {
    // h1's immediate parent has no date text at all (0 matches, not 1) so it must be skipped;
    // the next ancestor up adds a caption with exactly one date, so that one is used.
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <div class="figure-wrap">
    <div class="heading-only">
      <h1>Title With No Nearby Date Text</h1>
    </div>
    <p class="caption">Posted Sep 2, 2026 as a caption.</p>
  </div>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });

  it("Uber-shaped page: extracts publishedAt from a backslash-escaped embedded JSON string, ignoring page_generated_at/createdAt/updatedAt in the same script", () => {
    // String.raw でリテラルのバックスラッシュを含める。実際の Uber の記事ページは
    // <script> の中で JSON 文字列がまるごと \"key\":\"value\" の形でエスケープされている。
    const doc = docFromHtml(String.raw`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = "{\"page_generated_at\":\"2026-09-15T05:02:50.013Z\",\"publishedAt\":\"2026-09-11T16:47:43.218969Z\",\"createdAt\":\"2026-09-11T16:42:05.537Z\",\"updatedAt\":\"2026-09-12T00:00:00.000Z\"}";</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-11T16:47:43.218969Z"));
  });

  it("Uber-shaped page: extracts publishedAt from a plain (non-escaped) embedded JSON script, ignoring page_generated_at/createdAt/updatedAt in the same script", () => {
    // \" 形（String.raw のテスト、上）に加えて、素の " 形（<script> の中身がそのまま JSON リテラルの
    // 形）も通ることを確認する。
    const doc = docFromHtml(String.raw`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = {"page_generated_at":"2026-09-15T05:02:50.013Z","publishedAt":"2026-09-11T16:47:43.218969Z","createdAt":"2026-09-11T16:42:05.537Z","updatedAt":"2026-09-12T00:00:00.000Z"};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-11T16:47:43.218969Z"));
  });

  it("Uber-shaped page: extracts publishedAt from a \u0022-escaped embedded JSON string (the form Uber actually serves), ignoring page_generated_at/createdAt/updatedAt", () => {
    // 実際の Uber の記事ページは引用符が \u0022 でエスケープされている:
    //   \u0022publishedAt\u0022:\u00222026-09-11T16:47:43.218969Z\u0022
    // String.raw でリテラルの \u0022 を含める（JS の文字列エスケープで " に化けないように）。
    const doc = docFromHtml(String.raw`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>self.__next_f.push([1,"{\u0022page_generated_at\u0022:\u00222026-09-15T05:02:50.013Z\u0022,\u0022isLive\u0022:true,\u0022publishedAt\u0022:\u00222026-09-11T16:47:43.218969Z\u0022,\u0022createdAt\u0022:\u00222026-09-11T16:42:05.537Z\u0022,\u0022updatedAt\u0022:\u00222026-09-11T16:47:37.625Z\u0022}"])</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-11T16:47:43.218969Z"));
  });

  it("does not fall through to a text-date read from inside a <script> when only page_generated_at is present (script content is excluded from text-date scanning)", () => {
    const doc = docFromHtml(String.raw`<!doctype html>
<html><body>
  <article>
    <h1>A Post With No Dates Anywhere</h1>
    <p>Just some body text, nothing date-shaped in it.</p>
  </article>
  <script>window.__DATA__ = "{\"page_generated_at\":\"2026-09-15T05:02:50.013Z\"}";</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBeUndefined();
  });

  it("does not treat a 14-digit number as an epoch value for publishedAt", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = {"publishedAt":17570000000000};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBeUndefined();
  });

  it("extracts a 13-digit epoch-ms value for publishedAt from an embedded script", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = {"publishedAt":1757000000000};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(1757000000000);
  });

  it("extracts a 10-digit epoch-seconds value for published_at from an embedded script", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = {"published_at":1757000000};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(1757000000 * 1000);
  });

  it("prefers ld+json datePublished over the embedded JSON publishedAt key", () => {
    const doc = docFromHtml(`<!doctype html>
<html><head>
  <script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-03-03T00:00:00Z"}</script>
</head><body>
  <article><h1>Title</h1></article>
  <script>window.__DATA__ = {"publishedAt":"2026-09-11T16:47:43.218969Z"};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-03-03T00:00:00Z"));
  });

  it("prefers the embedded JSON publishedAt key over time[datetime] when meta and ld+json are absent", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article>
    <h1>Title</h1>
    <time datetime="2026-04-04T00:00:00Z">Apr 4, 2026</time>
  </article>
  <script>window.__DATA__ = {"publishedAt":"2026-09-11T16:47:43.218969Z"};</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-11T16:47:43.218969Z"));
  });

  it("decodes backslash-escaped quotes in the embedded script before matching", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <article><h1>Title</h1></article>
  <script>{\\"publishedAt\\":\\"2026-09-11\\"}</script>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.parse("2026-09-11"));
  });

  it("finds a text date when there is no whitespace between elements in minified SSR-style HTML (e.g. <h1>Title</h1><p>Sep 2, 2026</p>)", () => {
    // 要素間に空白の無い HTML: cleanTextContent が要素境界に空白を挟まないと
    // "TitleSep 2, 2026" のように連結され、月名パターンの単語境界を失って取りこぼす。
    const doc = docFromHtml(
      `<!doctype html><html><body><article><h1>Title</h1><p>Sep 2, 2026</p></article></body></html>`,
    );
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });

  it("falls back to the first date in the body's first 3000 characters when there is no h1 at all", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <p>No heading on this page, but the text says it was posted Sep 2, 2026 right here.</p>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });
});
