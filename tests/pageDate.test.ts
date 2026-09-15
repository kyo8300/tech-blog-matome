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

  it("falls back to the first date in the body's first 3000 characters when there is no h1 at all", () => {
    const doc = docFromHtml(`<!doctype html>
<html><body>
  <p>No heading on this page, but the text says it was posted Sep 2, 2026 right here.</p>
</body></html>`);
    expect(extractPublishedAt(doc)).toBe(Date.UTC(2026, 8, 2));
  });
});
