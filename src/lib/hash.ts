// 文字列の SHA-256 ハッシュ（16進数）を計算する純粋関数。
// Web Crypto API（globalThis.crypto.subtle）のみを使うため、ブラウザ・SW・Node 22 のいずれでも同じコードで動く。

/** 文字列を UTF-8 として SHA-256 ハッシュ化し、小文字16進数文字列で返す */
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
