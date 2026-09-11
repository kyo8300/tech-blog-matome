import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/lib/concurrency";

describe("mapLimit", () => {
  it("applies fn to every item and preserves order", async () => {
    const results = await mapLimit([1, 2, 3], 2, async (n) => n * 2);
    expect(results).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
      { status: "fulfilled", value: 6 },
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapLimit(items, 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("captures rejections per item without aborting the rest", async () => {
    const results = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("clamps a NaN limit to 1 instead of running zero workers", async () => {
    const results = await mapLimit([1, 2, 3], NaN, async (n) => n);
    expect(results).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
    ]);
  });

  it("clamps a non-finite (Infinity) limit to a usable worker count", async () => {
    const results = await mapLimit([1, 2], Infinity, async (n) => n);
    expect(results).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("clamps limit below 1 to 1", async () => {
    const results = await mapLimit([1, 2], 0, async (n) => n);
    expect(results).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("returns an empty array for empty input", async () => {
    const results = await mapLimit([] as number[], 3, async (n) => n);
    expect(results).toEqual([]);
  });
});
