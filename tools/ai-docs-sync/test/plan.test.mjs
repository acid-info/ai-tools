import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { makeIsEditableDoc } from '../src/allowlist.mjs';
import { CHECKER_SYSTEM } from '../src/checker.mjs';
import { gateSize, runGates } from '../src/gates.mjs';
import { inboundLinks } from '../src/links.mjs';
import { applyInboundLinks, createPlacement, dropOrphanedDependents, finaliseIndexTasks, findIndexDoc, flagBrokenInbound, markNewDocLinks, pickExemplar, planCreates, planDeletes } from '../src/plan.mjs';
import { renderPrBody } from '../src/pr-body.mjs';
import { TRIAGE_SYSTEM } from '../src/triage.mjs';
import { WRITER_SYSTEM, writerDocPart } from '../src/writer.mjs';
import { cfg, tmpRepo } from './helpers.mjs';

describe('delete plan', () => {
  const del = (path, source_files) => ({ path, action: 'delete', reason: 'gone', source_files });
  const readCurrent = (p) => `# ${p}\n`;
  test('kept with a cited code path in range, downgraded to a suggestion with none', () => {
    const r = planDeletes({ deletes: [del('docs/a.md', ['apps/a/index.ts']), del('docs/b.md', ['README.md']), del('docs/c.md', [])], codePaths: new Set(['apps/a/index.ts']), readCurrent });
    assert.deepEqual(r.deletes.map((d) => d.path), ['docs/a.md']);
    assert.equal(r.deletes[0].current, '# docs/a.md\n');
    assert.deepEqual(r.suggested.map((d) => [d.path, d.why]), [['docs/b.md', 'no cited source file is in the diff'], ['docs/c.md', 'no cited source file is in the diff']]);
  });
  test('a path from the earlier (stale) diff or the old side of a rename counts', () => {
    const codePaths = new Set(['apps/old/x.ts', 'apps/new/x.ts', 'apps/earlier.ts']);
    const r = planDeletes({ deletes: [del('docs/a.md', ['apps/old/x.ts']), del('docs/b.md', ['apps/earlier.ts'])], codePaths, readCurrent });
    assert.equal(r.deletes.length, 2);
  });
  test('a guideline delete is flagged with the removed content as the diff', () => {
    const r = planDeletes({ deletes: [del('apps/api/AGENTS.md', ['apps/api/x.ts'])], codePaths: new Set(['apps/api/x.ts']), readCurrent, guidelineFiles: new Set() });
    const g = r.deletes[0].flags.find((f) => f.kind === 'guideline_delete');
    assert.match(g.detail, /^--- a\/apps\/api\/AGENTS\.md\n\+\+\+ b\/apps\/api\/AGENTS\.md\n@@ -1,1 \+0,0 @@\n-# apps\/api\/AGENTS\.md\n$/);
  });
});

describe('inbound links to deleted docs', () => {
  const files = [
    { path: 'README.md', content: '# r\n\nSee [crm](/docs/civi%20crm/arch.md) and [api](docs/api.md).\n' },
    { path: 'docs/api.md', content: '# api\n\n```md\n[example](./civi%20crm/arch.md)\n```\nNo live link here.\n' },
    { path: 'docs/guide.md', content: '# g\n\n[crm](civi%20crm/arch.md#setup)\n' },
    { path: 'docs/civi crm/other.md', content: '[sibling](./arch.md)\n' },
    { path: 'docs/specs/old.md', content: '[crm](../civi%20crm/arch.md)\n' },
    { path: 'docs/civi crm/arch.md', content: '[self](./arch.md)\n' },
  ];
  const deleted = ['docs/civi crm/arch.md', 'docs/civi crm/other.md'];
  test('finds linkers, resolving root and percent-encoded links, skipping fences and deleted docs', () => {
    const inbound = inboundLinks(files, deleted);
    assert.deepEqual(inbound.get('docs/civi crm/arch.md'), ['README.md', 'docs/guide.md', 'docs/specs/old.md']);
    assert.deepEqual(inbound.get('docs/civi crm/other.md'), []);
  });
  test('editable linker gets a dependent task; an affected one gets the reason appended; a non-editable one is flagged', () => {
    const inbound = inboundLinks(files, deleted);
    const deletes = [{ path: 'docs/civi crm/arch.md', action: 'delete', reason: 'the CRM app was removed', source_files: ['apps/crm/x.ts'], flags: [] }];
    const affected = [{ path: 'README.md', action: 'update', reason: 'New app listed.', source_files: ['apps/new/x.ts'] }];
    const r = applyInboundLinks({ affected, deletes, inbound, isEditableDoc: (p) => !p.startsWith('docs/specs/') });
    const readme = r.affected.find((a) => a.path === 'README.md');
    assert.equal(readme.reason, 'New app listed. Also remove or retarget the link(s) to docs/civi crm/arch.md, deleted this run because the CRM app was removed.');
    assert.equal(readme.dependsOn, undefined);
    assert.deepEqual(r.affected.find((a) => a.path === 'docs/guide.md'), {
      path: 'docs/guide.md',
      action: 'update',
      reason: 'Remove or retarget the link(s) to docs/civi crm/arch.md, deleted this run because the CRM app was removed.',
      source_files: ['apps/crm/x.ts'],
      dependsOn: ['docs/civi crm/arch.md'],
    });
    assert.deepEqual(r.deletes[0].flags, [{ kind: 'broken_inbound_links', detail: ['docs/specs/old.md'] }]);
    assert.equal(affected[0].reason, 'New app listed.', 'input not mutated');
  });
  test('flagBrokenInbound replaces an earlier flag and drops it when nothing links', () => {
    const d = [{ path: 'x.md', flags: [{ kind: 'broken_inbound_links', detail: ['a.md'] }, { kind: 'guideline_delete', detail: '' }] }];
    assert.deepEqual(flagBrokenInbound(d, new Map([['x.md', ['c.md', 'b.md']]]))[0].flags.map((f) => f.detail), ['', ['b.md', 'c.md']]);
    assert.deepEqual(flagBrokenInbound(d, new Map())[0].flags.map((f) => f.kind), ['guideline_delete']);
  });
  test('dropOrphanedDependents drops tasks whose dependency is gone', () => {
    const tasks = [{ path: 'a.md' }, { path: 'b.md', dependsOn: ['x.md'] }, { path: 'c.md', dependsOn: ['y.md'] }];
    const r = dropOrphanedDependents(tasks, new Set(['a.md', 'x.md']));
    assert.deepEqual(r.kept.map((t) => t.path), ['a.md', 'b.md']);
    assert.deepEqual(r.orphaned, [{ path: 'c.md', reason: 'depends on y.md, which was held back' }]);
  });
});

describe('creating docs', () => {
  const m = (path, bytes, linkDirs = []) => ({ path, heading: '', bytes, linkDirs });
  const manifest = [
    m('README.md', 1200, ['docs/', 'packages/a/', 'packages/b/']),
    m('AGENTS.md', 300, ['docs/']),
    m('docs/index.md', 500, ['docs/commands/']),
    m('docs/cli.md', 700),
    m('docs/commands/greet.md', 900),
    m('docs/commands/serve.md', 600),
    m('docs/commands/tiny.md', 100),
    m('packages/a/README.md', 800),
    m('packages/b/README.md', 1000),
    m('packages/b/docs/usage.md', 500),
  ];
  const paths = manifest.map((x) => x.path);

  test('placement: same directory, one new level under docs, sibling name; the root is not a docs area', () => {
    assert.deepEqual(createPlacement('docs/commands/new.md', paths), { ok: true });
    assert.deepEqual(createPlacement('CONTRIBUTING.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/guides/x.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/commands/deep/x.md', paths), { ok: true });
    assert.deepEqual(createPlacement('packages/c/README.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/commands/deep/er/x.md', paths), { ok: false, reason: 'no docs live near docs/commands/deep/er/' });
    assert.deepEqual(createPlacement('packages/c/CHANGELOG.md', paths), { ok: false, reason: 'no docs live near packages/c/' });
    assert.deepEqual(createPlacement('misc/notes.md', paths), { ok: false, reason: 'no docs live near misc/' }, 'a root README does not admit a new top-level directory');
    assert.equal(createPlacement('newtop/index.md', paths).ok, false, 'nor does docs/index.md as a sibling at the root');
  });

  test('exemplar: sibling name first, then the same directory by median size, then the parent; none', () => {
    assert.equal(pickExemplar('packages/c/README.md', manifest).path, 'packages/a/README.md');
    assert.equal(pickExemplar('docs/commands/new.md', manifest).path, 'docs/commands/serve.md');
    assert.equal(pickExemplar('docs/commands/deep/x.md', manifest).path, 'docs/commands/serve.md');
    assert.equal(pickExemplar('docs/guides/x.md', manifest).path, 'docs/cli.md');
    assert.equal(pickExemplar('x/y/z.md', manifest), null);
  });

  test('index doc: README or index in the directory, then the parent, then a doc linking there; skips deleted and non-editable', () => {
    assert.equal(findIndexDoc('docs/new.md', manifest), 'docs/index.md');
    assert.equal(findIndexDoc('docs/new.md', [...manifest, m('docs/README.md', 10)]), 'docs/README.md', 'README.md before index.md');
    assert.equal(findIndexDoc('docs/commands/new.md', manifest), 'docs/index.md');
    assert.equal(findIndexDoc('packages/b/docs/new.md', manifest), 'packages/b/README.md');
    assert.equal(findIndexDoc('packages/c/README.md', manifest), 'README.md', 'a list of sibling directories counts; the new README is not its own index');
    const tie = [...manifest.filter((x) => x.path !== 'AGENTS.md'), m('AGENTS.md', 300, ['packages/a/'])];
    assert.equal(findIndexDoc('packages/c/README.md', tie, { guidelineFiles: new Set(['AGENTS.md']) }), 'README.md', 'a guideline file ranks last');
    assert.equal(findIndexDoc('docs/new.md', manifest, { deleted: new Set(['docs/index.md']) }), 'README.md');
    assert.equal(findIndexDoc('docs/new.md', manifest, { deleted: new Set(['docs/index.md']), isEditable: (p) => p !== 'README.md' }), 'AGENTS.md');
    assert.equal(findIndexDoc('x/y/z.md', manifest), null);
  });

  const affected = () => [
    { path: 'docs/commands/new.md', action: 'create', reason: 'Documents the new `wave` command.', source_files: ['src/wave.js'] },
    { path: 'packages/c/README.md', action: 'create', reason: 'New package c.', source_files: ['packages/c/index.js'] },
    { path: 'misc/notes.md', action: 'create', reason: 'Notes.', source_files: [] },
    { path: 'README.md', action: 'update', reason: 'Layout lists packages.', source_files: ['packages/c/index.js'] },
  ];

  test('plan: a refused create is held back before the writer; index updates are dependent tasks or reason notes', () => {
    const r = planCreates({ affected: affected(), manifest });
    assert.deepEqual(r.refused, [{ path: 'misc/notes.md', reason: 'placement: no docs live near misc/' }]);
    assert.deepEqual(r.affected.map((a) => a.path), ['docs/commands/new.md', 'packages/c/README.md', 'README.md'], 'no writer task for the refused create');
    const wave = r.affected.find((a) => a.path === 'docs/commands/new.md');
    assert.deepEqual([wave.exemplar, wave.index], [{ path: 'docs/commands/serve.md', bytes: 600 }, 'docs/index.md']);
    assert.equal(r.affected.find((a) => a.path === 'README.md').reason, 'Layout lists packages. Also link the new doc packages/c/README.md (new package c).');
    assert.equal(r.affected.find((a) => a.path === 'README.md').dependsOn, undefined);
    assert.deepEqual(r.indexTasks, [
      {
        path: 'docs/index.md',
        action: 'update',
        reason: '',
        source_files: ['src/wave.js'],
        dependsOn: ['docs/commands/new.md'],
        links: [{ path: 'docs/commands/new.md', why: 'documents the new `wave` command' }],
      },
    ]);
    assert.equal(affected()[3].reason, 'Layout lists packages.', 'input not mutated');
    assert.equal(planCreates({ affected: affected(), manifest, deleted: new Set(['docs/index.md']) }).affected[0].index, 'README.md');
  });

  test('wave 2: the index update carries the drafted title; a wave-1 create failure drops it', () => {
    const { indexTasks } = planCreates({ affected: affected(), manifest });
    const ok = finaliseIndexTasks(indexTasks, new Map([['docs/commands/new.md', '# wave\n\nWaves.\n']]));
    assert.deepEqual(ok.tasks, [
      {
        path: 'docs/index.md',
        action: 'update',
        reason: 'Link the new doc docs/commands/new.md, titled "wave" (documents the new `wave` command).',
        source_files: ['src/wave.js'],
        dependsOn: ['docs/commands/new.md'],
      },
    ]);
    assert.deepEqual(finaliseIndexTasks(indexTasks, new Map()), { tasks: [], orphaned: [{ path: 'docs/index.md', reason: 'depends on docs/commands/new.md, which was held back' }] });
    const two = [{ ...indexTasks[0], dependsOn: ['docs/commands/new.md', 'docs/commands/b.md'], links: [...indexTasks[0].links, { path: 'docs/commands/b.md', why: '' }] }];
    const partial = finaliseIndexTasks(two, new Map([['docs/commands/b.md', 'no heading\n']]));
    assert.deepEqual([partial.tasks[0].reason, partial.tasks[0].dependsOn], ['Link the new doc docs/commands/b.md.', ['docs/commands/b.md']]);
  });

  test('the writer sees an exemplar for creates only, cut to its budget', () => {
    const exemplar = { path: 'docs/commands/serve.md', content: 'line\n'.repeat(100) };
    const create = writerDocPart({ path: 'docs/commands/new.md', action: 'create', reason: 'r', current: '', exemplar, exemplarTokens: 10 });
    assert.ok(create.endsWith(`</current>\n\n<exemplar path="docs/commands/serve.md">\n${'line\n'.repeat(8)}[truncated]\n</exemplar>`), create);
    assert.ok(writerDocPart({ path: 'docs/commands/new.md', action: 'create', reason: 'r', current: '', exemplar: { ...exemplar, content: '# s\n' } }).endsWith('<exemplar path="docs/commands/serve.md">\n# s\n</exemplar>'));
    assert.ok(!writerDocPart({ path: 'docs/cli.md', action: 'update', reason: 'r', current: 'x', exemplar }).includes('<exemplar'));
    assert.ok(!writerDocPart({ path: 'docs/x.md', action: 'create', reason: 'r', current: '' }).includes('<exemplar'));
    assert.match(WRITER_SYSTEM, /<exemplar>/);
    assert.match(CHECKER_SYSTEM, /duplicates a doc already in the manifest/);
    assert.match(TRIAGE_SYSTEM, /which\s+existing doc should link to it/);
  });

  test('gate 3: a create is bounded at 3x an exemplar over 400 bytes, and not at all without one', () => {
    const ex = { path: 'docs/commands/serve.md', bytes: 500 };
    assert.deepEqual(gateSize({ action: 'create', content: 'x'.repeat(1700), exemplar: ex }, { target: null }), {
      ok: false,
      reason: 'grew 3.4x the size of docs/commands/serve.md (500 -> 1700 bytes)',
    });
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(1400), exemplar: ex }, { target: null }).ok, true);
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(5000), exemplar: { path: 'a.md', bytes: 300 } }, { target: null }).ok, true, 'floor');
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(5000), exemplar: null }, { target: null }).ok, true);
  });

  test('runGates: an index update whose create was held back is dropped with it', () => {
    const files = { 'README.md': '# r\n', 'docs/cli.md': '# cli\n' };
    const root = tmpRepo(files);
    try {
      const { kept, dropped, orphaned } = runGates(
        [
          { path: 'docs/new.md', action: 'create', content: '# new\n\n' + 'word '.repeat(400) + '\n', exemplar: { path: 'docs/cli.md', bytes: 500 } },
          { path: 'README.md', action: 'update', content: '# r\n\nSee [new](docs/new.md).\n', dependsOn: ['docs/new.md'] },
        ],
        {
          isEditableDoc: makeIsEditableDoc(cfg(), root),
          readCurrent: (p) => files[p] ?? null,
          readTarget: (p) => files[p] ?? null,
          existsInCheckout: (p) => p in files,
          guidelineFiles: new Set(),
          format: { mode: 'off' },
        }
      );
      assert.deepEqual(kept, []);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['docs/new.md', 3]]);
      assert.deepEqual(orphaned, [{ path: 'README.md', reason: 'depends on docs/new.md, which was held back' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('link status comes from the final content, not the plan', () => {
    const kept = [
      { path: 'docs/new.md', action: 'create', content: '# n\n', index: 'docs/index.md', flags: [] },
      { path: 'docs/index.md', action: 'update', content: '# i\n\n- [new](new.md)\n', flags: [] },
      { path: 'docs/lonely.md', action: 'create', content: '# l\n', index: 'README.md', flags: [] },
      { path: 'docs/orphan.md', action: 'create', content: '# o\n', index: null, flags: [] },
      { path: 'docs/old.md', action: 'create', content: '# old\n', index: null, flags: [] },
    ];
    const r = markNewDocLinks(kept, [{ path: 'docs/cli.md', content: '[was broken](old.md)\n' }]);
    assert.deepEqual(r.map((k) => k.linkedFrom), [['docs/index.md'], undefined, [], [], ['docs/cli.md']]);
    assert.deepEqual(r.map((k) => k.flags), [[], [], [{ kind: 'unlinked_new_doc', detail: ['the planned link from README.md was not kept'] }], [{ kind: 'unlinked_new_doc', detail: ['no doc found to link it from'] }], []]);
  });

  test('PR body: New docs between deletes and edits, link status per doc, placement failures held back', () => {
    const k = (path, extra) => ({ path, action: 'create', reason: `Documents ${path}`, check: { action: 'proceed', issues: [] }, flags: [], ...extra });
    const body = renderPrBody({
      target: 'main',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commitCount: 1,
      kept: [
        k('docs/commands/new.md', { linkedFrom: ['docs/index.md'] }),
        k('packages/c/README.md', { linkedFrom: [], flags: [{ kind: 'unlinked_new_doc', detail: ['no doc found to link it from'] }] }),
        { path: 'docs/index.md', action: 'update', reason: 'Link it', check: { action: 'proceed', issues: [] }, flags: [] },
      ],
      deleted: [{ path: 'docs/gone.md', action: 'delete', reason: 'gone', check: { action: 'proceed', issues: [] }, flags: [] }],
      heldBack: [{ path: 'misc/notes.md', reason: 'placement: no docs live near misc/' }],
      carried: [{ path: 'docs/commands/older.md', created: true }, { path: 'docs/cli.md' }],
    });
    const at = ['Deleted this run', 'New docs', 'Edited this run', 'Held back'].map((h) => body.indexOf(`\n#### ${h}\n`));
    assert.ok(at.every((i) => i > 0) && [...at].sort((x, y) => x - y).join() === at.join(), body);
    assert.match(body, /#### New docs\n- `docs\/commands\/new\.md` -- Documents docs\/commands\/new\.md\n  - Checker: ok\n  - Linked from `docs\/index\.md`\n/);
    assert.match(body, /- `packages\/c\/README\.md` -- Documents packages\/c\/README\.md\n  - Checker: ok\n  - \*\*Not linked from any doc\*\* \(no doc found to link it from\)\n/);
    const edited = body.slice(at[2], at[3]);
    assert.ok(edited.includes('`docs/index.md` (update)') && !edited.includes('(create)'), 'creates are not listed as edits');
    assert.match(body, /- `misc\/notes\.md` -- placement: no docs live near misc\//);
    assert.match(body, /- `docs\/commands\/older\.md` \(new\)\n- `docs\/cli\.md`\n/, 'a create carried from an earlier run stays marked as new');
  });
});
