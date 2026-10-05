export const approxTokens = (s) => Math.ceil((s ?? '').length / 4);

// Runs `fn(item)` over `items` with at most `limit` in flight, preserving order in the result.
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

