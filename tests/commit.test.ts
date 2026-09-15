// §5 (Source.latestPublishedAt) / §8-3 / §9.5 / §15: upsertSources (src/background/pipeline.ts)
// and the shared commitNewItems (src/background/commit.ts) against a real (fake-indexeddb) Dexie
// instance. Neither function calls chrome.* itself, but a minimal in-memory chrome.storage stub is
// installed anyway per the task's precaution, in case anything transitively imported reads it.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/shared/db";
import { upsertSources } from "../src/background/pipeline";
import { commitNewItems } from "../src/background/commit";
import { DEFAULT_SOURCES } from "../src/shared/sources";
import { DEFAULT_SETTINGS, NEW_ITEM_GRACE_MS } from "../src/shared/constants";
import { sha256Hex } from "../src/lib/hash";
import { normalizeUrl } from "../src/lib/urlNormalize";
import type { FeedItem } from "../src/lib/feedParser";
import type { Article, Settings, Source } from "../src/shared/types";

function installChromeStorageStub(): void {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const makeArea = (map: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: map.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: makeArea(local), session: makeArea(session) },
  };
}
installChromeStorageStub();

const settings: Settings = { ...DEFAULT_SETTINGS, enabledSources: ["netflix", "uber"] };

const netflixBase = DEFAULT_SOURCES.find((s) => s.id === "netflix");
if (!netflixBase) throw new Error("src/shared/sources.ts: netflix source not found");
const uberBase = DEFAULT_SOURCES.find((s) => s.id === "uber");
if (!uberBase) throw new Error("src/shared/sources.ts: uber source not found");

async function idFor(url: string): Promise<string> {
  return sha256Hex(normalizeUrl(url));
}

function feedItem(link: string, publishedAt: Date | undefined, title: string): FeedItem {
  return { title, link, categories: [], hasFullContent: false, publishedAt };
}

async function candidate(
  url: string,
  publishedAt: Date | undefined,
  title = `Title for ${url}`,
): Promise<{ id: string; item: FeedItem }> {
  return { id: await idFor(url), item: feedItem(url, publishedAt, title) };
}

/** Directly seeds db.articles, bypassing commitNewItems, to simulate a pre-existing article. */
async function seedArticle(sourceId: string, url: string, publishedAt: number): Promise<void> {
  const article: Article = {
    id: await idFor(url),
    sourceId,
    title: `existing: ${url}`,
    url,
    publishedAt,
    createdAt: Date.now(),
    contentSource: "none",
    contentChars: 0,
    status: "new",
    attempts: 0,
  };
  await getDb().articles.add(article);
}

async function seedSource(base: Source, overrides: Partial<Source>): Promise<Source> {
  const source: Source = { ...base, ...overrides };
  await getDb().sources.put(source);
  return source;
}

beforeEach(async () => {
  const db = getDb();
  await db.delete();
  await db.open();
});

describe("upsertSources (§5 / §8-2)", () => {
  it("preserves latestPublishedAt, etag, and lastFetchMode from the previously stored source on re-upsert", async () => {
    const db = getDb();
    const previous: Source = {
      ...netflixBase,
      initialized: true,
      etag: 'W/"abc123"',
      lastFetchMode: "listing",
      latestPublishedAt: Date.parse("2026-01-01T00:00:00Z"),
      lastStatus: "ok",
      lastItemCount: 3,
    };
    await db.sources.put(previous);

    const merged = await upsertSources(settings);
    const netflix = merged.find((s) => s.id === "netflix");
    expect(netflix).toBeDefined();
    expect(netflix?.latestPublishedAt).toBe(previous.latestPublishedAt);
    expect(netflix?.etag).toBe('W/"abc123"');
    expect(netflix?.lastFetchMode).toBe("listing");
    expect(netflix?.initialized).toBe(true);

    // and it's actually persisted, not just returned in-memory
    const stored = await db.sources.get("netflix");
    expect(stored?.latestPublishedAt).toBe(previous.latestPublishedAt);
    expect(stored?.etag).toBe('W/"abc123"');
    expect(stored?.lastFetchMode).toBe("listing");
  });

  it("leaves latestPublishedAt undefined for a source with no prior row (first run)", async () => {
    const merged = await upsertSources(settings);
    const netflix = merged.find((s) => s.id === "netflix");
    expect(netflix?.latestPublishedAt).toBeUndefined();
    expect(netflix?.initialized).toBe(false);
  });
});

