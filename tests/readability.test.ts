// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readability } from "@mozilla/readability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("Readability against a jsdom document", () => {
  it("extracts at least 800 characters of article text, dropping nav/footer/sidebar noise", () => {
    const html = fixture("article.html");

    // Use the ambient jsdom document/window provided by the "@vitest-environment jsdom"
    // directive above (this file does not import or instantiate src/offscreen).
    document.open();
    document.write(html);
    document.close();

    const article = new Readability(document).parse();
    if (!article?.textContent) throw new Error("Readability failed to parse the fixture article");
    const text = article.textContent;

    expect(text.length).toBeGreaterThanOrEqual(800);
    expect(text).toContain("ingestion pipeline");
    expect(text).not.toContain("Advertisement placeholder");
    expect(text).not.toContain("Subscribe to our newsletter");
  });
});
