import { MAX_RESPONSE_TOKENS, REVIEW_EFFORT } from './config.mjs';

const API = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    version: '2023-06-01',
    messagesPath: '/v1/messages',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    responsesPath: '/v1/responses',
  },
};

// `output_config.effort` is rejected by Haiku 4.5, Sonnet 4.5 and older.
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-(5|4-[5-8])|sonnet-(5|4-6))\b/;
// `reasoning.effort` is only accepted by OpenAI reasoning models.
const REASONING_MODELS = /^(gpt-[5-9]|o\d)\b/;

// Anything that is not a Claude model is sent to OpenAI.
export const isAnthropicModel = (model) => model.startsWith('claude-');

// Request-body fragment carrying `effort` in the shape the model's provider
// expects, or {} when the model does not accept one.
export function effortConfig(model, effort = REVIEW_EFFORT) {
  if (isAnthropicModel(model)) return EFFORT_MODELS.test(model) ? { output_config: { effort } } : {};
  return REASONING_MODELS.test(model) ? { reasoning: { effort } } : {};
}

// Prices in $/MTok, printed to the Actions log and tabled in the posted review.
// Keep this in sync with DEFAULTS (anthropic_model / openai_model / synth_model):
// consumer repos cannot set a model, so this file is the only place.
// Cache reads default to a tenth of input; `cacheRead` overrides that fraction.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.05 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'gpt-6-sol': { in: 2, out: 10 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-5.3-codex': { in: 1.75, out: 14 },
  'gpt-5.4-2026-03-05': { in: 2.5, out: 15 },
  'gpt-5.6-terra': { in: 2.5, out: 15 },
};

// Normalized to { input, cacheRead, output }: `input` excludes cached tokens.
const anthropicUsage = (u) => ({
  input: u?.input_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});
const openaiUsage = (u) => {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return { input: (u?.input_tokens ?? 0) - cached, cacheRead: cached, output: u?.output_tokens ?? 0 };
};

// Dollars for one call, or null when the model has no price.
export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p) return null;
  return (usage.input * p.in + usage.cacheRead * p.in * (p.cacheRead ?? 0.1) + usage.output * p.out) / 1e6;
}

export function makeUsageLog({ log = console.log, warn = console.warn } = {}) {
  const entries = [];
  const unpriced = new Set();
  const total = () => entries.reduce((s, e) => s + (e.cost ?? 0), 0);
  const unpricedNote = () => (unpriced.size ? ` (excludes unpriced model(s): ${[...unpriced].join(', ')})` : '');
  return {
    entries,
    total,
    unpricedNote,
    log(label, model, usage) {
      const cost = costOf(model, usage);
      entries.push({ label, model, ...usage, cost });
      const line = `${usage.input} in / ${usage.cacheRead} cached / ${usage.output} out`;
      if (cost == null) {
        // No price configured: the cost estimate excludes this model.
        if (!unpriced.has(model)) {
          unpriced.add(model);
          warn(
            `[cost] ⚠️  No price configured for model "${model}". Its usage is excluded ` +
              `from the total estimate -- add it to PRICES in tools/ai-review/src/llm.mjs.`
          );
        }
        log(`[cost] ${label} (${model}): ${line} ≈ $? (price unknown)`);
        return;
      }
      log(`[cost] ${label} (${model}): ${line} ≈ $${cost.toFixed(4)}`);
    },
    // Markdown section for the posted review; every call made so far, one row each.
    table() {
      if (!entries.length) return [];
      const cost = (e) => (e.cost == null ? '?' : `$${e.cost.toFixed(4)}`);
      return [
        '',
        '#### API usage',
        '| Call | Model | In | Cached | Out | Cost |',
        '| --- | --- | --- | --- | --- | --- |',
        ...entries.map((e) => `| ${e.label} | ${e.model} | ${e.input} | ${e.cacheRead} | ${e.output} | ${cost(e)} |`),
        '',
        `Total ~$${total().toFixed(4)}${unpricedNote()}`,
      ];
    },
  };
}

// One user turn on the model's provider. Returns { text, usage, stopReason, outputTokens }.
export async function callModel({ model, apiKey, system, prompt, effort, maxTokens = MAX_RESPONSE_TOKENS }) {
  if (isAnthropicModel(model)) {
    const res = await fetch(`${API.anthropic.baseUrl}${API.anthropic.messagesPath}`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API.anthropic.version, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...effortConfig(model, effort),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      usage: anthropicUsage(data.usage),
      stopReason: data.stop_reason,
      outputTokens: data.usage?.output_tokens,
    };
  }
  const res = await fetch(`${API.openai.baseUrl}${API.openai.responsesPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_output_tokens: maxTokens,
      ...effortConfig(model, effort),
      input: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text:
      (data.output ?? [])
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('') ||
      data.output_text ||
      '',
    usage: openaiUsage(data.usage),
    stopReason: data.incomplete_details?.reason ?? data.status,
    outputTokens: data.usage?.output_tokens,
  };
}