describe("commitNewItems — feed mode, uninitialized / latestPublishedAt unset (§8-3)", () => {
  it("registers only the most-recently-published candidate and sets latestPublishedAt to its publishedAt", async () => {
    const source = await seedSource(netflixBase, { initialized: false, latestPublishedAt: undefined });
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const candidates = await Promise.all([
      candidate("https://netflixtechblog.com/a", new Date(t0)),
      candidate("https://netflixtechblog.com/b", new Date(t0 + 60_000)), // newest
      candidate("https://netflixtechblog.com/c", new Date(t0 - 60_000)),
    ]);

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(1);
    expect(result.latestPublishedAt).toBe(t0 + 60_000);

    const articles = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe("https://netflixtechblog.com/b");
    expect(articles[0].publishedAt).toBe(t0 + 60_000);
  });

  it("treats initialized:true with latestPublishedAt undefined (migration from an old version) the same way", async () => {
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: undefined });
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const candidates = await Promise.all([
      candidate("https://netflixtechblog.com/a", new Date(t0)),
      candidate("https://netflixtechblog.com/b", new Date(t0 + 60_000)), // newest
    ]);

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(1);
    expect(result.latestPublishedAt).toBe(t0 + 60_000);
    const articles = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe("https://netflixtechblog.com/b");
  });

  it("regression: 20 past-dated candidates whose newest is already in the DB register 0 new articles, but latestPublishedAt still advances to that newest so the source leaves backfill mode", async () => {
    // Bug being guarded against: naively always inserting "the latest 1 candidate" without
    // checking the DB first causes either a duplicate-key failure or (worse) a silent
    // re-summarization of an article that was already processed. A second bug this also
    // guards against: if latestPublishedAt is left undefined because nothing was *added*,
    // the source stays stuck picking "the latest 1 candidate" forever on every future run
    // instead of moving on to the normal (post-backfill) judgment (§8-3).
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: undefined });
    const base = Date.parse("2025-01-01T00:00:00Z");
    // 5-day spacing (> the 3-day grace) so that, once latestPublishedAt is set to the newest
    // candidate's date, every *other* candidate here is strictly outside the grace window —
    // otherwise a second run re-fed the exact same candidates would legitimately pick up
    // whichever earlier ones happen to fall inside the new grace window, which is correct
    // behavior but would make this assertion about "added=0 on re-run" ambiguous.
    const spacingMs = 5 * 86_400_000;
    const candidates = await Promise.all(
      Array.from({ length: 20 }, (_, i) => candidate(`https://netflixtechblog.com/post-${i}`, new Date(base + i * spacingMs))),
    );
    // candidates[19] has the largest publishedAt ("latest 1 item") — pre-seed it as already stored.
    const newest = candidates[candidates.length - 1];
    const newestPublishedAt = newest.item.publishedAt!.getTime();
    await seedArticle("netflix", newest.item.link, newestPublishedAt);

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(0);
    expect(result.latestPublishedAt).toBe(newestPublishedAt); // set even though nothing new was added
    const articles = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articles).toHaveLength(1); // just the pre-seeded one, nothing new added

    const stored = await getDb().sources.get("netflix");
    expect(stored?.latestPublishedAt).toBe(newestPublishedAt); // persisted, not just returned

    // Re-run with the exact same candidates (as a real re-fetch of the same feed would).
    // The source has now left "uninitialized backfill" judgment (latestPublishedAt is set),
    // so this must behave like the normal initialized case: everything here is at or before
    // the new latestPublishedAt, so 0 more are added and latestPublishedAt does not move.
    const second = await commitNewItems({ ...source, latestPublishedAt: result.latestPublishedAt }, settings, candidates, "feed");

    expect(second.added).toBe(0);
    expect(second.latestPublishedAt).toBe(newestPublishedAt);
    const articlesAfterSecondRun = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articlesAfterSecondRun).toHaveLength(1); // still just the one pre-existing article
  });
});

