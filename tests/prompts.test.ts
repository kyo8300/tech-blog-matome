import { describe, expect, it } from "vitest";
import { SUMMARY_SYSTEM, buildSummaryUser, buildChatSystem, summaryAsText } from "../src/lib/prompts";
import type { Summary } from "../src/shared/types";

const article = {
  title: "Scaling Our Database Layer",
  url: "https://example.com/blog/scaling-database-layer",
  publishedAt: Date.parse("2026-09-01T09:00:00.000Z"),
  sourceName: "Example Tech Blog",
};

describe("SUMMARY_SYSTEM", () => {
  it("is a non-empty fixed Japanese system prompt", () => {
    expect(typeof SUMMARY_SYSTEM).toBe("string");
    expect(SUMMARY_SYSTEM.length).toBeGreaterThan(0);
  });

  it("instructs the model to note when the summary is based on the RSS excerpt only", () => {
    expect(SUMMARY_SYSTEM).toContain("（本文を取得できなかったためRSSの概要に基づく要約）");
  });

  it("describes all five Summary fields", () => {
    for (const field of ["headline", "brief", "digest", "detail", "tags"]) {
      expect(SUMMARY_SYSTEM).toContain(field);
    }
  });
});

describe("buildSummaryUser", () => {
  const text = "これは記事本文のテキストです。".repeat(5);

  it("includes the article metadata", () => {
    const prompt = buildSummaryUser(article, text, "page", 10_000);
    expect(prompt).toContain(article.title);
    expect(prompt).toContain(article.url);
    expect(prompt).toContain(article.sourceName);
  });

  it("wraps the article text in an <article> block", () => {
    const prompt = buildSummaryUser(article, text, "page", 10_000);
    expect(prompt).toContain("<article>");
    expect(prompt).toContain("</article>");
    const start = prompt.indexOf("<article>");
    const end = prompt.indexOf("</article>");
    expect(prompt.slice(start, end)).toContain(text);
  });

  it('marks contentSource "page" as ページ本文', () => {
    const prompt = buildSummaryUser(article, text, "page", 10_000);
    expect(prompt).toContain("本文の取得元: ページ本文");
  });

  it('marks contentSource "rss" as RSS概要', () => {
    const prompt = buildSummaryUser(article, text, "rss", 10_000);
    expect(prompt).toContain("本文の取得元: RSS概要");
  });

  it('marks contentSource "none" as なし', () => {
    const prompt = buildSummaryUser(article, text, "none", 10_000);
    expect(prompt).toContain("本文の取得元: なし");
  });

  it("truncates the article text to maxChars", () => {
    const longText = "あ".repeat(5000);
    const prompt = buildSummaryUser(article, longText, "page", 100);
    const start = prompt.indexOf("<article>");
    const end = prompt.indexOf("</article>");
    const articleBlock = prompt.slice(start + "<article>".length, end);
    // The full 5000-char text must not appear verbatim; the block should be
    // meaningfully shorter than the untruncated input.
    expect(articleBlock.length).toBeLessThan(longText.length);
    expect(prompt).not.toContain(longText);
  });

  it("does not truncate text shorter than maxChars", () => {
    const shortText = "短い本文です。";
    const prompt = buildSummaryUser(article, shortText, "page", 10_000);
    expect(prompt).toContain(shortText);
  });
});

describe("buildChatSystem", () => {
  it("includes article metadata and wraps the content in <article>", () => {
    const contentText = "記事の本文テキストがここに入ります。";
    const system = buildChatSystem(article, contentText);
    expect(system).toContain(article.title);
    expect(system).toContain(article.url);
    expect(system).toContain("<article>");
    expect(system).toContain("</article>");
    expect(system).toContain(contentText);
  });
});

describe("summaryAsText", () => {
  const summary: Summary = {
    headline: "見出しテキスト",
    brief: "ざっくり紹介の文章です。",
    digest: ["要点1", "要点2", "要点3"],
    detail: "詳しい解説の本文です。",
    tags: ["Database", "Scalability"],
  };

  it("renders the narrative fields of the summary as text", () => {
    const text = summaryAsText(summary);
    expect(text).toContain(summary.headline);
    expect(text).toContain(summary.brief);
    for (const item of summary.digest) {
      expect(text).toContain(item);
    }
    expect(text).toContain(summary.detail);
  });
});
