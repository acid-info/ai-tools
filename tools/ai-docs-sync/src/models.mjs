// $/MTok. Cache reads default to a tenth of input; `cacheRead` overrides that fraction.
// Cache writes are 1.25x input. Opus 5.5 reads are 5% ($0.20); its 5-minute writes stay at 1.25x.
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.05 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6-sol': { in: 2, out: 10 },
  'gpt-5.6-terra': { in: 2.5, out: 15 },
  'gpt-5.4-2026-03-05': { in: 2.5, out: 15 },
};

// `output_config.effort` is rejected by Haiku 4.5, Sonnet 4.5 and older.
export const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-(5-5|5|4-[5-8])|sonnet-(5|4-6))\b/;
export const effortConfig = (model, effort) => (EFFORT_MODELS.test(model) ? { output_config: { effort } } : {});

// Dollars for one call, or null when the model has no price.
export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p) return null;
  const cacheRead = p.cacheRead ?? 0.1;
  return (usage.input * p.in + usage.cacheRead * p.in * cacheRead + usage.cacheWrite * p.in * 1.25 + usage.output * p.out) / 1e6;
}