describe("commitNewItems — feed mode, initialized with latestPublishedAt set (§8-3)", () => {
  it("registers only candidates newer than latestPublishedAt - grace, and advances latestPublishedAt to their max", async () => {
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });
    const candidates = await Promise.all([
      candidate("https://netflixtechblog.com/too-old", new Date(base - NEW_ITEM_GRACE_MS - 60_000)), // at/below threshold -> dropped
      candidate("https://netflixtechblog.com/new1", new Date(base + 60_000)),
      candidate("https://netflixtechblog.com/new2", new Date(base + 120_000)),
    ]);

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(2);
    expect(result.latestPublishedAt).toBe(base + 120_000);
    const urls = (await getDb().articles.where("sourceId").equals("netflix").toArray()).map((a) => a.url).sort();
    expect(urls).toEqual(["https://netflixtechblog.com/new1", "https://netflixtechblog.com/new2"].sort());
  });

  it("captures a late item within the grace window (newer than threshold but older than latestPublishedAt), and skips a candidate already in the DB", async () => {
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });

    const lateUrl = "https://netflixtechblog.com/late";
    const latePublishedAt = base - 60_000; // older than latestPublishedAt, but within the 3-day grace window
    const alreadyInDbUrl = "https://netflixtechblog.com/already";
    const alreadyInDbPublishedAt = base + 30_000;
    await seedArticle("netflix", alreadyInDbUrl, alreadyInDbPublishedAt);

    const candidates = await Promise.all([
      candidate(lateUrl, new Date(latePublishedAt)),
      candidate(alreadyInDbUrl, new Date(alreadyInDbPublishedAt)), // same article the feed re-lists; must not be re-added
    ]);

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(1); // only the late one; the already-stored one is not re-registered
    const articles = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articles).toHaveLength(2); // the pre-seeded article + the newly-added late one
    expect(articles.map((a) => a.url).sort()).toEqual([alreadyInDbUrl, lateUrl].sort());
    // latestPublishedAt advances to the max of the *eligible* candidates (those newer than the
    // threshold), whether they were newly added or already in the DB — not just the newly-added
    // ones. Otherwise a source with only already-registered items inside the grace window would
    // never leave backfill-adjacent judgment behind. Here that max is alreadyInDbPublishedAt.
    expect(result.latestPublishedAt).toBe(alreadyInDbPublishedAt);
  });

  it("discards feed candidates with unknown publishedAt", async () => {
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });
    const candidates = [await candidate("https://netflixtechblog.com/no-date", undefined)];

    const result = await commitNewItems(source, settings, candidates, "feed");

    expect(result.added).toBe(0);
    const articles = await getDb().articles.where("sourceId").equals("netflix").toArray();
    expect(articles).toHaveLength(0);
  });

  it("caps registrations at maxNewPerSourcePerRun, registering the oldest-first, and reports the rest as carriedOver", async () => {
    const cappedSettings: Settings = { ...settings, maxNewPerSourcePerRun: 3 };
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });
    // 5 candidates, all newer than the threshold, at increasing 1-minute offsets (oldest = over-0)
    const candidates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        candidate(`https://netflixtechblog.com/over-${i}`, new Date(base + (i + 1) * 60_000)),
      ),
    );

    const result = await commitNewItems(source, cappedSettings, candidates, "feed");

    expect(result.added).toBe(3);
    expect(result.carriedOver).toBe(2);
    // oldest-first: over-0, over-1, over-2 are registered; latestPublishedAt stops at over-2's date
    expect(result.latestPublishedAt).toBe(base + 3 * 60_000);
    const urls = (await getDb().articles.where("sourceId").equals("netflix").toArray()).map((a) => a.url).sort();
    expect(urls).toEqual(
      ["https://netflixtechblog.com/over-0", "https://netflixtechblog.com/over-1", "https://netflixtechblog.com/over-2"].sort(),
    );
  });

  it("does not let already-registered candidates inside the grace window eat the maxNewPerSourcePerRun budget, across 3 consecutive runs", async () => {
    // §8-3 (updated): the DB-existence check must happen BEFORE the oldest-first cap is applied,
    // not after. Otherwise, with maxNewPerSourcePerRun=1, an already-registered old article that
    // the feed keeps re-listing (completely normal — RSS feeds always show their last N items)
    // would win the single slot every single run, and a genuinely new, newer article would be
    // starved forever even though it's well within the eligible window.
    const cappedSettings: Settings = { ...settings, maxNewPerSourcePerRun: 1 };
    const base = Date.parse("2026-01-10T00:00:00Z");
    let source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });

    const oldRegisteredUrl = "https://netflixtechblog.com/old-registered";
    const oldRegisteredPublishedAt = base - 60_000; // within the grace window, already in the DB
    await seedArticle("netflix", oldRegisteredUrl, oldRegisteredPublishedAt);

    const newUrls = ["new1", "new2", "new3"].map((slug) => `https://netflixtechblog.com/${slug}`);
    const newPublishedAts = [base + 60_000, base + 120_000, base + 180_000];

    for (let round = 0; round < 3; round++) {
      // Every round, the feed re-lists the already-registered article (as real feeds do) plus
      // one not-yet-registered article at the front of the queue.
      const candidates = await Promise.all([
        candidate(oldRegisteredUrl, new Date(oldRegisteredPublishedAt)),
        candidate(newUrls[round], new Date(newPublishedAts[round])),
      ]);

      const result = await commitNewItems(source, cappedSettings, candidates, "feed");

      expect(result.added).toBe(1); // the new article, not the already-registered one
      expect(result.carriedOver).toBe(0); // nothing genuinely unregistered was left waiting
      expect(result.latestPublishedAt).toBe(newPublishedAts[round]);

      source = { ...source, latestPublishedAt: result.latestPublishedAt };
    }

    const urls = (await getDb().articles.where("sourceId").equals("netflix").toArray()).map((a) => a.url).sort();
    expect(urls).toEqual([oldRegisteredUrl, ...newUrls].sort()); // all 3 new articles made it in, none lost
  });

  it("reports carriedOver as only the candidates that are genuinely unregistered and left waiting, not already-registered ones", async () => {
    const cappedSettings: Settings = { ...settings, maxNewPerSourcePerRun: 2 };
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });

    const oldRegisteredUrl = "https://netflixtechblog.com/old-registered";
    const oldRegisteredPublishedAt = base - 60_000; // within grace, oldest of all eligible candidates
    await seedArticle("netflix", oldRegisteredUrl, oldRegisteredPublishedAt);

    const candidates = await Promise.all([
      candidate(oldRegisteredUrl, new Date(oldRegisteredPublishedAt)),
      candidate("https://netflixtechblog.com/new1", new Date(base + 60_000)),
      candidate("https://netflixtechblog.com/new2", new Date(base + 120_000)),
      candidate("https://netflixtechblog.com/new3", new Date(base + 180_000)),
    ]);

    const result = await commitNewItems(source, cappedSettings, candidates, "feed");

    expect(result.added).toBe(2); // new1, new2 (oldest-first among the genuinely unregistered ones)
    expect(result.carriedOver).toBe(1); // only new3 is left waiting — the already-registered one doesn't count
    expect(result.latestPublishedAt).toBe(base + 120_000);
    const urls = (await getDb().articles.where("sourceId").equals("netflix").toArray()).map((a) => a.url).sort();
    expect(urls).toEqual([oldRegisteredUrl, "https://netflixtechblog.com/new1", "https://netflixtechblog.com/new2"].sort());
  });

  it("does not let a newer already-registered candidate advance latestPublishedAt past a carried-over one in the same (capped) run, so the carried-over candidate is still picked up next run", async () => {
    const cappedSettings: Settings = { ...settings, maxNewPerSourcePerRun: 1 };
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(netflixBase, { initialized: true, latestPublishedAt: base });

    // Already registered, but *newer* than the not-yet-registered candidates below.
    const newerRegisteredUrl = "https://netflixtechblog.com/already-newer";
    const newerRegisteredPublishedAt = base + 180_000;
    await seedArticle("netflix", newerRegisteredUrl, newerRegisteredPublishedAt);

    const candidates = await Promise.all([
      candidate("https://netflixtechblog.com/new1", new Date(base + 60_000)),
      candidate("https://netflixtechblog.com/new2", new Date(base + 120_000)),
      candidate(newerRegisteredUrl, new Date(newerRegisteredPublishedAt)),
    ]);

    const result = await commitNewItems(source, cappedSettings, candidates, "feed");

    expect(result.added).toBe(1); // only new1 (oldest genuinely-unregistered candidate; limit is 1)
    expect(result.carriedOver).toBe(1); // new2 is left waiting
    // Bug being guarded against: including the newer already-registered candidate's date here
    // would jump latestPublishedAt to base+180_000, pushing new2 (base+120_000) below the next
    // run's threshold forever. It must stop at addedKnown's own max instead.
    expect(result.latestPublishedAt).toBe(base + 60_000);
    const urlsAfterFirstRun = (await getDb().articles.where("sourceId").equals("netflix").toArray())
      .map((a) => a.url)
      .sort();
    expect(urlsAfterFirstRun).toEqual([newerRegisteredUrl, "https://netflixtechblog.com/new1"].sort());

    // Next run (as a real re-fetch would do): latestPublishedAt only advanced to new1's date, so
    // new2 is still above threshold and finally gets registered.
    const second = await commitNewItems(
      { ...source, latestPublishedAt: result.latestPublishedAt },
      cappedSettings,
      candidates,
      "feed",
    );
    expect(second.added).toBe(1);
    const urlsAfterSecondRun = (await getDb().articles.where("sourceId").equals("netflix").toArray())
      .map((a) => a.url)
      .sort();
    expect(urlsAfterSecondRun).toEqual(
      [newerRegisteredUrl, "https://netflixtechblog.com/new1", "https://netflixtechblog.com/new2"].sort(),
    );
  });
});

