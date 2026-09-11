// 記事ページのHTML取得。content-type が text/html でなければ null、maxBytes で打ち切る。

/** 記事ページのHTMLを取得する。text/html でないレスポンスは null を返す */
export async function fetchArticleHtml(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return null;
    }

    if (!res.body) {
      return await res.text();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytesRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        text += decoder.decode(value);
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
