import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { applyReviewerDecisions, classifyReviewerChanges, fixupsOfRevertedDelete, foreignBranchCommit, parseReviewerDecisions, planCarryForward, reconcileReviewerCarry, renderReviewerDecisions } from '../src/carry.mjs';
import { PR_BODY_MAX } from '../src/config.mjs';
import { BOT_EMAIL, isToolCommit } from '../src/git.mjs';
import { inboundLinks } from '../src/links.mjs';
import { buildManifest } from '../src/manifest.mjs';
import { applyInboundLinks, dropOrphanedDependents, planCreates } from '../src/plan.mjs';
import { renderPrBody } from '../src/pr-body.mjs';
import { commitMessage } from '../src/publish.mjs';
import { TRIAGE_SYSTEM, renderReviewerBlock, renderStaleBlock, triageUser } from '../src/triage.mjs';
import { WRITER_SYSTEM, writerPrefix } from '../src/writer.mjs';
import { cfg, tmpRepo } from './helpers.mjs';

describe('carry forward (read side) and guidelines', () => {
  test('ownership: tool commits, merges and doc additions, edits and deletes by others are fine; anything else is foreign', () => {
    const m = (path) => ({ status: 'M', path });
    const changes = {
      tool: [m('docs/a.md')],
      merge: [m('src/x.ts')],
      suggestion: [m('docs/a.md'), { status: 'A', path: 'docs/new.md' }],
      code: [m('docs/a.md'), m('src/x.ts')],
      removal: [{ status: 'D', path: 'docs/a.md' }],
      rename: [{ status: 'R', path: 'docs/b.md', oldPath: 'docs/a.md' }],
      copy: [{ status: 'C', path: 'docs/b.md', oldPath: 'docs/a.md' }],
      renameOut: [{ status: 'R', path: 'src/a.md', oldPath: 'docs/a.md' }],
      renameIn: [{ status: 'R', path: 'docs/a.md', oldPath: 'src/a.md' }],
      codeDelete: [{ status: 'D', path: 'src/x.ts' }],
      nonMarkdown: [{ status: 'A', path: 'docs/diagram.png' }],
    };
    const opts = { changesOf: (sha) => changes[sha], isEditableDoc: (f) => f.startsWith('docs/') && f.endsWith('.md') };
    const tool = { sha: 'tool', email: BOT_EMAIL, authorEmail: BOT_EMAIL, parents: ['p'] };
    const web = 'noreply@github.com';
    const merge = { sha: 'merge', email: web, authorEmail: 'human@x', parents: ['a', 'b'] };
    const suggestion = { sha: 'suggestion', email: web, authorEmail: 'human@x', parents: ['p'] };
    const code = { sha: 'code', email: 'human@x', authorEmail: 'human@x', parents: ['p'] };
    assert.equal(foreignBranchCommit([], opts), null, 'nothing on top of the target');
    assert.equal(foreignBranchCommit([tool], opts), null);
    assert.equal(foreignBranchCommit([merge, suggestion, tool], opts), null);
    assert.equal(foreignBranchCommit([code, tool], opts), code);
    assert.equal(foreignBranchCommit([suggestion], opts), suggestion, 'a branch the tool never committed to');
    const removal = { ...suggestion, sha: 'removal' };
    assert.equal(foreignBranchCommit([removal], opts), removal, 'a reviewer delete alone is not a branch the tool owns');
    const rebased = { ...tool, email: web };
    assert.equal(foreignBranchCommit([rebased], opts), null, '"Update with rebase" keeps the tool as author');
    for (const sha of ['removal', 'rename', 'copy']) assert.equal(foreignBranchCommit([{ ...suggestion, sha }, tool], opts), null, `a reviewer ${sha} is carried`);
    for (const sha of ['renameOut', 'renameIn', 'codeDelete', 'nonMarkdown']) {
      const c = { ...suggestion, sha };
      assert.equal(foreignBranchCommit([c, tool], opts), c, `${sha} still refuses`);
    }
  });

  test('carry-forward plan: restore, tombstones, stale by kind, obsolete, ignored', () => {
    const target = new Set(['docs/a.md', 'docs/b.md', 'docs/d.md', 'docs/e.md', 'docs/new-on-target.md']);
    const changedOnTarget = new Set(['docs/b.md', 'docs/e.md', 'docs/gone.md', 'docs/gone-del.md', 'docs/new-on-target.md']);
    const plan = planCarryForward({
      branchChanges: [
        { status: 'M', path: 'docs/a.md' },
        { status: 'M', path: 'docs/b.md' },
        { status: 'A', path: 'docs/c.md' },
        { status: 'D', path: 'docs/d.md' },
        { status: 'D', path: 'docs/e.md' },
        { status: 'M', path: 'docs/gone.md' },
        { status: 'D', path: 'docs/gone-del.md' },
        { status: 'A', path: 'docs/new-on-target.md' },
        { status: 'M', path: 'src/x.ts' },
        { status: 'T', path: 'docs/t.md' },
      ],
      targetHas: (f) => target.has(f),
      targetChangedSinceBase: (f) => changedOnTarget.has(f),
      isEditableDoc: (f) => f.endsWith('.md') && f.startsWith('docs/'),
    });
    assert.deepEqual(plan, {
      restore: ['docs/a.md', 'docs/c.md'],
      restoreDeletes: ['docs/d.md'],
      stale: [
        { path: 'docs/b.md', kind: 'edit' },
        { path: 'docs/e.md', kind: 'delete' },
        { path: 'docs/new-on-target.md', kind: 'edit' },
      ],
      obsolete: ['docs/gone.md', 'docs/gone-del.md'],
      ignored: ['src/x.ts', 'docs/t.md'],
    });
  });

});

