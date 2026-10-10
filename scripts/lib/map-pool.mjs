// Bounded, input-order-preserving concurrency for independent gate I/O.
// Eight filesystem reads balance throughput against descriptor/thread-pool pressure on large
// waves. A smaller Git cap avoids multiplying object-store contention across processes.
export const PAGE_CONCURRENCY = 8;
export const GIT_CONCURRENCY = 4;

/** Run fn with at most limit items in flight and return results in input order. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
