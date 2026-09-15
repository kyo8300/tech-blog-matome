// §15: upsertSources (src/background/pipeline.ts) and commitListingItems
// (src/background/listingFetcher.ts) against a real (fake-indexeddb) Dexie instance.
// Neither function calls chrome.* itself, but a minimal in-memory chrome.storage stub is
// installed anyway per the task's precaution, in case anything transitively imported reads it.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/shared/db";
import { upsertSources } from "../src/background/pipeline";
import { commitListingItems } from "../src/background/listingFetcher";
import { DEFAULT_SOURCES } from "../src/shared/sources";
import { DEFAULT_SETTINGS, LISTING_SEEN_MAX } from "../src/shared/constants";
import type { ListingItem, Settings, Source } from "../src/shared/types";

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

const settings: Settings = { ...DEFAULT_SETTINGS, enabledSources: ["uber"] };

const uberBase = DEFAULT_SOURCES.find((s) => s.id === "uber");
if (!uberBase) throw new Error("src/shared/sources.ts: uber source not found");

function makeItems(n: number, startIndex = 0): ListingItem[] {
  return Array.from({ length: n }, (_, i) => {
    const idx = startIndex + i;
    return {
      url: `https://www.uber.com/us/en/blog/article-${idx}/`,
      title: `Article number ${idx} with a sufficiently descriptive title`,
      publishedAt: Date.parse("2026-01-01T00:00:00Z") + idx * 60_000,
    };
  });
}

beforeEach(async () => {
  const db = getDb();
  await db.delete();
  await db.open();
});

describe("upsertSources (§8-2 / §9.5)", () => {
  it("preserves listingSeenIds, etag, and lastFetchMode from the previously stored source on re-upsert", async () => {
    const db = getDb();
    const previous: Source = {
      ...uberBase,
      initialized: true,
      etag: "W/\"abc123\"",
      lastFetchMode: "listing",
      listingSeenIds: ["seen-1", "seen-2", "seen-3"],
      lastStatus: "ok",
      lastItemCount: 3,
    };
    await db.sources.put(previous);

    const merged = await upsertSources(settings);
    const uber = merged.find((s) => s.id === "uber");
    expect(uber).toBeDefined();
    expect(uber?.listingSeenIds).toEqual(["seen-1", "seen-2", "seen-3"]);
    expect(uber?.etag).toBe('W/"abc123"');
    expect(uber?.lastFetchMode).toBe("listing");
    expect(uber?.initialized).toBe(true);

    // and it's actually persisted, not just returned in-memory
    const stored = await db.sources.get("uber");
    expect(stored?.listingSeenIds).toEqual(["seen-1", "seen-2", "seen-3"]);
  });

  it("leaves listingSeenIds undefined for a source with no prior row (first run)", async () => {
    const merged = await upsertSources(settings);
    const uber = merged.find((s) => s.id === "uber");
    expect(uber?.listingSeenIds).toBeUndefined();
    expect(uber?.initialized).toBe(false);
  });
});

/**
 * commitListingItems updates the source row via db.sources.update(id, ...), which (per Dexie)
 * is a no-op if no row with that id exists yet. In the real pipeline, upsertSources always runs
 * first and creates the row, so tests replicate that by seeding db.sources before committing.
 */
async function seedSource(source: Source): Promise<void> {
  await getDb().sources.put(source);
}

