import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.mjs';
import { localMerge, pickSynthModel, runReviewers, synthesize } from '../src/review.mjs';

const issue = (severity, file = 'a.js') => ({ file, line: 1, severity, issue: severity });
const answer = (obj) => ({ text: JSON.stringify(obj), stopReason: 'end_turn', outputTokens: 1 });
const quiet = () => {};

describe('reviewers and synthesis', () => {
  test('one provider down degrades to a single-model review; both down throws', async () => {
    const call = async (label) => {
      if (label === 'reviewer-claude') throw new Error('Anthropic 529');
      return answer({ issues: [issue('major')], overall: 'x' });
    };
    const r = await runReviewers({ call, cfg: DEFAULTS, diff: 'd', guidelines: '', warn: quiet });
    assert.equal(r.claudeFailed, true);
    assert.equal(r.reviewB.issues.length, 1);
    await assert.rejects(
      runReviewers({ call: async () => { throw new Error('down'); }, cfg: DEFAULTS, diff: 'd', guidelines: '', warn: quiet }),
      /Both reviewers failed/
    );
  });

  test('unparseable reviewer output is reported separately from a failure', async () => {
    const call = async (label) => (label === 'reviewer-codex' ? { text: 'nope' } : answer({ issues: [] }));
    const r = await runReviewers({ call, cfg: DEFAULTS, diff: 'd', guidelines: '', warn: quiet });
    assert.equal(r.codexFailed, false);
    assert.equal(r.codexUnparsed, true);
  });

  test("synthesis moves to the surviving reviewer's model when synth_model's provider is down", () => {
    assert.deepEqual(pickSynthModel(DEFAULTS, { claudeFailed: false, codexFailed: false }), { model: DEFAULTS.synth_model, providerDown: false });
    assert.deepEqual(pickSynthModel(DEFAULTS, { claudeFailed: false, codexFailed: true }), { model: DEFAULTS.anthropic_model, providerDown: true });
    const claudeSynth = { ...DEFAULTS, synth_model: 'claude-haiku-4-5-20251001' };
    assert.equal(pickSynthModel(claudeSynth, { claudeFailed: true, codexFailed: false }).model, DEFAULTS.openai_model);
  });

  test('a failed or unparseable synthesis falls back to a local merge without nits', async () => {
    const reviewA = { issues: [issue('minor'), issue('nit')], overall: 'A' };
    const reviewB = { issues: [issue('critical')], overall: 'B' };
    for (const call of [async () => ({ text: 'garbage' }), async () => { throw new Error('500'); }]) {
      const r = await synthesize({ call, cfg: DEFAULTS, model: 'gpt-6-luna', reviewA, reviewB, warn: quiet });
      assert.equal(r.synthFailed, true);
      assert.deepEqual(r.merged, localMerge(reviewA, reviewB));
    }
    assert.deepEqual(localMerge(reviewA, reviewB).issues.map((i) => i.severity), ['critical', 'minor']);
  });
});
