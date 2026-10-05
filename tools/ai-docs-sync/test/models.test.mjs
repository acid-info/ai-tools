import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EFFORT_MODELS, PRICES, effortConfig } from '#core/models.mjs';

import { DEFAULTS, pickModels } from '../src/config.mjs';

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
