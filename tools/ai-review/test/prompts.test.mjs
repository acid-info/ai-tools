import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { REVIEWER_SYSTEM, parseReview, reviewPrompt, synthesisPrompt } from '../src/prompts.mjs';

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

describe('prompt text', () => {
  const prompts = { system: REVIEWER_SYSTEM, review: reviewPrompt('d', 'g'), synthesis: synthesisPrompt({ issues: [] }, { issues: [] }) };

  test('no dashes in prompt prose and no shouted words', () => {
    for (const [name, text] of Object.entries(prompts)) {
      assert.doesNotMatch(text, /[\u2013\u2014]| -- | - /, name);
      assert.doesNotMatch(text, /\b(NOT|ONLY|ONE|INTRODUCED|NEW)\b/, name);
    }
  });

  test('the parsed JSON keys and severity names are still asked for', () => {
    for (const key of ['"issues"', '"file"', '"line"', '"severity"', '"category"', '"issue"', '"suggested_fix"', '"overall"'])
      assert.ok(prompts.review.includes(key), key);
    for (const key of ['"issues"', '"summary"', '"agreement"', '"suggested_fix"']) assert.ok(prompts.synthesis.includes(key), key);
    assert.match(prompts.review, /"critical\|major\|minor\|nit"/);
    assert.match(prompts.review, /Severity guide: critical = will break in production/);
    assert.match(prompts.synthesis, /Drop all "nit" issues/);
  });

  test('both prompts carry the writing rules for posted fields', () => {
    for (const name of ['review', 'synthesis']) {
      assert.match(prompts[name], /"issue": lead with the problem/, name);
      assert.match(prompts[name], /do not praise the pull request/, name);
      assert.match(prompts[name], /No en or em dashes/, name);
    }
  });

  test('the dependency-version guidance stays', () => {
    assert.match(prompts.review, /knowledge cutoff/);
    assert.match(prompts.review, /legitimate newer\s+release/);
    assert.match(prompts.review, /not suggest downgrading/);
  });
});
