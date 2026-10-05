import { costOf } from './models.mjs';

export function makeUsageLog(log = () => {}, warn = () => {}) {
  let total = 0;
  const unpriced = new Set();
  const entries = [];
  return {
    entries,
    log(label, model, usage) {
      const cost = costOf(model, usage);
      const line = `${usage.input} in / ${usage.cacheRead} cached / ${usage.cacheWrite} cache-write / ${usage.output} out`;
      entries.push({ label, model, ...usage, cost });
      if (cost == null) {
        if (!unpriced.has(model)) {
          unpriced.add(model);
          warn(`No price configured for model "${model}"; its usage is excluded from the total. Add it to PRICES in core/models.mjs.`);
        }
        log(`[cost] ${label} (${model}): ${line} = $? (price unknown)`);
        return;
      }
      total += cost;
      log(`[cost] ${label} (${model}): ${line} = $${cost.toFixed(4)}`);
    },
    total: () => total,
    unpriced: () => [...unpriced],
  };
}
