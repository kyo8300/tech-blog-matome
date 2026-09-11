// 記事URLを重複排除キー生成のために正規化する。
// host小文字化・hash除去・追跡用クエリ除去・末尾スラッシュ除去・http→https を行う。冪等。

/** 除去対象の追跡用クエリパラメータ名（"utm_" で始まるものは prefix 一致） */
const TRACKING_PARAM_NAMES = new Set(["source", "ref", "mkt_tok", "fbclid", "gi"]);

function isTrackingParam(name: string): boolean {
  return name.startsWith("utm_") || TRACKING_PARAM_NAMES.has(name);
}

/**
 * URL文字列を正規化する。パースできない入力は trim した文字列をそのまま返す。
 * - host を小文字化
 * - hash（#以降）を除去
 * - utm_* / source / ref / mkt_tok / fbclid / gi のクエリパラメータを除去（残りは保持）
 * - 末尾スラッシュを除去（パスが "/" だけの場合も除去し、"https://host" にする）
 * - http: を https: にする
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  const host = url.host.toLowerCase();
  url.hash = "";

  const keysToDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (isTrackingParam(key) && !keysToDelete.includes(key)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }
  const search = url.searchParams.toString();

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === "/") {
    pathname = "";
  }

  return `${url.protocol}//${host}${pathname}${search ? `?${search}` : ""}`;
}
