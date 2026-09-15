// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractListingItems } from "../src/lib/listingExtract";
import { normalizeUrl } from "../src/lib/urlNormalize";
import { DEFAULT_SOURCES } from "../src/shared/sources";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function docFromFixture(name: string): Document {
  const html = readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
  return new DOMParser().parseFromString(html, "text/html");
}

function fixtureDoc(): Document {
  return docFromFixture("listing.html");
}

const BASE_URL = "https://example.com/blog/engineering/";
const PATTERN = "^https://example\\.com/blog/[^/]+/?$";

// Widened patterns used only by the dedicated rule-1' tests below, where the excluded URL's
// shape (locale-prefixed, or the listing root itself) does not fit the single-segment PATTERN
// above. Reusing PATTERN there would make the exclusion untestable: the link would already be
// filtered out by rule 1 (pattern mismatch), not by the rule 1' exclusion under test.
const ES_HREFLANG_PATTERN = "^https://example\\.com/es/blog/[^/]+/?$";
const ANCESTOR_PATTERN = "^https://example\\.com/blog/?$";

describe("extractListingItems", () => {
  it("extracts only real article links, in document order, deduplicated, dropping categories/pagination/javascript/mailto/#", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });

    // Exactly the 6 real article cards, in the order they appear in the document.
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));
    expect(normalizedUrls).toEqual([
      "https://example.com/blog/slug-alpha",
      "https://example.com/blog/slug-beta",
      "https://example.com/blog/slug-gamma",
      "https://example.com/blog/slug-delta",
      "https://example.com/blog/abs-slug",
      "https://example.com/blog/slug-epsilon",
    ]);

    // Category nav links, pagination, and javascript:/mailto:/# links must never appear.
    const urlSet = new Set(normalizedUrls);
    expect(urlSet.has("https://example.com/blog/engineering")).toBe(false);
    expect(urlSet.has("https://example.com/blog/backend")).toBe(false);
    expect(urlSet.has("https://example.com/blog/frontend")).toBe(false);
    for (const item of items) {
      expect(item.url.startsWith("javascript:")).toBe(false);
      expect(item.url.startsWith("mailto:")).toBe(false);
      expect(item.url).not.toBe("#");
    }
  });

  it("resolves relative hrefs against baseUrl, and leaves absolute hrefs untouched", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });

    const abs = items.find((item) => normalizeUrl(item.url) === "https://example.com/blog/abs-slug");
    expect(abs).toBeDefined();

    // "../slug-epsilon/" resolved against "https://example.com/blog/engineering/"
    const epsilon = items.find((item) => normalizeUrl(item.url) === "https://example.com/blog/slug-epsilon");
    expect(epsilon).toBeDefined();

    const alpha = items.find((item) => normalizeUrl(item.url) === "https://example.com/blog/slug-alpha");
    expect(alpha).toBeDefined();
  });

  it("reads time[datetime] as publishedAt (epoch ms) for articles that have one, and leaves it undefined otherwise", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const byUrl = new Map(items.map((item) => [normalizeUrl(item.url), item]));

    expect(byUrl.get("https://example.com/blog/slug-alpha")?.publishedAt).toBe(
      Date.parse("2026-09-01T00:00:00Z"),
    );
    expect(byUrl.get("https://example.com/blog/slug-beta")?.publishedAt).toBe(
      Date.parse("2026-08-15T08:30:00Z"),
    );

    // No <time> element nearby -> undefined, not NaN, not 0.
    expect(byUrl.get("https://example.com/blog/slug-gamma")?.publishedAt).toBeUndefined();
    expect(byUrl.get("https://example.com/blog/slug-delta")?.publishedAt).toBeUndefined();
    expect(byUrl.get("https://example.com/blog/abs-slug")?.publishedAt).toBeUndefined();
    expect(byUrl.get("https://example.com/blog/slug-epsilon")?.publishedAt).toBeUndefined();
  });

  it("prefers the heading text for the title, falling back to the anchor text when there is no heading", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const byUrl = new Map(items.map((item) => [normalizeUrl(item.url), item]));

    expect(byUrl.get("https://example.com/blog/slug-alpha")?.title).toBe(
      "Deep Dive Into Our New Distributed Rate Limiter Architecture",
    );
    expect(byUrl.get("https://example.com/blog/slug-beta")?.title).toBe(
      "Migrating Ten Petabytes Without Downtime",
    );
    expect(byUrl.get("https://example.com/blog/slug-gamma")?.title).toBe(
      "Why We Rewrote Our Build System In Rust",
    );
    expect(byUrl.get("https://example.com/blog/abs-slug")?.title).toBe(
      "Absolute URLs Are Fine Too, Apparently",
    );
    expect(byUrl.get("https://example.com/blog/slug-epsilon")?.title).toBe(
      "Resolving Relative Links The Hard Way",
    );

    // No heading inside the anchor -> falls back to the (whitespace-normalized) anchor text.
    expect(byUrl.get("https://example.com/blog/slug-delta")?.title).toBe(
      "Notes from running chaos experiments across every production region",
    );
  });

  it("deduplicates links to the same article once URLs are normalized (utm_* stripped), keeping the first occurrence", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });

    // slug-gamma appears twice in the fixture: once as the primary card, once in the
    // "Popular this week" sidebar with utm_source/utm_medium query params. Only one
    // item should survive, and it should keep the first (primary card) title.
    const gammaMatches = items.filter(
      (item) => normalizeUrl(item.url) === "https://example.com/blog/slug-gamma",
    );
    expect(gammaMatches).toHaveLength(1);
    expect(gammaMatches[0].title).toBe("Why We Rewrote Our Build System In Rust");

    // The duplicate image-link + title-link pair for slug-alpha must also collapse to one item.
    const alphaMatches = items.filter(
      (item) => normalizeUrl(item.url) === "https://example.com/blog/slug-alpha",
    );
    expect(alphaMatches).toHaveLength(1);
  });

  it("returns an empty array when the pattern matches nothing on the page", () => {
    const items = extractListingItems(fixtureDoc(), {
      baseUrl: BASE_URL,
      pattern: "^https://example\\.com/does-not-exist/[^/]+/?$",
    });
    expect(items).toEqual([]);
  });

  it("throws when given an invalid regular expression pattern", () => {
    expect(() =>
      extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: "(unclosed[" }),
    ).toThrow();
  });
});

