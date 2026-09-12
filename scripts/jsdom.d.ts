// jsdom は型定義を同梱しておらず、@types/jsdom も devDependencies に無い。
// scripts/check-feeds.ts で使う最小限のAPI（HTML文字列から Document を得る）だけをアンビエント宣言する。
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    window: { document: Document };
  }
}
