import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, pickModels } from '../src/config.mjs';
import { fetchRetry, isRetryableStatus, isTransientError, sleep } from '../src/http.mjs';
import { EFFORT_MODELS, PRICES, effortConfig } from '../src/models.mjs';
import { anthropicCall, openaiCall } from '../src/providers.mjs';
import { mapConcurrent } from '../src/text.mjs';
import { makeUsageLog } from '../src/usage.mjs';

describe('providers', () => {
  test('triage and checker are OpenAI, the writer is Anthropic, and both keys are required', () => {
    const models = pickModels({ anthropic: 'a', openai: 'o' });
    assert.deepEqual(models.triage, { provider: 'openai', model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(models.writer, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' });
    assert.deepEqual(models.checker, { provider: 'openai', model: 'gpt-6-sol', effort: 'medium' });
    assert.throws(() => pickModels({ anthropic: 'a' }), /OPENAI_API_KEY/);
    assert.throws(() => pickModels({ openai: 'o' }), /ANTHROPIC_API_KEY/);
    assert.throws(() => pickModels({}), /Missing required env var/);
  });
  test('every model in DEFAULTS is priced and effort-gated correctly', () => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!k.endsWith('_model')) continue;
      assert.ok(PRICES[v], `${v} priced`);
      if (v.startsWith('claude-')) assert.ok(EFFORT_MODELS.test(v), `${v} accepts effort`);
    }
    assert.deepEqual(effortConfig('claude-opus-5-5', 'medium'), { output_config: { effort: 'medium' } });
    assert.deepEqual(effortConfig('claude-haiku-4-5', 'low'), {});
  });
});

const sseResponse = (events) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      c.close();
    },
  });
  return { ok: true, status: 200, body };
};

describe('model calls over fetch', () => {
  test('streaming writer call accumulates only text deltas and reads usage from both ends', async () => {
    let sent;
    const fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '````markdown\n# A\n' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '````' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
        { type: 'message_stop' },
      ]);
    };
    const r = await anthropicCall({
      fetch,
      apiKey: 'k',
      model: 'claude-opus-5',
      system: 'S',
      blocks: [{ text: 'prefix', cache: true }, { text: 'doc' }],
      maxTokens: 32_000,
      effort: 'medium',
      stream: true,
    });
    assert.equal(r.text, '````markdown\n# A\n````');
    assert.deepEqual(r.usage, { input: 100, cacheRead: 5000, cacheWrite: 0, output: 40 });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(sent.messages[0].content[1].cache_control, undefined);
    assert.deepEqual(sent.output_config, { effort: 'medium' });
    assert.equal(sent.thinking, undefined, 'adaptive by default on these models');
  });

  test('non-streaming call and error surfacing', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 10, output_tokens: 2 }, stop_reason: 'end_turn' }) });
    const r = await anthropicCall({ fetch, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 100, effort: 'low' });
    assert.equal(r.text, '{"a":1}');
    const bad = async () => ({ ok: false, status: 401, text: async () => 'nope' });
    await assert.rejects(() => anthropicCall({ fetch: bad, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 100 }), /Anthropic 401: nope/);
  });

  test('openai responses call', async () => {
    let sent;
    const fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"files":[]}' }] }], usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } }, status: 'completed' }) };
    };
    const r = await openaiCall({ fetch, apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'a' }, { text: 'b' }], maxTokens: 100, effort: 'low' });
    assert.equal(r.text, '{"files":[]}');
    assert.deepEqual(r.usage, { input: 30, cacheRead: 20, cacheWrite: 0, output: 5 });
    assert.equal(sent.input[1].content, 'a\n\nb');
    assert.deepEqual(sent.reasoning, { effort: 'low' });
  });

  test('failures carry their status; outages are transient, request problems and timeouts are not', async () => {
    const bad = (status) => async () => ({ ok: false, status, text: async () => 'x' });
    const err = (p) => p.then(() => null, (e) => e);
    const a400 = await err(anthropicCall({ fetch: bad(400), apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 1 }));
    const o529 = await err(openaiCall({ fetch: bad(529), apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'x' }], maxTokens: 1, retry: { retries: 0 } }));
    assert.equal(a400.status, 400);
    assert.equal(isTransientError(a400), false);
    assert.equal(isTransientError(o529), true);
    assert.equal(isTransientError(new TypeError('fetch failed')), true);
    assert.equal(isTransientError(Object.assign(new Error('t'), { name: 'TimeoutError' })), false);
  });

  test('both providers report truncation by the output budget', async () => {
    const oa = (reason) => async () => ({ ok: true, status: 200, json: async () => ({ output: [], usage: {}, status: reason ? 'incomplete' : 'completed', ...(reason ? { incomplete_details: { reason } } : {}) }) });
    const call = (f) => openaiCall({ fetch: f, apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'a' }], maxTokens: 1 });
    assert.equal((await call(oa('max_output_tokens'))).truncated, true);
    assert.equal((await call(oa('content_filter'))).truncated, false);
    assert.equal((await call(oa())).truncated, false);
    const an = (stop_reason) => async () => ({ ok: true, status: 200, json: async () => ({ content: [], usage: {}, stop_reason }) });
    const acall = (f) => anthropicCall({ fetch: f, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'a' }], maxTokens: 1 });
    assert.equal((await acall(an('max_tokens'))).truncated, true);
    assert.equal((await acall(an('end_turn'))).truncated, false);
  });

  test('usage log prices Opus 5.5 cache reads at 5% and reports unpriced models', () => {
    const lines = [];
    const warns = [];
    const u = makeUsageLog((l) => lines.push(l), (w) => warns.push(w));
    u.log('writer', 'claude-opus-5-5', { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000 });
    assert.equal(u.total().toFixed(2), (4 + 0.2 + 2).toFixed(2));
    u.log('x', 'mystery', { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    assert.equal(warns.length, 1);
    assert.deepEqual(u.unpriced(), ['mystery']);
    assert.match(lines[0], /\[cost\] writer \(claude-opus-5-5\)/);
  });

  test('mapConcurrent bounds parallelism and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return n * 2;
    });
    assert.deepEqual(r, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 3);
  });
});