describe("commitNewItems — listing mode (§9.5)", () => {
  it("registers only the first (document-order) candidate when publishedAt is unknown, even when initialized, with publishedAt=createdAt", async () => {
    const source = await seedSource(uberBase, {
      initialized: true,
      latestPublishedAt: Date.parse("2026-01-01T00:00:00Z"),
    });
    const candidates = await Promise.all([
      candidate("https://www.uber.com/us/en/blog/article-1/", undefined, "Article one has a long enough title"),
      candidate("https://www.uber.com/us/en/blog/article-2/", undefined, "Article two has a long enough title"),
      candidate("https://www.uber.com/us/en/blog/article-3/", undefined, "Article three has a long enough title"),
    ]);
    const before = Date.now();

    const result = await commitNewItems(source, settings, candidates, "listing");

    const after = Date.now();
    expect(result.added).toBe(1);
    const articles = await getDb().articles.where("sourceId").equals("uber").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe(candidates[0].item.link);
    expect(articles[0].publishedAt).toBe(articles[0].createdAt);
    expect(articles[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(articles[0].createdAt).toBeLessThanOrEqual(after);
  });

  it("registers only the first candidate when publishedAt is unknown and the source is uninitialized too", async () => {
    const source = await seedSource(uberBase, { initialized: false, latestPublishedAt: undefined });
    const candidates = await Promise.all([
      candidate("https://www.uber.com/us/en/blog/article-1/", undefined, "Article one has a long enough title"),
      candidate("https://www.uber.com/us/en/blog/article-2/", undefined, "Article two has a long enough title"),
    ]);

    const result = await commitNewItems(source, settings, candidates, "listing");

    expect(result.added).toBe(1);
    const articles = await getDb().articles.where("sourceId").equals("uber").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe(candidates[0].item.link);
  });

  it("applies the same feed-mode judgment (grace window, cap, dedupe) to listing candidates whose publishedAt is known", async () => {
    const base = Date.parse("2026-01-10T00:00:00Z");
    const source = await seedSource(uberBase, { initialized: true, latestPublishedAt: base });
    const candidates = await Promise.all([
      candidate(
        "https://www.uber.com/us/en/blog/too-old/",
        new Date(base - NEW_ITEM_GRACE_MS - 60_000),
        "An old article with a long enough title",
      ),
      candidate("https://www.uber.com/us/en/blog/new1/", new Date(base + 60_000), "A new article with a long enough title"),
      candidate("https://www.uber.com/us/en/blog/new2/", new Date(base + 120_000), "Another new article, long enough title"),
    ]);

    const result = await commitNewItems(source, settings, candidates, "listing");

    expect(result.added).toBe(2);
    expect(result.latestPublishedAt).toBe(base + 120_000);
    const urls = (await getDb().articles.where("sourceId").equals("uber").toArray()).map((a) => a.url).sort();
    expect(urls).toEqual(["https://www.uber.com/us/en/blog/new1/", "https://www.uber.com/us/en/blog/new2/"].sort());
  });

  it("when uninitialized with both known-date and unknown-date candidates, registers only the most-recently-published known one (total capped at 1, no unknown-date fallback)", async () => {
    const source = await seedSource(uberBase, { initialized: false, latestPublishedAt: undefined });
    const base = Date.parse("2026-02-01T00:00:00Z");
    const candidates = await Promise.all([
      candidate(
        "https://www.uber.com/us/en/blog/known-older/",
        new Date(base),
        "Known older article with a long enough title",
      ),
      candidate(
        "https://www.uber.com/us/en/blog/known-newer/",
        new Date(base + 60_000),
        "Known newer article with a long enough title",
      ),
      candidate("https://www.uber.com/us/en/blog/unknown-1/", undefined, "Unknown date article one long title"),
      candidate("https://www.uber.com/us/en/blog/unknown-2/", undefined, "Unknown date article two long title"),
    ]);

    const result = await commitNewItems(source, settings, candidates, "listing");

    // Bug being guarded against: adding both the known-date latest *and* the unknown-date
    // document-order-first candidate would register 2 articles (and summarize/bill for 2) on the
    // very first run, instead of honoring "initial backfill = 1 article per source" (§0 / §9.5).
    expect(result.added).toBe(1);
    expect(result.latestPublishedAt).toBe(base + 60_000);
    const articles = await getDb().articles.where("sourceId").equals("uber").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe("https://www.uber.com/us/en/blog/known-newer/");
  });
});
