import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costOf, effortConfig, isAnthropicModel } from '../models.mjs';
import { parseJsonObject } from '../text.mjs';
import { usageTable } from '../usage.mjs';

test('effort goes where each provider accepts it, and nowhere else', () => {
  assert.deepEqual(effortConfig('claude-opus-5-5', 'medium'), { output_config: { effort: 'medium' } });
  assert.deepEqual(effortConfig('claude-haiku-4-5-20251001', 'low'), {});
  assert.deepEqual(effortConfig('gpt-6-luna', 'low'), { reasoning: { effort: 'low' } });
  assert.deepEqual(effortConfig('gpt-4.1', 'low'), {});
  assert.deepEqual(effortConfig('claude-opus-5-5', undefined), {});
  assert.ok(isAnthropicModel('claude-x') && !isAnthropicModel('gpt-6-sol'));
});

test('cost counts cached reads and cache writes at their own rates', () => {
  const usage = { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 };
  assert.equal(costOf('claude-opus-5-5', usage), 4 + 0.2 + 5 + 20);
  assert.equal(costOf('no-such-model', usage), null);
});

test('JSON is found in fenced or prose-wrapped answers; inner fences are content', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":"```x```"}\n```'), { a: '```x```' });
  assert.deepEqual(parseJsonObject('Sure:\n{"a":1}\nDone.'), { a: 1 });
  assert.equal(parseJsonObject('no json here'), null);
  assert.equal(parseJsonObject(undefined), null);
});

test('usage table rows, escaped labels and the unpriced note', () => {
  const lines = usageTable(
    { entries: [{ label: 'a|b', model: 'm', input: 1, cacheRead: 2, output: 3, cost: null }], total: 0.5, unpriced: ['m'] },
    { label: (l) => l.replace('|', '/') }
  );
  assert.equal(lines[2], '| a/b | m | 1 | 2 | 3 | ? |');
  assert.equal(lines.at(-1), 'Total ~$0.5000 (excludes unpriced: m)');
});
