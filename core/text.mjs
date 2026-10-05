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


// The first JSON object in a model's answer, or null. Only an outer fence is stripped: fences
// inside string values are content (a suggested fix, a code sample).
export function parseJsonObject(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  }
}
