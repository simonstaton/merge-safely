/**
 * A tiny promise concurrency limiter (no dependency). `mapLimit` preserves input order in its result, so seat
 * ordering stays deterministic however the runs interleave.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return results;
}
