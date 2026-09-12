// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractListingItems } from "../src/lib/listingExtract";
import { normalizeUrl } from "../src/lib/urlNormalize";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixtureDoc(): Document {
  const html = readFileSync(path.join(__dirname, "fixtures", "listing.html"), "utf-8");
  return new DOMParser().parseFromString(html, "text/html");
}

const BASE_URL = "https://example.com/blog/engineering/";
const PATTERN = "^https://example\\.com/blog/[^/]+/?$";

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
