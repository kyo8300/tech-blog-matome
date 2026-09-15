import { describe, expect, it } from "vitest";
import { findDateTexts } from "../src/lib/dateText";

describe("findDateTexts", () => {
  it("converts 'Sep 2, 2026' to epoch ms (UTC midnight)", () => {
    const result = findDateTexts("Posted on Sep 2, 2026 by the team.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts 'September 2, 2026' (full month name) to epoch ms", () => {
    const result = findDateTexts("Published September 2, 2026.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts 'Sept. 2, 2026' (abbreviation with a trailing period) to epoch ms", () => {
    const result = findDateTexts("Updated Sept. 2, 2026 after review.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts '2 Sep 2026' (day-month-year) to epoch ms", () => {
    const result = findDateTexts("2 Sep 2026 — new release notes.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts '2 September 2026' (day-fullmonth-year) to epoch ms", () => {
    const result = findDateTexts("2 September 2026 — new release notes.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts '2026-09-02' (ISO date, no time) to epoch ms", () => {
    const result = findDateTexts("datePublished: 2026-09-02");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("converts '2026/09/02' (slash date) to epoch ms", () => {
    const result = findDateTexts("Filed under 2026/09/02 in the archive.");
    expect(result).toEqual([Date.UTC(2026, 8, 2)]);
  });

  it("counts an ISO datetime with a time component ('2026-09-02T10:00:00Z') as exactly one match", () => {
    const result = findDateTexts("<time>2026-09-02T10:00:00Z</time> published");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(Date.parse("2026-09-02T10:00:00Z"));
    // The time-of-day must be preserved, not truncated to UTC midnight.
    expect(result[0]).not.toBe(Date.UTC(2026, 8, 2));
  });

  it("counts an ISO datetime with fractional seconds as exactly one match", () => {
    const result = findDateTexts("published at 2026-09-02T10:00:00.500Z exactly");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(Date.parse("2026-09-02T10:00:00.500Z"));
  });

  it("returns both dates in document order (not chronological order) when two distinct dates appear", () => {
    const result = findDateTexts("Originally published Aug 13, 2024. Updated Sep 2, 2026.");
    expect(result).toEqual([Date.UTC(2024, 7, 13), Date.UTC(2026, 8, 2)]);
    expect(result).toHaveLength(2);
  });

  it("returns dates in the order they occur even when the later text has the earlier date", () => {
    const result = findDateTexts("Sep 2, 2026 (revision of the original Aug 13, 2024 post).");
    expect(result).toEqual([Date.UTC(2026, 8, 2), Date.UTC(2024, 7, 13)]);
  });

  it("does not pick up a bare 'MM/DD' with no year, such as '12/31'", () => {
    const result = findDateTexts("Offer valid through 12/31 only.");
    expect(result).toEqual([]);
  });

  it("does not pick up a US-style phone number", () => {
    const result = findDateTexts("Contact support at 1-800-555-0199 for help.");
    expect(result).toEqual([]);
  });

  it("does not pick up a phone number formatted with parentheses and a dash", () => {
    const result = findDateTexts("Call (415) 555-0187 between 9 and 5.");
    expect(result).toEqual([]);
  });

  it("returns an empty array for text with no date-like content", () => {
    const result = findDateTexts("This is a plain sentence with no dates in it at all.");
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(findDateTexts("")).toEqual([]);
  });

  it("is case-insensitive for month names", () => {
    const result = findDateTexts("posted SEP 2, 2026 and also sep 2, 2026");
    expect(result).toEqual([Date.UTC(2026, 8, 2), Date.UTC(2026, 8, 2)]);
  });

  it("does not treat a 4-digit year alone as a date", () => {
    const result = findDateTexts("Copyright 2026 Acme Corp. All rights reserved.");
    expect(result).toEqual([]);
  });

  it("does not match an invalid calendar date such as month 13 or day 32 (numeric formats)", () => {
    // 2026-13-01 is not a real date (month 13); 2026/02/30 is not a real date (Feb has no 30th).
    const result = findDateTexts("bad dates: 2026-13-01 and 2026/02/30");
    expect(result).toEqual([]);
  });

  it("converts an ISO datetime with a '+09:00' offset to the correct UTC epoch (not the local wall-clock value)", () => {
    const result = findDateTexts("logged 2026-09-02T10:00:00+09:00 in the audit trail");
    expect(result).toEqual([Date.parse("2026-09-02T10:00:00+09:00")]);
    // 09:00 JST (+09:00) is 01:00 UTC the same day — must not be treated as 10:00 UTC.
    expect(result[0]).toBe(Date.UTC(2026, 8, 2, 1, 0, 0));
  });

  it("converts an ISO datetime with a '-0700' offset (no colon) to the correct UTC epoch", () => {
    const result = findDateTexts("logged 2026-09-02T10:00:00-0700 in the audit trail");
    expect(result).toEqual([Date.parse("2026-09-02T10:00:00-0700")]);
    // 10:00 -07:00 is 17:00 UTC the same day.
    expect(result[0]).toBe(Date.UTC(2026, 8, 2, 17, 0, 0));
  });

  it("treats an ISO datetime with no offset as UTC rather than the local timezone", () => {
    const result = findDateTexts("logged 2026-09-02T10:00:00 with no zone marker");
    expect(result).toEqual([Date.UTC(2026, 8, 2, 10, 0, 0)]);
  });

  it("does not treat a year below 1990 as a date (numeric formats)", () => {
    const result = findDateTexts("archived as 0120-09-02 and also 1980/09/02");
    expect(result).toEqual([]);
  });

  it("does not treat a year more than one year in the future as a date (numeric formats)", () => {
    const futureYear = new Date().getUTCFullYear() + 2;
    const result = findDateTexts(`scheduled for ${futureYear}-09-02 and ${futureYear}/09/02`);
    expect(result).toEqual([]);
  });

  it("does not treat an out-of-range year as a date for the month-name formats either", () => {
    const futureYear = new Date().getUTCFullYear() + 2;
    const result = findDateTexts(`Sep 2, 1985 and Sep 2, ${futureYear} are both out of range`);
    expect(result).toEqual([]);
  });

  it("finds one match per distinct date-bearing sentence across multiple formats mixed in one text", () => {
    const text = [
      "Originally posted Sep 2, 2026.",
      "Cross-posted 2 Sep 2026 on the mirror.",
      "Indexed as 2026-09-02 in the archive.",
      "Also filed under 2026/09/02.",
    ].join(" ");
    const result = findDateTexts(text);
    expect(result).toEqual([
      Date.UTC(2026, 8, 2),
      Date.UTC(2026, 8, 2),
      Date.UTC(2026, 8, 2),
      Date.UTC(2026, 8, 2),
    ]);
    expect(result).toHaveLength(4);
  });
});
