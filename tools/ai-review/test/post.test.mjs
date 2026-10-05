import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.mjs';
import { deMention, renderReview, renderUnreviewable } from '../src/post.mjs';

const meta = (extra = {}) => ({ skipped: 0, noPatch: [], omitted: 0, unlisted: 0, validLines: new Map([['a.js', new Set([3])]]), synthModel: 'gpt-6-luna', ...extra });
const issue = (severity, line, extra = {}) => ({ file: 'a.js', line, severity, category: 'bug', issue: `${severity} at ${line}`, ...extra });

describe('renderReview', () => {
  test('threshold filters what is posted, criticals are always counted, only diff lines are anchored', () => {
    const merged = { summary: 'S', issues: [issue('critical', 3), issue('major', 99), issue('minor', 3)] };
    const r = renderReview(merged, meta(), { cfg: DEFAULTS, prNumber: '7' });
    assert.equal(r.criticals.length, 1);
    assert.deepEqual(r.comments.map((c) => c.line), [3]);
    assert.match(r.body, /\*\*1 critical\*\*, 1 other issue\(s\) shown \(threshold: major\)/);
    assert.match(r.body, /Issues without a diff line to anchor to:\n- 🟠 \*\*major\*\* `a\.js:99`/);
    assert.ok(!r.body.includes('minor at 3'));
    assert.match(r.flatBody(), /critical at 3/);
  });

  test('mentions are defused and the findings marker cannot be closed early', () => {
    const merged = { summary: 'ping @octocat', issues: [issue('major', 3, { issue: 'x --> y @team' })] };
    const r = renderReview(merged, meta(), { cfg: DEFAULTS, prNumber: '7' });
    assert.ok(r.body.includes('@​octocat'));
    const marker = r.body.match(/<!-- ai-review:findings (.*) -->/)[1];
    assert.ok(!marker.includes('>'));
    assert.equal(JSON.parse(marker).issues[0].issue, 'x --> y @team');
    assert.equal(deMention('a@b and @c'), 'a@​b and @​c');
  });

  test('partial reviews say so', () => {
    const r = renderReview({ summary: '', issues: [] }, meta({ omitted: 2, codexFailed: true, synthFailed: true }), { cfg: DEFAULTS, prNumber: '7' });
    assert.match(r.body, /2 file\(s\) exceeded the diff token budget/);
    assert.match(r.body, /The gpt-6-sol reviewer failed/);
    assert.match(r.body, /The synthesis step failed/);
  });

  test('an oversized body is truncated and loses the marker rather than the review', () => {
    const warnings = [];
    const merged = { summary: 'x'.repeat(70_000), issues: [] };
    const r = renderReview(merged, meta(), { cfg: DEFAULTS, prNumber: '7', warn: (m) => warnings.push(m) });
    assert.ok(r.body.length <= 60_000);
    assert.match(r.body, /truncated to fit GitHub's comment limit/);
    assert.ok(!r.body.includes('ai-review:findings'));
    assert.match(warnings[0], /findings marker omitted/);
  });
});

test('nothing reviewable explains what was not reviewed', () => {
  assert.match(renderUnreviewable({ noPatch: [], omitted: 0, unlisted: 0, maxDiffTokens: 1 }), /Nothing reviewable/);
  assert.match(renderUnreviewable({ noPatch: ['x'], omitted: 1, unlisted: 0, maxDiffTokens: 9 }), /could NOT run[\s\S]*\(9 tokens\)/);
});
