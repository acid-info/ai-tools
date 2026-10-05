import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKER_SYSTEM, batchByTokens, checkInBatches, checkerUser, decideAfterCheck, parseChecker } from '../src/checker.mjs';
import { approxTokens } from '../src/text.mjs';

describe('checker parser and the single-correction rule', () => {
  test('parses verdicts and normalises severities', () => {
    const files = parseChecker(
      JSON.stringify({
        files: [
          { path: 'docs/a.md', verdict: 'revise', issues: [{ severity: 'must', note: 'wrong' }, { severity: 'nit', note: 'meh' }] },
          { path: 'docs/b.md', verdict: 'ok', issues: [] },
          { path: 'docs/c.md', verdict: 'weird' },
          { path: '../x.md', verdict: 'drop' },
        ],
      })
    );
    assert.equal(files.get('docs/a.md').issues[1].severity, 'should');
    assert.equal(files.get('docs/c.md').verdict, 'ok');
    assert.ok(!files.has('../x.md'));
    assert.equal(parseChecker('garbage'), null);
  });
  test('decideAfterCheck', () => {
    assert.equal(decideAfterCheck(undefined).unchecked, true);
    assert.equal(decideAfterCheck({ verdict: 'ok', issues: [] }).action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'should', note: 'x' }] }).action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'must', note: 'x' }] }).action, 'correct');
    assert.equal(decideAfterCheck({ verdict: 'drop', issues: [] }).action, 'drop');
  });
  test('decideAfterCheck for a delete: drop or proceed, never correct', () => {
    const must = { verdict: 'revise', issues: [{ severity: 'must', note: 'subject still exists' }] };
    assert.equal(decideAfterCheck(must, 'delete').action, 'drop');
    assert.equal(decideAfterCheck({ verdict: 'drop', issues: [] }, 'delete').action, 'drop');
    assert.equal(decideAfterCheck({ verdict: 'ok', issues: [] }, 'delete').action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'should', note: 'x' }] }, 'delete').action, 'proceed');
    assert.equal(decideAfterCheck(undefined, 'delete').unchecked, true);
  });
  test('checker input renders deletes with their current content and the manifest', () => {
    const text = checkerUser({
      narrative: 'n',
      diff: 'd',
      manifest: '- docs/a.md',
      docs: [{ path: 'docs/gone.md', action: 'delete', reason: 'removed', source_files: ['apps/x.ts'], current: '# gone\n' }],
    });
    assert.match(text, /<manifest>\n- docs\/a\.md\n<\/manifest>/);
    assert.match(text, /<doc path="docs\/gone\.md" action="delete">\n<reason>removed<\/reason>\n<source_files>apps\/x\.ts<\/source_files>\n<current_content>\n# gone\n\n<\/current_content>\n<\/doc>/);
    assert.match(CHECKER_SYSTEM, /Never\s+"revise" a delete/);
  });
});

describe('checker batching', () => {
  const doc = (path, chars) => ({ path, action: 'update', reason: 'r', editDiff: '', content: 'x'.repeat(chars) });
  test('splits by budget and keeps an oversized doc alone', () => {
    const docs = [doc('a', 100), doc('b', 100), doc('huge', 10_000), doc('c', 100)];
    const batches = batchByTokens(docs, 100, (d) => approxTokens(d.content));
    assert.deepEqual(batches.map((b) => b.map((d) => d.path)), [['a', 'b'], ['huge'], ['c']]);
  });
  test('merges verdicts; a failed batch leaves only its own files unchecked', async () => {
    const docs = [doc('docs/a.md', 400), doc('docs/b.md', 400), doc('docs/c.md', 400)];
    const seen = [];
    const r = await checkInBatches(docs, {
      budget: 150,
      concurrency: 2,
      check: async (batch) => {
        seen.push(batch.map((d) => d.path));
        if (batch[0].path === 'docs/b.md') throw new Error('500');
        if (batch[0].path === 'docs/c.md') return null;
        return new Map([...batch.map((d) => [d.path, { verdict: 'ok', issues: [] }]), ['docs/b.md', { verdict: 'drop', issues: [] }]]);
      },
    });
    assert.equal(r.batches, 3);
    assert.deepEqual([...r.verdicts.keys()], ['docs/a.md'], 'a verdict for a file outside its batch is ignored');
    assert.deepEqual(r.failed.map((f) => f.paths), [['docs/b.md'], ['docs/c.md']]);
    assert.match(r.failed[0].error.message, /500/);
    assert.equal(decideAfterCheck(r.verdicts.get('docs/b.md')).unchecked, true);
  });
});
