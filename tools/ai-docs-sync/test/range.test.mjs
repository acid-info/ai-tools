import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { globToRegex } from '#core/paths.mjs';

import { makeIsEditableDocPath } from '../src/allowlist.mjs';
import { parseNameStatus, splitUnifiedDiff } from '../src/git.mjs';
import { classifyChanges, packDiff, selectRange } from '../src/range.mjs';
import { cfg } from './helpers.mjs';

describe('range selection', () => {
  const anc = (set) => (sha) => set.has(sha);
  test('since wins when it is an ancestor and fails loudly otherwise', () => {
    assert.deepEqual(selectRange({ since: 'aaa', cursor: 'bbb' }, anc(new Set(['aaa', 'bbb']))), { from: 'aaa', source: 'since' });
    assert.throws(() => selectRange({ since: 'zzz', cursor: 'bbb' }, anc(new Set(['bbb']))), /not an ancestor/);
  });
  test('cursor beats push_before; push_before needs a real, unforced, present sha', () => {
    assert.equal(selectRange({ cursor: 'bbb', pushBefore: 'ccc' }, anc(new Set(['bbb', 'ccc']))).source, 'cursor');
    assert.equal(selectRange({ cursor: 'gone', pushBefore: 'ccc' }, anc(new Set(['ccc']))).source, 'push_before');
    assert.equal(selectRange({ pushBefore: '0000000000000000000000000000000000000000' }, anc(new Set())).source, 'head~1');
    assert.equal(selectRange({ pushBefore: 'ccc', pushForced: 'true' }, anc(new Set(['ccc']))).source, 'head~1');
    assert.equal(selectRange({}, anc(new Set())).from, 'HEAD~1');
  });
});

describe('changed files and loop guard', () => {
  const isEditableDoc = makeIsEditableDocPath(cfg());
  const isIgnored = (p) => cfg().ignore.some((g) => globToRegex(g).test(p));

  test('parses -z --name-status with renames', () => {
    const z = 'M\0src/a.ts\0R100\0docs/old.md\0docs/new.md\0A\0README.md\0';
    assert.deepEqual(parseNameStatus(z), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'docs/new.md', oldPath: 'docs/old.md' },
      { status: 'A', path: 'README.md' },
    ]);
  });

  test('docs-only pushes (merging the rolling PR) trip the loop guard', () => {
    const r = classifyChanges(parseNameStatus('M\0README.md\0M\0docs/api/architecture.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /loop guard/);
  });

  test('merging a rolling PR that only deletes docs trips the loop guard', () => {
    const r = classifyChanges(parseNameStatus('D\0docs/api/architecture.md\0M\0README.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /loop guard/);
  });

  test('lockfile-only pushes exit as no code files', () => {
    const r = classifyChanges(parseNameStatus('M\0pnpm-lock.yaml\0M\0flake.lock\0M\0README.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /no code files/);
    assert.equal(r.ignored.length, 2);
  });

  test('a code change proceeds and a doc outside doc_paths counts as code', () => {
    const r = classifyChanges(parseNameStatus('M\0apps/api/src/x.ts\0M\0content/blog/a.md\0'), { isEditableDoc, isIgnored });
    assert.equal(r.skipReason, null);
    assert.equal(r.code.length, 2);
  });
});

describe('diff packing', () => {
  const RAW = [
    'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/apps/civi-crm/x.ts b/apps/api/x.ts\nsimilarity index 95%\nrename from apps/civi-crm/x.ts\nrename to apps/api/x.ts\nindex 1..2 100644\n--- a/apps/civi-crm/x.ts\n+++ b/apps/api/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+1\n+2\n+3\n',
  ].join('');

  test('splits a git diff per file and reports renames as renames', () => {
    const patches = splitUnifiedDiff(RAW);
    assert.deepEqual(patches.map((p) => [p.path, p.status]), [['src/a.ts', 'M'], ['apps/api/x.ts', 'R'], ['new.ts', 'A']]);
    assert.equal(patches[1].oldPath, 'apps/civi-crm/x.ts');
  });

  test('packs smallest first and lists what did not fit', () => {
    const patches = splitUnifiedDiff(RAW);
    const { diff, included, omitted } = packDiff(patches, 75);
    assert.deepEqual(included, ['src/a.ts', 'new.ts']);
    assert.deepEqual(omitted, ['apps/api/x.ts']);
    assert.match(diff, /NOT INCLUDED \(over budget\): apps\/api\/x\.ts/);
    const full = packDiff(patches, 10_000);
    assert.match(full.diff, /--- FILE: apps\/civi-crm\/x\.ts -> apps\/api\/x\.ts \(rename\) ---/);
  });
});