describe("extractListingItems — rule 1' exclusions (§9.5)", () => {
  // Every fixture link exercised in this block has a heading and/or >=20 char text, i.e. it
  // would satisfy rule 2 on its own. It must be dropped solely because of the rule 1' check
  // under test, not because it fails to "look like an article".

  it("drops links whose ancestor is nav, header, footer, [role=navigation] or [role=menu]", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const normalizedUrls = new Set(items.map((item) => normalizeUrl(item.url)));

    expect(normalizedUrls.has("https://example.com/blog/nav-heading-slug")).toBe(false);
    expect(normalizedUrls.has("https://example.com/blog/header-slug")).toBe(false);
    expect(normalizedUrls.has("https://example.com/blog/footer-slug")).toBe(false);
    expect(normalizedUrls.has("https://example.com/blog/footer-bottom-slug")).toBe(false);
    expect(normalizedUrls.has("https://example.com/blog/role-nav-slug")).toBe(false);
    expect(normalizedUrls.has("https://example.com/blog/role-menu-slug")).toBe(false);

    // and the well-formed 6 articles are still exactly what's returned (nothing extra leaked in)
    expect(normalizedUrls.size).toBe(6);
  });

  it("drops links with rel=nofollow or rel=tag", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).not.toContain("https://example.com/blog/nofollow-slug");
    expect(normalizedUrls).not.toContain("https://example.com/blog/tag-slug");
  });

  it("drops a hreflang-alternate link even when the URL matches the pattern", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: ES_HREFLANG_PATTERN });
    // ES_HREFLANG_PATTERN only matches the /es/blog/some-slug/ link in the whole fixture, so if
    // the hreflang exclusion works, nothing at all should come back.
    expect(items).toEqual([]);
  });

  it("drops the listingUrl itself even though it matches the pattern and looks like an article", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));
    expect(normalizedUrls).not.toContain(normalizeUrl(BASE_URL));
  });

  it("drops an ancestor path of the listingUrl", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: ANCESTOR_PATTERN });
    // ANCESTOR_PATTERN only matches https://example.com/blog/ (the ancestor link) in the whole
    // fixture, so if the ancestor-path exclusion works, nothing at all should come back.
    expect(items).toEqual([]);
  });

  it("drops a link whose query string contains page= even though the path matches the pattern", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));
    expect(normalizedUrls.some((url) => url.includes("slug-zeta"))).toBe(false);
  });

  it("does not treat >=20 char anchor text with no whitespace as a multi-word title (rule 2(b))", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));
    expect(normalizedUrls).not.toContain("https://example.com/blog/no-space-slug");
  });
});

