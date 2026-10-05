// Parses an SSE byte stream into event data objects. Async generator over a web ReadableStream.
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        // keep-alive or partial line
      }
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 529 is Anthropic's "overloaded".
export const isRetryableStatus = (status) => status === 429 || status === 529 || (status >= 500 && status <= 599);

// An outage rather than something about the request: a retryable status or a network error. A
// timeout is not, since a long doc times out every time.
export const isTransientError = (e) =>
  e?.status == null ? e?.name !== 'TimeoutError' && e?.name !== 'AbortError' : isRetryableStatus(e.status);

// One retry on 5xx/429/529 or a network error, honouring Retry-After up to `maxDelayMs`. Each
// attempt gets its own timeout. A timeout is not retried: it already spent the whole budget.
export async function fetchRetry(f, url, init, { timeoutMs, retries = 1, baseDelayMs = 3000, maxDelayMs = 30_000, sleep: wait = sleep, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const backoff = baseDelayMs * 2 ** attempt;
    let res;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt >= retries || e?.name === 'TimeoutError' || e?.name === 'AbortError') throw e;
      onRetry(`network error (${e?.message ?? e}); retrying in ${backoff} ms`);
      await wait(backoff);
      continue;
    }
    if (attempt >= retries || !isRetryableStatus(res.status)) return res;
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    const delay = Math.min(maxDelayMs, retryAfter > 0 ? retryAfter * 1000 : backoff);
    await res.body?.cancel?.().catch(() => {});
    onRetry(`HTTP ${res.status}; retrying in ${delay} ms`);
    await wait(delay);
  }
}
