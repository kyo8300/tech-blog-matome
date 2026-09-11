// アプリページを開く（ツールバーアイコン・通知クリック・OPEN_APP メッセージから共通で使う）。
// §12: 既に開いているアプリタブがあればそれをフォーカスして再利用する。`?article=<id>` のディープリンクに対応。

import { APP_PAGE } from "../shared/constants";

/** アプリページを開く。articleId を渡すと `?article=<id>` を付けて開く／該当タブへ遷移する */
export async function openApp(articleId?: string): Promise<void> {
  const baseUrl = chrome.runtime.getURL(APP_PAGE);
  const targetUrl = articleId ? `${baseUrl}?article=${encodeURIComponent(articleId)}` : baseUrl;

  const tabs = await chrome.tabs.query({ url: `${baseUrl}*` });
  const existing = tabs[0];

  if (existing?.id !== undefined) {
    // articleId が指定されていて、かつ現在の URL と異なるときだけ url を渡す
    // （無条件に url を渡すと同じページでも毎回リロードされてしまう）
    const updateProps: chrome.tabs.UpdateProperties =
      articleId !== undefined && existing.url !== targetUrl
        ? { active: true, url: targetUrl }
        : { active: true };
    await chrome.tabs.update(existing.id, updateProps);
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
}