describe("extractListingItems — ld+json priority (rule 0, §9.5)", () => {
  it("prefers an ItemList in ld+json over anchor scanning, returning only its items in order", () => {
    const doc = docFromFixture("listing-ldjson.html");
    const items = extractListingItems(doc, { baseUrl: BASE_URL, pattern: PATTERN });

    expect(items.map((item) => normalizeUrl(item.url))).toEqual([
      "https://example.com/blog/ld-alpha",
      "https://example.com/blog/ld-beta",
      "https://example.com/blog/ld-gamma",
    ]);
    expect(items.map((item) => item.title)).toEqual([
      "LD JSON Alpha Post Title",
      "LD JSON Beta Post Title",
      "LD JSON Gamma Post Title",
    ]);

    // Anchor scanning must not have run at all: the anchor-only articles on the page must be
    // absent, and the result must contain exactly the 3 ld+json items (no more, no fewer).
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));
    expect(normalizedUrls).not.toContain("https://example.com/blog/anchor-should-be-ignored-1");
    expect(normalizedUrls).not.toContain("https://example.com/blog/anchor-should-be-ignored-2");
    expect(items).toHaveLength(3);
  });

  it("reads BlogPosting entries from an ld+json @graph, applying the pattern and rule 1' exclusions, with datePublished as epoch ms", () => {
    const doc = docFromFixture("listing-ldjson-graph.html");
    const items = extractListingItems(doc, { baseUrl: BASE_URL, pattern: PATTERN });

    // Of the 4 BlogPosting entries in @graph: one is on a different domain (pattern mismatch),
    // and one carries a page= query (rule 1' exclusion) — both must be dropped, leaving 2.
    expect(items.map((item) => normalizeUrl(item.url))).toEqual([
      "https://example.com/blog/graph-alpha",
      "https://example.com/blog/graph-beta",
    ]);
    expect(items.map((item) => item.title)).toEqual([
      "Graph LD+JSON Alpha Post Headline",
      "Graph LD+JSON Beta Post Headline",
    ]);
    expect(items.map((item) => item.publishedAt)).toEqual([
      Date.parse("2026-07-10T12:00:00Z"),
      Date.parse("2026-06-01T09:15:00Z"),
    ]);
    for (const item of items) {
      expect(typeof item.publishedAt).toBe("number");
    }

    // Anchor scanning must not have run: the anchor-only article on the page must be absent.
    expect(items.map((item) => normalizeUrl(item.url))).not.toContain(
      "https://example.com/blog/anchor-should-be-ignored",
    );
  });
});