describe('reviewer decisions', () => {
  const web = 'noreply@github.com';
  const tool = (sha, extra = {}) => ({ sha, email: BOT_EMAIL, authorEmail: BOT_EMAIL, parents: ['p'], subject: 'docs(x): sync', body: '', ...extra });
  const human = (sha, extra = {}) => ({ sha, email: web, authorEmail: 'human@x', parents: ['p'], subject: 'review', body: '', ...extra });
  const editable = (p) => /^(docs\/.*|README)\.md$/.test(p);
  // `changes` maps a sha to its changes; `base` and `remote` are the paths present at each end.
  const classify = ({ commits, changes, base, remote, previous }) =>
    classifyReviewerChanges({
      commits,
      changesOf: (sha) => changes[sha] ?? [],
      baseHas: (p) => base.includes(p),
      remoteHas: (p) => remote.includes(p),
      isEditableDoc: editable,
      previous,
    });

  test('a rebased tool commit is still the tool: GitHub commits it, the tool stays the author', () => {
    assert.ok(isToolCommit(tool('t')));
    assert.ok(isToolCommit(tool('t', { email: web })));
    assert.ok(!isToolCommit(human('h')));
  });

  test('every row of the table', () => {
    const got = classify({
      commits: [tool('t'), human('h1'), human('h2')],
      changes: {
        t: [{ status: 'D', path: 'docs/tool-gone.md' }],
        h1: [
          { status: 'D', path: 'docs/a.md' },
          { status: 'D', path: 'docs/tool-new.md' },
          { status: 'A', path: 'docs/tool-gone.md' },
          { status: 'A', path: 'docs/mine.md' },
        ],
        h2: [
          { status: 'R', oldPath: 'docs/b.md', path: 'docs/c.md' },
          { status: 'R', oldPath: 'docs/other-new.md', path: 'docs/moved-new.md' },
          { status: 'M', path: 'docs/m.md' },
        ],
      },
      base: ['docs/a.md', 'docs/b.md', 'docs/tool-gone.md', 'docs/m.md'],
      remote: ['docs/tool-gone.md', 'docs/mine.md', 'docs/c.md', 'docs/moved-new.md', 'docs/m.md'],
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/other-new.md' },
      { kind: 'declined-create', path: 'docs/tool-new.md' },
      { kind: 'declined-delete', path: 'docs/tool-gone.md' },
    ]);
  });

  test('several reviewer commits in order: the latest change on a path decides', () => {
    const base = ['docs/p.md', 'docs/q.md'];
    const d = (path) => ({ status: 'D', path });
    const a = (path) => ({ status: 'A', path });
    // Tool deleted q; the reviewer restored it, then deleted it again: a reviewer delete now.
    // The reviewer deleted p, then restored it: they do not want it deleted.
    // n was new: added, declined, re-added: nothing to remember.
    const got = classify({
      commits: [tool('t'), human('1'), human('2'), human('3')],
      changes: { t: [d('docs/q.md')], 1: [a('docs/q.md'), d('docs/p.md'), a('docs/n.md')], 2: [d('docs/q.md'), a('docs/p.md'), d('docs/n.md')], 3: [a('docs/n.md')] },
      base,
      remote: ['docs/p.md', 'docs/n.md'],
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/q.md' },
      { kind: 'declined-delete', path: 'docs/p.md' },
    ]);
  });

  test('merges, tool commits and anything before the newest tool commit are skipped', () => {
    const got = classify({
      commits: [human('old'), tool('t1'), human('merge', { parents: ['a', 'b'] }), tool('t2', { email: web }), human('h')],
      changes: {
        old: [{ status: 'D', path: 'docs/folded.md' }],
        t2: [{ status: 'D', path: 'docs/tool.md' }],
        merge: [{ status: 'D', path: 'docs/merged.md' }],
        h: [{ status: 'D', path: 'docs/x.md' }],
      },
      base: ['docs/folded.md', 'docs/tool.md', 'docs/merged.md', 'docs/x.md'],
      remote: [],
    });
    assert.deepEqual(got, [{ kind: 'deleted', path: 'docs/x.md' }]);
  });

  test('previous decisions carry and are revalidated; contradicted ones disappear', () => {
    const previous = [
      { kind: 'deleted', path: 'docs/still.md' },
      { kind: 'deleted', path: 'docs/back.md' },
      { kind: 'declined-create', path: 'docs/created-anyway.md' },
      { kind: 'declined-create', path: 'docs/still-declined.md' },
      { kind: 'declined-delete', path: 'docs/deleted-anyway.md' },
      { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
      { kind: 'renamed', path: 'docs/s.md', to: 'docs/s2.md' },
      { kind: 'deleted', path: 'src/not-a-doc.md' },
    ];
    const got = classify({
      commits: [tool('t')],
      changes: {},
      base: ['docs/still.md', 'docs/back.md', 'docs/deleted-anyway.md', 'docs/r.md', 'docs/s.md', 'src/not-a-doc.md'],
      remote: ['docs/back.md', 'docs/created-anyway.md', 'docs/r2.md'],
      previous,
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/s.md' },
      { kind: 'deleted', path: 'docs/still.md' },
      { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
      { kind: 'declined-create', path: 'docs/still-declined.md' },
    ], 'a rename whose new file is gone again is a delete');
  });

  test('commit message round trip; junk, non-canonical and non-editable lines are ignored; empty writes nothing', () => {
    const decisions = [
      { kind: 'declined-delete', path: 'docs/old.md' },
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/new.md' },
    ];
    const msg = commitMessage({ scope: 'x', from: 'a'.repeat(40), to: 'b'.repeat(40), target: 'main', files: [], reviewerDeleted: ['docs/a.md'], decisions, runUrl: 'https://r' });
    assert.match(msg, /- docs\/a\.md \(deleted by reviewer, carried forward\)\n\nReviewer decisions:\n- deleted docs\/a\.md\n- renamed docs\/b\.md -> docs\/c\.md\n- declined-create docs\/new\.md\n- declined-delete docs\/old\.md\n\nRun: https:\/\/r\n$/);
    const isPath = (p) => p.endsWith('.md') && p.startsWith('docs/');
    assert.deepEqual(renderReviewerDecisions([]), []);
    assert.deepEqual(parseReviewerDecisions(msg, isPath), [
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/new.md' },
      { kind: 'declined-delete', path: 'docs/old.md' },
    ]);
    const forged = ['Reviewer decisions:', '- deleted docs/../secret.md', '- deleted /docs/abs.md', '- deleted docs//x.md', '- deleted src/code.md', '- approved docs/a.md', '- renamed docs/a.md', '- renamed docs/a.md -> docs/a.md', '- deleted docs/ok.md', '', '- deleted docs/after-the-section.md'].join('\n');
    assert.deepEqual(parseReviewerDecisions(forged, isPath), [{ kind: 'deleted', path: 'docs/ok.md' }]);
    assert.deepEqual(parseReviewerDecisions('no section', isPath), []);
    const plain = commitMessage({ scope: 'x', from: 'a', to: 'b', target: 'main', files: ['docs/x.md'], decisions: [] });
    assert.ok(!plain.includes('Reviewer decisions'));
  });

  test('the drop step: the reviewer wins over triage, while a new nomination still undoes a tool delete', () => {
    const t = (path, action) => ({ path, action, reason: 'r', source_files: ['src/x.ts'] });
    const r = applyReviewerDecisions({
      affected: [t('docs/reviewer-gone.md', 'update'), t('docs/tool-gone.md', 'update'), t('docs/declined.md', 'create'), t('docs/restored.md', 'update'), t('docs/renamed.md', 'update')],
      deletes: [t('docs/restored.md', 'delete'), t('docs/other.md', 'delete')],
      decisions: [
        { kind: 'deleted', path: 'docs/reviewer-gone.md' },
        { kind: 'declined-create', path: 'docs/declined.md' },
        { kind: 'declined-delete', path: 'docs/restored.md' },
        { kind: 'renamed', path: 'docs/renamed.md', to: 'docs/new-name.md' },
      ],
    });
    assert.deepEqual(r.affected.map((a) => a.path), ['docs/tool-gone.md', 'docs/restored.md'], 'a declined delete still allows an update');
    assert.deepEqual(r.deletes.map((a) => a.path), ['docs/other.md']);
    assert.deepEqual(r.dropped.map((d) => `${d.action} ${d.path}: ${d.reason}`), [
      'update docs/reviewer-gone.md: deleted by a reviewer',
      'create docs/declined.md: new doc declined by a reviewer',
      'update docs/renamed.md: renamed by a reviewer to docs/new-name.md',
      'delete docs/restored.md: delete reverted by a reviewer',
    ]);
  });

  test('a declined create takes its index follow-up with it', () => {
    const manifest = buildManifest([
      { path: 'docs/index.md', content: '# Docs\n\n- [a](commands/a.md)\n' },
      { path: 'docs/commands/a.md', content: '# a\n' },
    ]);
    const create = { path: 'docs/commands/b.md', action: 'create', reason: 'New command b', source_files: ['src/b.js'] };
    assert.equal(planCreates({ affected: [create], manifest }).indexTasks.length, 1, 'without the decision there is a follow-up');
    const ruled = applyReviewerDecisions({ affected: [create], deletes: [], decisions: [{ kind: 'declined-create', path: 'docs/commands/b.md' }] });
    const plan = planCreates({ affected: ruled.affected, manifest });
    assert.deepEqual([plan.affected, plan.indexTasks], [[], []]);
  });

  test('link fix-ups for reviewer deletes depend on nothing; a rename names the new path', () => {
    const files = [
      { path: 'README.md', content: '[api](docs/api.md) and [cli](docs/cli.md) and [gone](docs/gone.md)\n' },
      { path: 'docs/index.md', content: '[cli](cli.md)\n' },
      { path: 'docs/specs/s.md', content: '[api](../api.md)\n' },
    ];
    const reviewer = [
      { kind: 'deleted', path: 'docs/api.md' },
      { kind: 'renamed', path: 'docs/cli.md', to: 'docs/client.md' },
    ];
    const toolDelete = { path: 'docs/gone.md', action: 'delete', reason: 'Gone', source_files: ['src/gone.ts'], flags: [] };
    const r = applyInboundLinks({
      affected: [],
      deletes: [toolDelete],
      reviewer,
      inbound: inboundLinks(files, ['docs/gone.md', 'docs/api.md', 'docs/cli.md']),
      isEditableDoc: (p) => !p.startsWith('docs/specs/'),
    });
    const byPath = new Map(r.affected.map((t) => [t.path, t]));
    assert.deepEqual(byPath.get('README.md').dependsOn, ['docs/gone.md'], 'a shared linker keeps the tool delete it depends on');
    assert.match(byPath.get('README.md').reason, /deleted by a reviewer/);
    assert.equal(byPath.get('docs/index.md').dependsOn, undefined);
    assert.equal(byPath.get('docs/index.md').reason, 'Retarget the link(s) to docs/cli.md to docs/client.md, renamed by a reviewer.');
    assert.deepEqual(Object.fromEntries(r.reviewerFixups), { 'docs/api.md': ['README.md'], 'docs/cli.md': ['README.md', 'docs/index.md'] });
    assert.deepEqual(r.deletes[0].flags, [], 'reviewer linkers never flag the tool delete');
    const survivors = dropOrphanedDependents(r.affected.filter((t) => t.path !== 'README.md'), new Set());
    assert.deepEqual(survivors.kept.map((t) => t.path), ['docs/index.md'], 'nothing to be orphaned by');
  });

  test('fix-ups of a reverted delete: a carried link removal goes back to triage, an unrelated edit stays', () => {
    const target = {
      'docs/index.md': '# Index\n\n- [v](commands/version.md)\n- [g](commands/greet.md)\n',
      'README.md': '# R\n\nSee [version](docs/commands/version.md).\n',
    };
    const carried = new Map([
      ['docs/index.md', { content: '# Index\n\n- [g](commands/greet.md)\n' }],
      ['README.md', { content: '# R\n\nSee [version](docs/commands/version.md). Now with more.\n' }],
      ['docs/new.md', { content: '# New\n' }],
    ]);
    assert.deepEqual(fixupsOfRevertedDelete('docs/commands/version.md', carried, (p) => target[p] ?? null), ['docs/index.md']);
  });

  test('a stale reviewer tombstone is discarded and reported, not sent to triage; an obsolete one just goes', () => {
    const r = reconcileReviewerCarry({
      decisions: [
        { kind: 'deleted', path: 'docs/changed.md' },
        { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
        { kind: 'deleted', path: 'docs/removed-on-target.md' },
        { kind: 'deleted', path: 'docs/live.md' },
        { kind: 'declined-delete', path: 'docs/kept.md' },
      ],
      stale: [
        { path: 'docs/changed.md', kind: 'delete' },
        { path: 'docs/r.md', kind: 'delete' },
        { path: 'docs/tool-delete.md', kind: 'delete' },
        { path: 'docs/edit.md', kind: 'edit' },
      ],
      obsolete: ['docs/removed-on-target.md', 'docs/other.md'],
    });
    assert.deepEqual(r.stale, [{ path: 'docs/tool-delete.md', kind: 'delete' }, { path: 'docs/edit.md', kind: 'edit' }]);
    assert.deepEqual(r.discarded.map((d) => d.path), ['docs/changed.md', 'docs/r.md']);
    assert.deepEqual(r.decisions, [{ kind: 'deleted', path: 'docs/live.md' }, { kind: 'declined-delete', path: 'docs/kept.md' }]);
  });

  test('triage sees the decisions; a requeued fix-up is named with its own reason', () => {
    const block = renderReviewerBlock([
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/n.md' },
      { kind: 'declined-delete', path: 'docs/o.md' },
    ]);
    assert.equal(block, '<reviewer_decisions>\nDeleted by a reviewer: docs/a.md\nRenamed by a reviewer: docs/b.md -> docs/c.md\nNew docs a reviewer declined: docs/n.md\nDeletes a reviewer reverted: docs/o.md\n</reviewer_decisions>');
    assert.equal(renderReviewerBlock([]), '');
    assert.ok(triageUser({ narrative: 'n', diff: 'd', manifest: 'm', reviewer: block }).endsWith(block));
    assert.match(TRIAGE_SYSTEM, /<reviewer_decisions>/);
    assert.match(WRITER_SYSTEM, /keep every existing link to a doc whose delete a\s+reviewer reverted/);
    const prefix = writerPrefix({ narrative: 'n', diff: 'd', manifest: 'm', reviewer: block, deleted: [{ path: 'docs/a.md', reason: 'deleted by a reviewer' }] });
    assert.ok(prefix.indexOf(block) > 0 && prefix.indexOf(block) < prefix.indexOf('<deleted_this_run>'));
    const stale = renderStaleBlock({ docs: [{ path: 'docs/index.md', kind: 'edit', reason: 'the delete they followed was reverted by a reviewer' }], from: 'a', to: 'b' });
    assert.match(stale, /the edit was discarded because the delete they followed was reverted by a reviewer: docs\/index\.md/);
    assert.ok(!stale.includes('target branch changed'));
  });

  test('PR body: reviewer section after the deletes, reviewer guideline banner, never cut by the size budget', () => {
    const reviewer = [
      { kind: 'deleted', path: 'docs/api.md', fixed: ['README.md'], linkers: ['docs/specs/s.md'] },
      { kind: 'deleted', path: 'CLAUDE.md', flags: [{ kind: 'guideline_delete', detail: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +0,0 @@\n-rule\n' }] },
      { kind: 'renamed', path: 'docs/cli.md', to: 'docs/client.md', fixed: ['docs/index.md'] },
      { kind: 'declined-create', path: 'docs/commands/wave.md' },
      { kind: 'declined-delete', path: 'docs/commands/version.md', requeued: [{ path: 'docs/index.md', redone: false }] },
      { kind: 'discarded', path: 'docs/was.md', requeued: [{ path: 'README.md', redone: true }] },
    ];
    const body = renderPrBody({
      repo: 'o/r',
      target: 'main',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commitCount: 1,
      deleted: [{ path: 'docs/gone.md', action: 'delete', reason: 'gone', check: { action: 'proceed', issues: [] }, flags: [] }],
      reviewer,
      kept: [{ path: 'docs/new.md', action: 'create', reason: 'n', check: { action: 'proceed', issues: [] }, flags: [], linkedFrom: [] }],
    });
    assert.ok(body.startsWith('> [!WARNING]\n> **Guideline file deleted by a reviewer: `CLAUDE.md`.**'), body.slice(0, 200));
    const at = ['Deleted this run', 'Reviewer changes on this branch', 'New docs'].map((h) => body.indexOf(`\n#### ${h}\n`));
    assert.ok(at.every((i) => i > 0) && [...at].sort((x, y) => x - y).join() === at.join());
    const section = body.slice(at[1], at[2]);
    assert.match(section, /- `docs\/api\.md` deleted by a reviewer\. To undo, restore the file on the branch \(\[bbbbbbb copy\]\(https:\/\/github\.com\/o\/r\/blob\/b{40}\/docs\/api\.md\)\)\.\n  - Links to it fixed this run in `README\.md`\n  - Still linked from `docs\/specs\/s\.md`\n/);
    assert.match(section, /- `docs\/cli\.md` renamed to `docs\/client\.md` by a reviewer\. To undo, rename it back on the branch\.\n  - Links to it fixed this run in `docs\/index\.md`/);
    assert.match(section, /- `docs\/commands\/wave\.md` new doc declined by a reviewer; not created again while this PR is open\. To undo, add the file back on the branch\./);
    assert.match(section, /- `docs\/commands\/version\.md` delete reverted by a reviewer; not deleted again while this PR is open\. To undo, delete it again on the branch\.\n  - The carried link fix-up in `docs\/index\.md` was discarded and sent back to triage: not selected again\./);
    assert.match(section, /- Reviewer delete of `docs\/was\.md` discarded because `main` changed the file; delete it again on the branch if still wanted\.\n  - The carried link fix-up in `README\.md` was discarded and sent back to triage: redone this run\./);

    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'deleted', path: `docs/reviewer-removed-${i}/a-long-document-name-${i}.md`, fixed: [], linkers: [] }));
    const thousands = Array.from({ length: 3000 }, (_, i) => ({ path: `docs/many/doc-${i}.md`, action: 'update', reason: 'x'.repeat(200), check: { action: 'proceed', issues: [] }, flags: [] }));
    const cut = renderPrBody({ target: 'main', from: 'a', to: 'b', commitCount: 1, kept: thousands, reviewer: many });
    assert.ok(cut.length <= PR_BODY_MAX);
    for (const r of many) assert.ok(cut.includes(`\`${r.path}\` deleted by a reviewer`), r.path);
  });
});
