import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/lib/urlNormalize";

describe("normalizeUrl", () => {
  it("lowercases the host", () => {
    expect(normalizeUrl("https://EXAMPLE.com/Path")).toBe("https://example.com/Path");
  });

  it("removes the hash fragment", () => {
    expect(normalizeUrl("https://example.com/post#section-2")).toBe("https://example.com/post");
  });

  it("removes utm_* query params", () => {
    const out = normalizeUrl(
      "https://example.com/post?utm_source=newsletter&utm_medium=email&utm_campaign=launch",
    );
    expect(out).toBe("https://example.com/post");
  });

  it("removes source, ref, mkt_tok, fbclid and gi query params", () => {
    expect(normalizeUrl("https://example.com/post?source=rss-abc123")).toBe("https://example.com/post");
    expect(normalizeUrl("https://example.com/post?ref=hn")).toBe("https://example.com/post");
    expect(normalizeUrl("https://example.com/post?mkt_tok=abcdef")).toBe("https://example.com/post");
    expect(normalizeUrl("https://example.com/post?fbclid=xyz")).toBe("https://example.com/post");
    expect(normalizeUrl("https://example.com/post?gi=1234567890")).toBe("https://example.com/post");
  });

  it("keeps other, non-tracking query params", () => {
    expect(normalizeUrl("https://example.com/search?q=hello&utm_source=x")).toBe(
      "https://example.com/search?q=hello",
    );
  });

  it("removes a single trailing slash", () => {
    expect(normalizeUrl("https://example.com/post/")).toBe("https://example.com/post");
  });

  it("does not strip the root path slash into an empty string incorrectly", () => {
    // Root path normalizes to a consistent form (with or without trailing slash),
    // but must not throw and must remain idempotent (see idempotency test below).
    expect(() => normalizeUrl("https://example.com/")).not.toThrow();
  });

  it("upgrades http to https", () => {
    expect(normalizeUrl("http://example.com/post")).toBe("https://example.com/post");
  });

  it("combines multiple normalizations at once", () => {
    const out = normalizeUrl(
      "HTTP://Example.COM/Post/?utm_source=rss&utm_medium=feed&ref=hn#comments",
    );
    expect(out).toBe("https://example.com/Post");
  });

  it("is idempotent", () => {
    const inputs = [
      "https://EXAMPLE.com/Path/?utm_source=a&utm_campaign=b#frag",
      "http://example.com/post/",
      "https://example.com/post?source=rss-1&fbclid=y",
      "https://example.com/",
      "https://example.com/search?q=hello",
    ];
    for (const input of inputs) {
      const once = normalizeUrl(input);
      const twice = normalizeUrl(once);
      expect(twice).toBe(once);
    }
  });
});
