import { API } from './api.mjs';
import { fetchRetry, parseSse } from './http.mjs';
import { effortConfig } from './models.mjs';

// One user turn. `blocks` is an array of { text, cache } where cache=true places a breakpoint.
export async function anthropicCall({ fetch: f, apiKey, model, system, blocks, maxTokens, effort, stream = false, timeoutMs = 600_000, retry = {} }) {
  const content = blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const body = {
    model,
    max_tokens: maxTokens,
    ...effortConfig(model, effort),
    system,
    messages: [{ role: 'user', content }],
    ...(stream ? { stream: true } : {}),
  };
  const res = await fetchRetry(
    f,
    `${API.anthropic.baseUrl}${API.anthropic.messagesPath}`,
    {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API.anthropic.version, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { timeoutMs, ...retry }
  );
  if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${await res.text()}`), { status: res.status });
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const readUsage = (u) => {
    if (!u) return;
    if (u.input_tokens != null) usage.input = u.input_tokens;
    if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens != null) usage.output = u.output_tokens;
  };
  if (!stream) {
    const data = await res.json();
    readUsage(data.usage);
    return {
      text: (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
      usage,
      stopReason: data.stop_reason,
      truncated: data.stop_reason === 'max_tokens',
    };
  }
  // Only text deltas reach the file; thinking deltas are dropped.
  let text = '';
  let stopReason = null;
  for await (const ev of parseSse(res.body)) {
    if (ev.type === 'message_start') readUsage(ev.message?.usage);
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
    else if (ev.type === 'message_delta') {
      readUsage(ev.usage);
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
    } else if (ev.type === 'error') throw Object.assign(new Error(`Anthropic stream error: ${JSON.stringify(ev.error ?? ev)}`), { status: 500 });
  }
  return { text, usage, stopReason, truncated: stopReason === 'max_tokens' };
}

export async function openaiCall({ fetch: f, apiKey, model, system, blocks, maxTokens, effort, timeoutMs = 600_000, retry = {} }) {
  const res = await fetchRetry(
    f,
    `${API.openai.baseUrl}${API.openai.responsesPath}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_output_tokens: maxTokens,
        ...(effort ? { reasoning: { effort } } : {}),
        input: [
          { role: 'system', content: system },
          { role: 'user', content: blocks.map((b) => b.text).join('\n\n') },
        ],
      }),
    },
    { timeoutMs, ...retry }
  );
  if (!res.ok) throw Object.assign(new Error(`OpenAI ${res.status}: ${await res.text()}`), { status: res.status });
  const data = await res.json();
  const text =
    (data.output ?? [])
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('') ||
    data.output_text ||
    '';
  const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    text,
    usage: { input: (data.usage?.input_tokens ?? 0) - cached, cacheRead: cached, cacheWrite: 0, output: data.usage?.output_tokens ?? 0 },
    stopReason: data.incomplete_details?.reason ?? data.status,
    truncated: data.incomplete_details?.reason === 'max_output_tokens',
  };
}
