import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseReview, reviewPrompt } from '../src/prompts.mjs';

describe('parseReview', () => {
  test('plain, fenced and prose-wrapped JSON all parse, and issues are tagged with their source', () => {
    const json = '{"issues":[{"file":"a.js","line":1,"severity":"major"}],"overall":"ok"}';
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Here you go:\n${json}\nThanks`]) {
      const r = parseReview(text, 'claude');
      assert.equal(r.issues[0].source, 'claude');
      assert.equal(r.parseFailed, undefined);
    }
  });

  test('fences inside a suggested fix survive', () => {
    const text = '```json\n{"issues":[{"suggested_fix":"```js\\nx()\\n```"}]}\n```';
    assert.equal(parseReview(text, 'codex').issues[0].suggested_fix, '```js\nx()\n```');
  });

  test('unparseable output is an empty review flagged out of band, with the cause logged', () => {
    const logged = [];
    const r = parseReview('not json', 'codex', { stopReason: 'max_output_tokens', maxTokens: 16000 }, { warn: (m) => logged.push(m) });
    assert.deepEqual(r.issues, []);
    assert.equal(r.parseFailed, true);
    assert.ok(!JSON.stringify(r).includes('parseFailed'));
    assert.ok(logged.some((m) => /cut off by the token budget/.test(m)));
  });
});

test('guidelines are included only when present', () => {
  assert.ok(!reviewPrompt('d', '').includes('<guidelines>'));
  assert.match(reviewPrompt('d', 'be nice'), /<guidelines>\nbe nice\n<\/guidelines>/);
});
