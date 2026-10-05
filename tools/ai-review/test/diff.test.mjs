import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMatcher } from '#core/paths.mjs';

import { packFiles, patchRightLines } from '../src/diff.mjs';
import { DEFAULTS } from '../src/config.mjs';

const file = (filename, patch, extra = {}) => ({ filename, patch, status: 'modified', additions: 1, deletions: 0, ...extra });

describe('diff', () => {
  test('right-side lines are context and additions, never deletions', () => {
    const patch = '@@ -1,3 +10,4 @@\n ctx\n-old\n+new\n+new2\n ctx2\n\\ No newline at end of file';
    assert.deepEqual([...patchRightLines(patch)], [10, 11, 12, 13]);
  });

  test('lockfiles are skipped, patchless files reported, the rest packed smallest first', () => {
    const r = packFiles(
      [file('package-lock.json', '@@ -1 +1 @@\n+x'), file('big.js', `@@ -1 +1 @@\n+${'y'.repeat(50)}`), file('a.js', '@@ -1 +1 @@\n+a'), file('huge.bin', undefined)],
      { changedFiles: 6, isIgnored: makeMatcher(DEFAULTS.ignore), budget: 1000 }
    );
    assert.deepEqual(r.files, ['a.js', 'big.js']);
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.noPatch, ['huge.bin']);
    assert.equal(r.unlisted, 2);
    assert.ok(r.diff.indexOf('a.js') < r.diff.indexOf('big.js'));
    assert.ok(r.validLines.get('a.js').has(1));
  });

  test('files over the token budget are counted, not silently dropped', () => {
    const r = packFiles([file('a.js', `@@ -1 +1 @@\n+${'z'.repeat(400)}`)], { isIgnored: () => false, budget: 10 });
    assert.equal(r.omitted, 1);
    assert.equal(r.diff, '');
  });
});
