import { isAnthropicModel } from '#core/models.mjs';

import { MAX_RESPONSE_TOKENS, REVIEW_EFFORT, REVIEW_TIMEOUT_MS, SYNTH_TIMEOUT_MS } from './config.mjs';
import { REVIEWER_SYSTEM, parseReview, reviewPrompt, synthesisPrompt } from './prompts.mjs';

export const RANK = { critical: 3, major: 2, minor: 1, nit: 0 };

// `call(label, model, { system, prompt, effort, timeoutMs })` makes one model call and returns
// { text, stopReason, usage }.
async function reviewWith(call, label, source, model, diff, guidelines, warn) {
  const r = await call(label, model, { system: REVIEWER_SYSTEM, prompt: reviewPrompt(diff, guidelines), effort: REVIEW_EFFORT, timeoutMs: REVIEW_TIMEOUT_MS });
  return parseReview(r.text, source, { stopReason: r.stopReason, outputTokens: r.usage?.output, model, maxTokens: MAX_RESPONSE_TOKENS }, { warn });
}

// Both reviewers in parallel; if ONE provider is down, degrade to a single-model review.
export async function runReviewers({ call, cfg, diff, guidelines, warn = console.error }) {
  const [a, b] = await Promise.allSettled([
    reviewWith(call, 'reviewer-claude', 'claude', cfg.anthropic_model, diff, guidelines, warn),
    reviewWith(call, 'reviewer-codex', 'codex', cfg.openai_model, diff, guidelines, warn),
  ]);
  if (a.status === 'rejected' && b.status === 'rejected') throw new Error(`Both reviewers failed:\n${a.reason}\n${b.reason}`);
  const claudeFailed = a.status === 'rejected';
  const codexFailed = b.status === 'rejected';
  if (claudeFailed) warn(`[warn] Claude reviewer failed: ${a.reason}`);
  if (codexFailed) warn(`[warn] Codex reviewer failed: ${b.reason}`);
  const reviewA = claudeFailed ? { issues: [], overall: '(Claude reviewer unavailable)' } : a.value;
  const reviewB = codexFailed ? { issues: [], overall: '(Codex reviewer unavailable)' } : b.value;
  return {
    reviewA,
    reviewB,
    claudeFailed,
    codexFailed,
    // A reviewer that answers with unusable JSON still resolves, so `allSettled` above
    // can't see it. Separate from `claudeFailed`/`codexFailed`, which reroute synthesis.
    claudeUnparsed: reviewA.parseFailed === true,
    codexUnparsed: reviewB.parseFailed === true,
  };
}

export const localMerge = (reviewA, reviewB) => ({
  issues: [...reviewA.issues, ...reviewB.issues]
    .filter((i) => i.severity !== 'nit')
    .sort((x, y) => (RANK[y.severity] ?? 0) - (RANK[x.severity] ?? 0)),
  summary: [reviewA.overall, reviewB.overall].filter(Boolean).join(' -- '),
});

// synth_model on its own provider. If that provider's reviewer failed, the provider is presumed
// down (or its key unset), so reuse the surviving reviewer's model: its review just succeeded.
export function pickSynthModel(cfg, { claudeFailed, codexFailed }) {
  const onAnthropic = isAnthropicModel(cfg.synth_model);
  const providerDown = onAnthropic ? claudeFailed : codexFailed;
  const model = !providerDown ? cfg.synth_model : onAnthropic ? cfg.openai_model : cfg.anthropic_model;
  return { model, providerDown };
}

// If the synthesizer fails or answers with unusable JSON, degrade to a local merge rather than
// losing the review.
export async function synthesize({ call, cfg, model, reviewA, reviewB, warn = console.error }) {
  try {
    const r = await call('synthesizer', model, { prompt: synthesisPrompt(reviewA, reviewB), effort: cfg.synth_effort, timeoutMs: SYNTH_TIMEOUT_MS });
    const merged = parseReview(r.text, 'synth', { stopReason: r.stopReason, outputTokens: r.usage?.output, model, maxTokens: MAX_RESPONSE_TOKENS }, { warn });
    // An empty issue list would otherwise read as "nothing found".
    if (merged.parseFailed !== true) return { merged, synthFailed: false };
    warn('[warn] synthesis returned unparseable output; posting unmerged reviewer issues.');
  } catch (e) {
    warn(`[warn] synthesis failed (${e.message}); posting unmerged reviewer issues.`);
  }
  return { merged: localMerge(reviewA, reviewB), synthFailed: true };
}
