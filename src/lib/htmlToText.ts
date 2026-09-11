// HTML文字列をプレーンテキストに変換する（DOM不要・正規表現ベース）。
// script/style/noscript/template を除去し、ブロック境界を改行に変換したうえでタグを取り除き、
// HTMLエンティティをデコードして空白を正規化する。

/** script/style/noscript/template を中身ごと除去するタグ名 */
const STRIP_BLOCK_TAGS = ["script", "style", "noscript", "template"];

/** 改行に変換する終了タグ（h1〜h6 は個別に追加） */
const BLOCK_CLOSE_TAGS = ["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = isHex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (Number.isNaN(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const lower = entity.toLowerCase();
    return lower in NAMED_ENTITIES ? NAMED_ENTITIES[lower]! : match;
  });
}

/** HTML文字列をプレーンテキストに変換する */
export function htmlToText(html: string): string {
  let s = html;

  // script/style/noscript/template を中身ごと除去
  for (const tag of STRIP_BLOCK_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    s = s.replace(re, "");
  }

  // HTMLコメントを除去（中に ">" を含むことがあり、後段のタグ除去より先に丸ごと取り除く必要がある）
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // <br> を改行に
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // ブロック終了タグを改行に
  for (const tag of BLOCK_CLOSE_TAGS) {
    const re = new RegExp(`<\\/${tag}\\s*>`, "gi");
    s = s.replace(re, "\n");
  }

  // 残りのタグを除去
  s = s.replace(/<[^>]+>/g, "");

  // エンティティのデコード
  s = decodeEntities(s);

  // 空白の正規化
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}
