// IndexedDB（Dexie 4）。sources / articles / chats を保持する。
// モジュールトップでは open せず、getDb() で遅延インスタンス化する。

import Dexie, { type EntityTable } from "dexie";
import type { Article, ChatThread, Source } from "./types";

export class AppDB extends Dexie {
  sources!: EntityTable<Source, "id">;
  articles!: EntityTable<Article, "id">;
  chats!: EntityTable<ChatThread, "articleId">;

  constructor() {
    super("tech-blog-matome");
    this.version(1).stores({
      sources: "id",
      articles: "id, sourceId, publishedAt, status, createdAt, [sourceId+publishedAt]",
      chats: "articleId, updatedAt",
    });
  }
}

let instance: AppDB | null = null;

/** AppDB のシングルトンを遅延生成して返す */
export function getDb(): AppDB {
  if (!instance) {
    instance = new AppDB();
  }
  return instance;
}
