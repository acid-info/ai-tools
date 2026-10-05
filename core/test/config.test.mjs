import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalise, globToRegex } from '../paths.mjs';
import { parseYamlSubset } from '../yaml.mjs';

const TEXT = `
never_touch:
  - docs/superpowers/specs/**   # dated design records
extra_ignore:
  - flake.lock
  - 'apps/cms/src/app/(payload)/admin/importMap.js'
`;

describe('yaml subset', () => {
  test('parses the documented subset with comments and quotes', () => {
    const parsed = parseYamlSubset(TEXT);
    assert.deepEqual(parsed.never_touch, ['docs/superpowers/specs/**']);
    assert.deepEqual(parsed.extra_ignore, ['flake.lock', 'apps/cms/src/app/(payload)/admin/importMap.js']);
  });

  test('numbers are coerced, other scalars stay strings', () => {
    assert.deepEqual(parseYamlSubset("a: 12\nb: 'x'\nc: 1.5\n"), { a: 12, b: 'x', c: '1.5' });
  });
});

describe('paths', () => {
  test('the glob alone is traversable, which is why canonicalise runs first', () => {
    assert.ok(globToRegex('docs/**/*.md').test('docs/../../x.md'));
  });

  test('canonicalise rejects traversal, dot segments, absolute paths and odd bytes', () => {
    assert.equal(canonicalise('docs/../../x.md'), null);
    assert.equal(canonicalise('docs/./x.md'), null);
    assert.equal(canonicalise('/etc/passwd.md'), null);
    assert.equal(canonicalise('docs\\x.md'), null);
    assert.equal(canonicalise('docs/x\0.md'), null);
    assert.equal(canonicalise(''), null);
    assert.equal(canonicalise('docs//x.md'), 'docs/x.md');
  });
});