describe("extractListingItems — excludePattern, locale variants, and Uber's real URL shape (§9.5)", () => {
  it("drops URLs matching excludePattern even though they match pattern and look like real articles", () => {
    const items = extractListingItems(fixtureDoc(), {
      baseUrl: BASE_URL,
      pattern: PATTERN,
      excludePattern: "^https://example\\.com/blog/slug-(beta|gamma)$",
    });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).not.toContain("https://example.com/blog/slug-beta");
    expect(normalizedUrls).not.toContain("https://example.com/blog/slug-gamma");
    // Unrelated real articles are unaffected.
    expect(normalizedUrls).toContain("https://example.com/blog/slug-alpha");
    expect(normalizedUrls).toContain("https://example.com/blog/slug-delta");
  });

  it("drops a locale-switch URL that shares listingUrl's tail path segments but differs only in the locale prefix, even without hreflang", () => {
    const localeBaseUrl = "https://example.com/us/en/blog/engineering/";
    // Widened to permit a 2-segment (us/en) or 1-segment hyphenated (es-ES, lowercase language +
    // uppercase country) locale prefix ahead of "blog/<slug>", matching the real-world Uber-style
    // pattern shape (see sources.ts). Note the uppercase country code: a pattern requiring
    // lowercase on both halves (e.g. "[a-z]{2}-[a-z]{2}") would reject "es-ES" outright at the
    // rule-1 pattern-match stage, which would make this test pass for the wrong reason (pattern
    // mismatch) instead of actually exercising the rule-1' locale-variant exclusion under test.
    const localePattern = "^https://example\\.com/(?:[a-z]{2}-[A-Z]{2}/|[a-z]{2}/[a-z]{2}/)?blog/[^/]+/?$";

    const html = `<!doctype html>
<html lang="en">
<body>
  <main>
    <a href="https://example.com/us/en/blog/scaling-our-fleet-dispatch-system/">
      <h3>Scaling Our Fleet Dispatch System To Handle Ten Times The Load</h3>
    </a>
    <a href="https://example.com/es-ES/blog/engineering/">
      <h3>Spanish Language Version Of This Listing Page Must Be Excluded</h3>
    </a>
  </main>
</body>
</html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");

    const items = extractListingItems(doc, { baseUrl: localeBaseUrl, pattern: localePattern });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).not.toContain("https://example.com/es-ES/blog/engineering");
    expect(normalizedUrls).toContain("https://example.com/us/en/blog/scaling-our-fleet-dispatch-system");
  });

  it("keeps only the 3 real articles from an Uber-shaped listing page, using the uber source's listingLinkPattern and listingExcludePattern", () => {
    const uberSource = DEFAULT_SOURCES.find((s) => s.id === "uber");
    expect(uberSource?.listingUrl).toBeDefined();
    expect(uberSource?.listingLinkPattern).toBeDefined();
    expect(uberSource?.listingExcludePattern).toBeDefined();
    if (!uberSource?.listingUrl || !uberSource.listingLinkPattern || !uberSource.listingExcludePattern) {
      throw new Error("src/shared/sources.ts: uber source is missing listingUrl/listingLinkPattern/listingExcludePattern");
    }

    const doc = docFromFixture("listing-uber-like.html");
    const items = extractListingItems(doc, {
      baseUrl: uberSource.listingUrl,
      pattern: uberSource.listingLinkPattern,
      excludePattern: uberSource.listingExcludePattern,
    });

    expect(items.map((item) => normalizeUrl(item.url))).toEqual([
      "https://www.uber.com/us/en/blog/rate-limiting-at-planet-scale-with-sharded-windows",
      "https://www.uber.com/us/en/blog/migrating-our-dispatch-service-off-legacy-infrastructure",
      "https://www.uber.com/us/en/blog/how-we-rebuilt-driver-matching-in-rust",
    ]);

    // §9.5 規則4': 返る url は正規化前の元の URL（末尾スラッシュ付き）のまま。Uber は末尾スラッシュ
    // 無しの URL に 404 を返すため、normalizeUrl 済みの URL を Article.url に入れてはいけない。
    expect(items.map((item) => item.url)).toEqual([
      "https://www.uber.com/us/en/blog/rate-limiting-at-planet-scale-with-sharded-windows/",
      "https://www.uber.com/us/en/blog/migrating-our-dispatch-service-off-legacy-infrastructure/",
      "https://www.uber.com/us/en/blog/how-we-rebuilt-driver-matching-in-rust/",
    ]);
  });
});

describe("extractListingItems — rule 1'' single-word category exclusion (§9.5)", () => {
  const uberSource = DEFAULT_SOURCES.find((s) => s.id === "uber");
  if (!uberSource?.listingUrl || !uberSource.listingLinkPattern) {
    throw new Error("src/shared/sources.ts: uber source is missing listingUrl/listingLinkPattern");
  }
  const { listingUrl, listingLinkPattern } = uberSource;

  it("drops a category not covered by listingExcludePattern when both its slug and its heading are a single word (e.g. /autonomous/, heading 'Autonomous')", () => {
    const html = `<!doctype html>
<html lang="en">
<body>
  <main>
    <a href="https://www.uber.com/us/en/blog/autonomous/">
      <h3>Autonomous</h3>
    </a>
    <a href="https://www.uber.com/us/en/blog/scaling-our-fleet-dispatch-system/">
      <h3>Scaling Our Fleet Dispatch System To Handle Ten Times The Load</h3>
    </a>
  </main>
</body>
</html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");

    // excludePattern is intentionally omitted so this exercises rule 1'' alone, not the
    // per-source known-category list — "autonomous" is not in uber's listingExcludePattern.
    const items = extractListingItems(doc, { baseUrl: listingUrl, pattern: listingLinkPattern });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).not.toContain("https://www.uber.com/us/en/blog/autonomous");
    // the real, hyphenated-slug article on the same page is unaffected
    expect(normalizedUrls).toContain("https://www.uber.com/us/en/blog/scaling-our-fleet-dispatch-system");
  });

  it("keeps a real single-word-slug article whose heading is multiple words (e.g. /michelangelo/, heading \"Michelangelo: Uber's ML Platform\")", () => {
    const html = `<!doctype html>
<html lang="en">
<body>
  <main>
    <a href="https://www.uber.com/us/en/blog/michelangelo/">
      <h3>Michelangelo: Uber's ML Platform</h3>
    </a>
  </main>
</body>
</html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Single-word slug alone must not trigger rule 1'' — the heading has whitespace, so this
    // is a real article, not a category card.
    const items = extractListingItems(doc, { baseUrl: listingUrl, pattern: listingLinkPattern });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).toContain("https://www.uber.com/us/en/blog/michelangelo");
  });

  it("does not apply rule 1'' to ld+json items even when both the slug and the title are a single word", () => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "url": "https://www.uber.com/us/en/blog/michelangelo/", "name": "Michelangelo" }
    ]
  }
  </script>
</head>
<body>
  <main><h1>Latest posts</h1></main>
</body>
</html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");

    // "Michelangelo" is a single-word slug AND a single-word ld+json name, which would be
    // dropped by rule 1'' on the anchor path — but rule 1'' must not apply to ld+json items at all.
    const items = extractListingItems(doc, { baseUrl: listingUrl, pattern: listingLinkPattern });
    const normalizedUrls = items.map((item) => normalizeUrl(item.url));

    expect(normalizedUrls).toContain("https://www.uber.com/us/en/blog/michelangelo");
  });
});

describe("extractListingItems — returns the original (unnormalized) URL, not the normalized one (§9.5 規則4')", () => {
  it("returns the exact absolute-but-unnormalized href, preserving trailing slash and query string", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const alpha = items.find((item) => normalizeUrl(item.url) === "https://example.com/blog/slug-alpha");

    // The fixture's href is "/blog/slug-alpha/" (trailing slash); normalizeUrl would strip it,
    // but the returned item.url must keep it exactly as resolved against baseUrl.
    expect(alpha?.url).toBe("https://example.com/blog/slug-alpha/");
  });

  it("dedupes by normalized URL but keeps the first occurrence's original (unnormalized) URL — utm-tagged duplicate loses", () => {
    const items = extractListingItems(fixtureDoc(), { baseUrl: BASE_URL, pattern: PATTERN });
    const gammaMatches = items.filter(
      (item) => normalizeUrl(item.url) === "https://example.com/blog/slug-gamma",
    );

    expect(gammaMatches).toHaveLength(1);
    // The fixture has two links to slug-gamma: the primary card's plain "/blog/slug-gamma/" (first
    // in document order) and a sidebar duplicate with "?utm_source=newsletter&utm_medium=email".
    // First occurrence wins, so the returned (unnormalized) url must be the plain one, not the
    // utm-tagged duplicate, and must not carry the utm query string.
    expect(gammaMatches[0].url).toBe("https://example.com/blog/slug-gamma/");
    expect(gammaMatches[0].url).not.toContain("utm_");
  });

  it("keeps a query string other than utm/tracking params on the returned url, since only the normalized key strips it", () => {
    // slug-zeta (?page=2) is excluded entirely by rule 1', so instead verify with a fresh doc that
    // a non-tracking query string on an otherwise-valid article link survives on the returned url.
    const html = `<!doctype html>
<html><body>
  <main>
    <a href="/blog/slug-with-query/?ref=homepage&amp;variant=b">
      <h3>An Article Whose Link Happens To Carry A Query String</h3>
    </a>
  </main>
</body></html>`;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const withQuery = extractListingItems(doc, { baseUrl: BASE_URL, pattern: PATTERN });

    expect(withQuery).toHaveLength(1);
    // "ref" is a tracking param stripped by normalizeUrl (used only for pattern/dedup), but the
    // returned url is the original, unnormalized href and must still carry the full query string.
    expect(withQuery[0].url).toBe("https://example.com/blog/slug-with-query/?ref=homepage&variant=b");
    expect(normalizeUrl(withQuery[0].url)).toBe("https://example.com/blog/slug-with-query?variant=b");
  });
});

describe("extractListingItems — LinkedIn-shaped listing with text-date fallback, no time elements (§9.5 規則4)", () => {
  it("extracts publishedAt from a nearby ancestor's text date for a featured card and three grid cards, with no time[datetime] anywhere", () => {
    const linkedinSource = DEFAULT_SOURCES.find((s) => s.id === "linkedin");
    expect(linkedinSource?.listingUrl).toBeDefined();
    expect(linkedinSource?.listingLinkPattern).toBeDefined();
    if (!linkedinSource?.listingUrl || !linkedinSource.listingLinkPattern) {
      throw new Error("src/shared/sources.ts: linkedin source is missing listingUrl/listingLinkPattern");
    }

    const doc = docFromFixture("listing-linkedin-like.html");
    expect(doc.querySelector("time")).toBeNull();

    const items = extractListingItems(doc, {
      baseUrl: linkedinSource.listingUrl,
      pattern: linkedinSource.listingLinkPattern,
    });

    expect(items.map((item) => item.url)).toEqual([
      "https://www.linkedin.com/blog/engineering/search/reimagining-linkedins-search-stack",
      "https://www.linkedin.com/blog/engineering/infrastructure/scaling-video-processing-for-a-billion-streams",
      "https://www.linkedin.com/blog/engineering/data/rebuilding-our-streaming-pipeline-from-scratch",
      "https://www.linkedin.com/blog/engineering/security/hardening-our-authentication-service",
    ]);

    expect(items.map((item) => item.title)).toEqual([
      "Reimagining LinkedIn's search tech stack",
      "Scaling Video Processing For A Billion Streams",
      "Rebuilding Our Streaming Pipeline From Scratch",
      "Hardening Our Authentication Service Against Credential Stuffing",
    ]);

    expect(items.map((item) => item.publishedAt)).toEqual([
      Date.UTC(2026, 8, 2), // Sep 2, 2026 (featured card)
      Date.UTC(2026, 7, 27), // Aug 27, 2026 (grid card 1)
      Date.UTC(2026, 7, 24), // Aug 24, 2026 (grid card 2)
      Date.UTC(2026, 6, 3), // Jul 3, 2026 (grid card 3)
    ]);
  });
});
