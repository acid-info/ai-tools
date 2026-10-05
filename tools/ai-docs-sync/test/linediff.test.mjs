import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { addedLineIndexes, lineDiff, unifiedDiff } from '../src/linediff.mjs';

describe('line diff', () => {
  test('finds added lines and renders a unified diff', () => {
    const a = 'one\ntwo\nthree\nfour\n';
    const b = 'one\n2\nthree\nfour\nfive\n';
    const ops = lineDiff(a, b);
    assert.deepEqual([...addedLineIndexes(ops)], [1, 4]);
    const d = unifiedDiff(a, b, 'x.md');
    assert.match(d, /^--- a\/x\.md\n\+\+\+ b\/x\.md\n@@ -1,4 \+1,5 @@\n one\n-two\n\+2\n three\n four\n\+five\n$/);
    assert.equal(unifiedDiff(a, a, 'x.md'), '');
  });
  test('a new file is all additions', () => {
    assert.equal(addedLineIndexes(lineDiff('', 'a\nb\n')).size, 2);
  });
});