describe("commitListingItems (§9.5)", () => {
  it("registers only the first (document-order) item and marks all items seen when the source is uninitialized", async () => {
    const source: Source = { ...uberBase, initialized: false, listingSeenIds: undefined };
    await seedSource(source);
    const items = makeItems(5);

    const added = await commitListingItems(source, settings, items);
    expect(added).toBe(1);

    const db = getDb();
    const articles = await db.articles.where("sourceId").equals("uber").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe(items[0].url);
    expect(articles[0].title).toBe(items[0].title);
    expect(articles[0].status).toBe("new");
    expect(articles[0].contentSource).toBe("none");
    expect(articles[0].rssSummary).toBeUndefined();

    const stored = await db.sources.get("uber");
    expect(stored?.initialized).toBe(true);
    // all 5 extracted items are recorded as "seen", not just the 1 that was registered
    expect(stored?.listingSeenIds).toHaveLength(5);
    for (const item of items) {
      const id = await (await import("../src/lib/hash")).sha256Hex(
        (await import("../src/lib/urlNormalize")).normalizeUrl(item.url),
      );
      expect(stored?.listingSeenIds).toContain(id);
    }
    expect(stored?.lastFetchMode).toBe("listing");
  });

  it("treats an initialized source with listingSeenIds undefined the same as uninitialized (registers only the first item)", async () => {
    // §9.5: seen 未設定の初期化済みソース（旧版からの移行や seen 消失時）は安全側に倒し、
    // 先頭1件だけ登録する。
    const source: Source = { ...uberBase, initialized: true, listingSeenIds: undefined };
    await seedSource(source);
    const items = makeItems(4);

    const added = await commitListingItems(source, settings, items);
    expect(added).toBe(1);

    const db = getDb();
    const articles = await db.articles.where("sourceId").equals("uber").toArray();
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe(items[0].url);

    const stored = await db.sources.get("uber");
    expect(stored?.listingSeenIds).toHaveLength(4);
  });

  it("registers only items not already in listingSeenIds when the source is initialized with seen ids", async () => {
    const { sha256Hex } = await import("../src/lib/hash");
    const { normalizeUrl } = await import("../src/lib/urlNormalize");

    const items = makeItems(4); // article-0..3
    const alreadySeenIds = await Promise.all(
      items.slice(0, 2).map((item) => sha256Hex(normalizeUrl(item.url))), // article-0, article-1 already seen
    );
    const source: Source = { ...uberBase, initialized: true, listingSeenIds: alreadySeenIds };
    await seedSource(source);

    const added = await commitListingItems(source, settings, items);
    expect(added).toBe(2); // only article-2 and article-3 are new

    const db = getDb();
    const articles = await db.articles.where("sourceId").equals("uber").toArray();
    expect(articles.map((a) => a.url).sort()).toEqual(
      [items[2].url, items[3].url].sort(),
    );

    const stored = await db.sources.get("uber");
    expect(stored?.listingSeenIds).toHaveLength(4); // all 4 are now seen
  });

  it("truncates listingSeenIds to LISTING_SEEN_MAX, dropping the oldest ids first", async () => {
    const { sha256Hex } = await import("../src/lib/hash");
    const { normalizeUrl } = await import("../src/lib/urlNormalize");

    // Start with LISTING_SEEN_MAX - 2 previously-seen ids, oldest first.
    const startCount = LISTING_SEEN_MAX - 2;
    const oldIds = await Promise.all(
      Array.from({ length: startCount }, (_, i) => sha256Hex(`https://www.uber.com/us/en/blog/old-${i}/`)),
    );
    const source: Source = { ...uberBase, initialized: true, listingSeenIds: oldIds };
    await seedSource(source);

    // Commit 5 new items -> total would be startCount + 5 = LISTING_SEEN_MAX + 3, so the 3
    // oldest ids (old-0, old-1, old-2) must be dropped.
    const newItems = makeItems(5, 1000);
    await commitListingItems(source, settings, newItems);

    const db = getDb();
    const stored = await db.sources.get("uber");
    expect(stored?.listingSeenIds).toHaveLength(LISTING_SEEN_MAX);

    const oldest3 = oldIds.slice(0, 3);
    for (const id of oldest3) {
      expect(stored?.listingSeenIds).not.toContain(id);
    }
    // the newest of the old ids and all the new ids must still be present
    expect(stored?.listingSeenIds).toContain(oldIds[oldIds.length - 1]);
    for (const item of newItems) {
      const id = await sha256Hex(normalizeUrl(item.url));
      expect(stored?.listingSeenIds).toContain(id);
    }
  });
});
