import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeIsEditableDoc } from '../src/allowlist.mjs';
import { API } from '../src/api.mjs';
import { gateAllowlist, gateFlags, gateFormat, gateLinks, gateNonEmpty, gateSize, gateStyle, runGates } from '../src/gates.mjs';
import { cfg, tmpRepo } from './helpers.mjs';

describe('gates', () => {
  const c = cfg();
  const OLD = '# API\n\nThe handler validates hCaptcha -- then posts.\nSee [crm](../civi-crm/architecture.md).\nKeep \u2014 this dash.\n' + 'filler line\n'.repeat(40);
  const files = { 'docs/api/architecture.md': OLD, 'docs/civi-crm/architecture.md': '# crm\n', 'AGENTS.md': '# rules\n', 'README.md': '# r\n' };

  function ctx(root, extra = {}) {
    return {
      isEditableDoc: makeIsEditableDoc(c, root),
      readCurrent: (p) => files[p] ?? null,
      readTarget: (p) => files[p] ?? null,
      existsInCheckout: (p) => p in files,
      guidelineFiles: new Set(['AGENTS.md', 'CLAUDE.md']),
      format: { mode: 'off' },
      ...extra,
    };
  }

  test('gate 0 drops every path a model could invent, symlinks included', () => {
    const root = tmpRepo(files);
    symlinkSync(join(root, 'README.md'), join(root, 'docs', 'link.md'));
    try {
      const good = '# ok\n\nfine\n';
      const { kept, dropped } = runGates(
        [
          { path: 'content/blog/x.md', action: 'update', content: good },
          { path: 'docs/../../x.md', action: 'create', content: good },
          { path: '.github/workflows/x.md', action: 'create', content: good },
          { path: 'docs/link.md', action: 'update', content: good },
          { path: 'docs/new.md', action: 'create', content: good },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/new.md']);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['content/blog/x.md', 0], ['docs/../../x.md', 0], ['.github/workflows/x.md', 0], ['docs/link.md', 0]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 1: empty output and no-op edits are dropped', () => {
    assert.equal(gateNonEmpty({ content: '  \n' }, { current: 'x' }).ok, false);
    assert.equal(gateNonEmpty({ content: '# API\r\n\nsame  \n' }, { current: '# API\n\nsame\n' }).reason, 'no change');
    assert.equal(gateNonEmpty({ content: '# API\n\nchanged\n' }, { current: '# API\n\nsame\n' }).ok, true);
  });

  test('gate 2: links resolve against the post-edit tree including files created this run', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', 'posts. See [new](../new-app/README.md) and [gone](./missing.md).') },
          { path: 'docs/new-app/README.md', action: 'create', content: '# new app\n\nLinks back to [api](../api/architecture.md) and [root](../../README.md).\n' },
          { path: 'docs/escape.md', action: 'create', content: '# e\n\n[up](../../../etc/passwd)\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/new-app/README.md']);
      assert.match(dropped.find((d) => d.path === 'docs/api/architecture.md').reason, /broken relative link\(s\): \.\/missing\.md/);
      assert.equal(dropped.find((d) => d.path === 'docs/escape.md').gate, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 2: only added prose lines are checked; root-relative and encoded links resolve', () => {
    const exists = (p) => ['docs/setup.md', 'docs/my file.md'].includes(p);
    const current = '# g\n\n[old](./already-broken.md)\n';
    const ok = gateLinks(
      { path: 'docs/g.md', content: current + '[s](/docs/setup.md) [f](my%20file.md)\n\n```md\n[example](./not-a-real-file.md)\n```\n' },
      { existsInTree: exists, current }
    );
    assert.deepEqual(ok, { ok: true });
    const bad = gateLinks({ path: 'docs/g.md', content: current + '[new](./nope.md)\n' }, { existsInTree: exists, current });
    assert.match(bad.reason, /broken relative link\(s\): \.\/nope\.md$/);
  });

  test('gate 3: size sanity measured from the target branch with the 400-byte floor', () => {
    assert.equal(gateSize({ action: 'update', content: '# short\n' }, { target: OLD }).ok, false);
    assert.match(gateSize({ action: 'update', content: '# short\n' }, { target: OLD }).reason, /shrank 9\d%/);
    assert.equal(gateSize({ action: 'update', content: OLD.repeat(4) }, { target: OLD }).ok, false);
    assert.equal(gateSize({ action: 'update', content: OLD + 'more\n' }, { target: OLD }).ok, true);
    assert.equal(gateSize({ action: 'update', content: '# ten lines\n'.repeat(10) }, { target: '# tiny\n' }).ok, true, 'floor');
    assert.equal(gateSize({ action: 'create', content: 'x' }, { target: null }).ok, true);
  });

  test('gate 4: dashes fixed on changed lines only, attribution drops the file', () => {
    const changed = OLD.replace('validates hCaptcha -- then posts.', 'posts \u2014 nothing else.');
    const r = gateStyle({ path: 'docs/api/architecture.md', content: changed }, { current: OLD });
    assert.equal(r.ok, true);
    assert.equal(r.fixed, 1);
    assert.ok(r.content.includes('posts -- nothing else.'));
    assert.ok(r.content.includes('Keep \u2014 this dash.'), 'untouched paragraph left alone');
    const attributed = OLD + '\nGenerated with an assistant.\n';
    assert.match(gateStyle({ path: 'x', content: attributed }, { current: OLD }).reason, /attribution string on line \d+/);
    assert.equal(gateStyle({ path: 'x', content: OLD + '\nCo-Authored-By: someone\n' }, { current: OLD }).ok, false);
  });

  test('gate 5: new URLs and raw HTML are flagged, comments and anchors are not; guideline edits carry a banner diff', () => {
    const content = OLD + '\nSee https://example.com/new and <img src="x"> plus <!-- prettier-ignore --> and <a name="top"></a>.\nAlso https://old.example already there.\n';
    const cur = OLD + '\nhttps://old.example\n';
    const r = gateFlags({ path: 'docs/api/architecture.md', content }, { current: cur, isGuideline: false });
    const kinds = Object.fromEntries(r.flags.map((f) => [f.kind, f.detail]));
    assert.deepEqual(kinds.new_urls, ['https://example.com/new']);
    assert.deepEqual(kinds.raw_html, ['<img src="x">']);
    assert.equal(kinds.guideline_edit, undefined);
    const g = gateFlags({ path: 'AGENTS.md', content: '# rules\n\nnew rule\n' }, { current: '# rules\n', isGuideline: true });
    assert.match(g.flags.find((f) => f.kind === 'guideline_edit').detail, /\+new rule/);
    const v = gateFlags({ path: 'x', content: 'Reviewed by Anthropic models.\n' }, { current: '', isGuideline: false });
    assert.deepEqual(v.flags.find((f) => f.kind === 'vendor_names').detail, ['Anthropic']);
  });

  test('gate 5: tags inside code spans and fences are text, not HTML; URLs there are still flagged', () => {
    const content = '| `--greeting <word>` | x |\n\n````html\n<script src="https://cdn.example/a.js"></script>\n```\n<b>still fenced</b>\n````\n\nAfter <em>prose</em>.\n';
    const r = gateFlags({ path: 'docs/cli.md', content }, { current: '', isGuideline: false });
    const kinds = Object.fromEntries(r.flags.map((f) => [f.kind, f.detail]));
    assert.deepEqual(kinds.raw_html, ['<em>', '</em>']);
    assert.deepEqual(kinds.new_urls, ['https://cdn.example/a.js']);
  });

  test('gate 6: strict formatting replaces content or drops on failure; off is a no-op', () => {
    assert.equal(gateFormat({ content: 'x' }, { format: { mode: 'off' } }).content, 'x');
    assert.equal(gateFormat({ content: 'x' }, { format: { mode: 'strict', run: () => ({ ok: true, content: 'X' }) } }).content, 'X');
    assert.match(gateFormat({ content: 'x' }, { format: { mode: 'strict', run: () => ({ ok: false, error: 'parse' }) } }).reason, /prettier failed: parse/);
  });

  test('runGates end to end on a deliberately bad batch', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('validates hCaptcha -- then posts.', 'posts \u2014 only.') },
          { path: 'docs/civi-crm/architecture.md', action: 'update', content: '# crm\n\n[broken](./nope.md)\n' },
          { path: 'README.md', action: 'update', content: '# r\n\nGenerated with love.\n' },
          { path: 'AGENTS.md', action: 'update', content: '# rules\n\nAlways run tests.\n' },
          { path: 'content/x.md', action: 'update', content: '# nope\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/api/architecture.md', 'AGENTS.md']);
      assert.ok(kept[0].content.includes('posts -- only.'));
      assert.equal(kept[0].dashesFixed, 1);
      assert.ok(kept[1].flags.some((f) => f.kind === 'guideline_edit'));
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['content/x.md', 0], ['docs/civi-crm/architecture.md', 2], ['README.md', 4]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a delete runs gate 0 and "exists", and flags a guideline file', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'gone' },
          { path: 'AGENTS.md', action: 'delete', reason: 'gone' },
          { path: 'docs/missing.md', action: 'delete', reason: 'gone' },
          { path: '.github/x.md', action: 'delete', reason: 'gone' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/civi-crm/architecture.md', 'AGENTS.md']);
      assert.deepEqual(kept[0].flags, []);
      assert.match(kept[1].flags.find((f) => f.kind === 'guideline_delete').detail, /^-# rules$/m);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate, d.reason]), [['docs/missing.md', 1, 'nothing to delete'], ['.github/x.md', 0, 'path outside the editable allowlist']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 2: a link added to a doc deleted this run or carried as deleted fails', () => {
    const root = tmpRepo(files);
    try {
      const add = (link) => ({ path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', `posts. See [x](${link}).`) });
      let r = runGates([add('../civi-crm/architecture.md'), { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'gone' }], ctx(root));
      assert.deepEqual(r.kept.map((k) => k.path), ['docs/civi-crm/architecture.md']);
      assert.equal(r.dropped[0].gate, 2);
      r = runGates([add('../../README.md')], ctx(root, { carriedDeletes: new Set(['README.md']) }));
      assert.equal(r.dropped[0].gate, 2);
      r = runGates([add('../../README.md'), { path: 'README.md', action: 'update', content: '# r\n\nrestored\n' }], ctx(root, { carriedDeletes: new Set(['README.md']) }));
      assert.deepEqual(r.kept.map((k) => k.path), ['docs/api/architecture.md', 'README.md'], 'an un-delete this run puts it back in the tree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fixpoint: a create dropped at gate 4 takes a link to it down at gate 2, and its dependents go too', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped, orphaned } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', 'posts. See [n](../new.md).') },
          { path: 'docs/new.md', action: 'create', content: '# new\n\nCo-Authored-By: x\n' },
          { path: 'docs/civi-crm/architecture.md', action: 'update', content: '# crm\n\nfixed\n', dependsOn: ['docs/gone.md'] },
          { path: 'README.md', action: 'update', content: '# r\n\nfine\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['README.md']);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['docs/new.md', 4], ['docs/api/architecture.md', 2]]);
      assert.deepEqual(orphaned, [{ path: 'docs/civi-crm/architecture.md', reason: 'depends on docs/gone.md, which was held back' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 0 accepts only the exact canonical path', () => {
    assert.equal(gateAllowlist({ path: 'docs//x.md' }, { isEditableDoc: () => true }).ok, false);
    assert.equal(gateAllowlist({ path: 'docs/x.md' }, { isEditableDoc: () => true }).ok, true);
  });
});
