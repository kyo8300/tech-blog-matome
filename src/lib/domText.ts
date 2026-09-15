// テキスト日付探索（§10 / §9.5 規則4）で共有する、DOM 要素からの「掃除済みテキスト」抽出。
// src/lib/pageDate.ts と src/lib/listingExtract.ts の両方から使う。DOM API（Element/Node）
// だけに依存する純粋関数。

/** テキスト抽出から除外する要素名（中身は記事本文の日付とは無関係な文字列を含みうる） */
const TEXT_EXCLUDED_TAGS = new Set(["script", "style", "noscript", "template"]);

/**
 * el の子孫テキストを、script/style/noscript/template の中身を除き、要素境界に空白を1つ
 * 挟んで連結して返す。
 * 単純に el.textContent を使うと、空白の無い SSR/minify 出力（`<h1>Title</h1><p>Sep 2, 2026</p>`）で
 * `TitleSep 2, 2026` のように要素をまたいで連結されてしまい、月名形式の日付が単語境界を失って
 * 取りこぼされる（`findDateTexts` は `\b` で単語境界を要求するため）。そのため子孫を辿りながら
 * テキストノードごとに区切って集め、最後に空白1つで join する（同一テキストノード内の空白は
 * そのまま保持され、余分な連続空白は呼び出し側の normalizeWhitespace で1つに畳まれる）。
 */
export function cleanTextContent(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // Node.TEXT_NODE
        parts.push((child as Text).data);
      } else if (child.nodeType === 1) {
        // Node.ELEMENT_NODE
        const tag = (child as Element).tagName.toLowerCase();
        if (TEXT_EXCLUDED_TAGS.has(tag)) continue;
        walk(child);
      }
    }
  };
  walk(el);
  return parts.join(" ");
}
