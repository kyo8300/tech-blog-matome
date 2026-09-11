import { describe, expect, it } from "vitest";
import { SummarySchema, parseSummaryText } from "../src/lib/summarySchema";

const valid = {
  headline: "データベース層を10倍のトラフィックに対応させた話",
  brief: "大規模なリアーキテクチャの概要です。背景と結果を紹介します。3文構成の紹介文です。",
  digest: ["キャッシュ層を刷新した", "非同期処理へ移行した", "10倍のトラフィックに耐えられるようになった"],
  detail:
    "背景として既存のデータベース層はスケールの限界に近づいていた。\n課題はレイテンシとスループットの両立だった。\nアプローチとしてキャッシュと非同期化を採用した。\n結果として10倍のトラフィックに耐えられるようになった。",
  tags: ["Database", "Scalability"],
};

describe("SummarySchema", () => {
  it("accepts a fully valid object", () => {
    expect(SummarySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an object missing a required field", () => {
    const { headline, ...rest } = valid;
    expect(SummarySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an object with a wrong-typed field", () => {
    expect(SummarySchema.safeParse({ ...valid, digest: "not an array" }).success).toBe(false);
    expect(SummarySchema.safeParse({ ...valid, headline: 123 }).success).toBe(false);
    expect(SummarySchema.safeParse({ ...valid, tags: "Database" }).success).toBe(false);
  });
});

describe("parseSummaryText", () => {
  it("parses a plain JSON string", () => {
    const parsed = parseSummaryText(JSON.stringify(valid));
    expect(parsed).toEqual(valid);
  });

  it("parses JSON wrapped in surrounding prose", () => {
    const wrapped = `もちろんです、要約はこちらです:\n\n${JSON.stringify(valid)}\n\n以上です。`;
    const parsed = parseSummaryText(wrapped);
    expect(parsed).toEqual(valid);
  });

  it("parses JSON wrapped in a markdown code fence", () => {
    const wrapped = "```json\n" + JSON.stringify(valid, null, 2) + "\n```";
    const parsed = parseSummaryText(wrapped);
    expect(parsed).toEqual(valid);
  });

  it("throws on a field that is missing", () => {
    const { detail, ...rest } = valid;
    expect(() => parseSummaryText(JSON.stringify(rest))).toThrow();
  });

  it("throws on a field with the wrong type", () => {
    expect(() => parseSummaryText(JSON.stringify({ ...valid, digest: "not an array" }))).toThrow();
  });

  it("throws on input that contains no JSON at all", () => {
    expect(() => parseSummaryText("これはJSONではありません。")).toThrow();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseSummaryText("{ headline: 'missing quotes around keys' }")).toThrow();
  });
});
