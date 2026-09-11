import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/lib/htmlToText";

describe("htmlToText", () => {
  it("strips tags, keeping the text content", () => {
    expect(htmlToText("<p>Hello <strong>world</strong></p>")).toContain("Hello world");
    expect(htmlToText("<p>Hello <strong>world</strong></p>")).not.toContain("<");
    expect(htmlToText("<p>Hello <strong>world</strong></p>")).not.toContain(">");
  });

  it("converts <br> into a newline", () => {
    const out = htmlToText("Line one<br>Line two<br/>Line three");
    expect(out).toContain("Line one");
    expect(out).toContain("Line two");
    expect(out.split("\n").map((s) => s.trim())).toEqual(
      expect.arrayContaining(["Line one", "Line two", "Line three"]),
    );
  });

  it("converts </p> into a newline / paragraph break", () => {
    const out = htmlToText("<p>First paragraph.</p><p>Second paragraph.</p>");
    const lines = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(lines).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("decodes common HTML entities", () => {
    const out = htmlToText("<p>Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#39;apostrophe&#39; &nbsp;end</p>");
    expect(out).toContain("Tom & Jerry");
    expect(out).toContain("<3");
    expect(out).toContain('"quotes"');
    expect(out).toContain("'apostrophe'");
    expect(out).not.toContain("&amp;");
    expect(out).not.toContain("&lt;");
    expect(out).not.toContain("&quot;");
    expect(out).not.toContain("&#39;");
    expect(out).not.toContain("&nbsp;");
  });

  it("decodes numeric and Japanese entities", () => {
    const out = htmlToText("<p>&#12354;&#12356;&#x3046;</p>");
    expect(out).toContain("あいう");
  });

  it("removes <script> and <style> blocks entirely, including their content", () => {
    const out = htmlToText(
      "<style>.a{color:red}</style><p>Visible text</p><script>alert('should not appear')</script>",
    );
    expect(out).toContain("Visible text");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("should not appear");
  });

  it("collapses excess whitespace but keeps text readable", () => {
    const out = htmlToText("<p>  Hello   world  </p>");
    expect(out.trim()).toContain("Hello");
    expect(out).not.toMatch(/ {3,}/);
  });

  it("returns an empty-ish string for empty input", () => {
    expect(htmlToText("").trim()).toBe("");
  });

  it("removes HTML comments entirely, even when they contain '>'", () => {
    const out = htmlToText("<p>a</p><!-- comment with > inside --><p>b</p>");
    expect(out).not.toContain("comment with");
    expect(out).not.toContain("-->");
    expect(out.split("\n").map((s) => s.trim()).filter(Boolean)).toEqual(["a", "b"]);
  });
});