describe('retries', () => {
  const res = (status, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), body: null, text: async () => String(status) });

  test('one retry on 5xx, 429 and 529, honouring Retry-After; 4xx is final', async () => {
    assert.ok(isRetryableStatus(500) && isRetryableStatus(529) && isRetryableStatus(429));
    assert.ok(!isRetryableStatus(401) && !isRetryableStatus(422));
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    let calls = 0;
    const flaky = async (url, init) => {
      assert.ok(init.signal instanceof AbortSignal, 'a timeout signal on every attempt');
      return ++calls === 1 ? res(529, { 'retry-after': '2' }) : res(200);
    };
    assert.equal((await fetchRetry(flaky, 'u', {}, { timeoutMs: 1000, sleep })).status, 200);
    assert.deepEqual(waits, [2000]);

    calls = 0;
    const down = async () => (calls++, res(503));
    assert.equal((await fetchRetry(down, 'u', {}, { timeoutMs: 1000, sleep })).status, 503, 'the second failure is returned, not retried again');
    assert.equal(calls, 2);

    calls = 0;
    const denied = async () => (calls++, res(401));
    assert.equal((await fetchRetry(denied, 'u', {}, { timeoutMs: 1000, sleep })).status, 401);
    assert.equal(calls, 1);
  });

  test('network errors retry once, timeouts never', async () => {
    const sleep = async () => {};
    let calls = 0;
    const reset = async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return res(200);
    };
    assert.equal((await fetchRetry(reset, 'u', {}, { timeoutMs: 1000, sleep })).status, 200);
    calls = 0;
    const slow = async () => {
      calls++;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    await assert.rejects(() => fetchRetry(slow, 'u', {}, { timeoutMs: 1000, sleep }), /timed out/);
    assert.equal(calls, 1);
  });

  test('model calls go through the retry', async () => {
    let calls = 0;
    const fetch = async () =>
      ++calls === 1
        ? res(529)
        : { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) };
    const r = await anthropicCall({ fetch, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 10, retry: { sleep: async () => {} } });
    assert.equal(r.text, 'hi');
    assert.equal(calls, 2);
  });
});
