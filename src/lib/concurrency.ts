// 配列に対して並列上限つきで非同期処理を実行するユーティリティ（ワーカープール方式）。

/**
 * items の各要素に fn を適用する。同時実行数は limit で上限をかける（最低1にクランプ）。
 * 各要素の成功/失敗にかかわらず全件処理を終えるまで待ち、Promise.allSettled と同じ形の結果配列を返す。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const workerCount = Math.max(1, Math.min(clampedLimit, items.length || 1));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        const value = await fn(items[index]!, index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}
