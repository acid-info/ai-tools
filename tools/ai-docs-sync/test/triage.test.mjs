import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { API } from '#core/api.mjs';

import { makeIsEditableDocPath } from '../src/allowlist.mjs';
import { checkerUser } from '../src/checker.mjs';
import { TRIAGE_SYSTEM, parseTriage, renderStaleBlock, triageUser } from '../src/triage.mjs';
import { writerPrefix } from '../src/writer.mjs';
import { cfg } from './helpers.mjs';

describe('triage parser', () => {
  const existing = new Set(['docs/api/architecture.md', 'docs/civi-crm/architecture.md']);
  const opts = { isEditableDocPath: makeIsEditableDocPath(cfg()), exists: (p) => existing.has(p) };
  test('accepts a good answer, decides the action from existence, drops disallowed paths, never caps', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({
      affected: [
        { path: 'docs/api/architecture.md', action: 'create', reason: 'moved', source_files: ['apps/api/x.ts', '../../evil'] },
        { path: 'content/blog/x.md', action: 'update', reason: 'no' },
        { path: 'docs/../../x.md', action: 'update', reason: 'no' },
        { path: 'apps/api/README.md', action: 'update', reason: 'new app' },
        { path: 'docs/api/architecture.md', action: 'update', reason: 'dupe' },
        ...Array.from({ length: 12 }, (_, i) => ({ path: `docs/extra-${i}.md`, action: 'create', reason: 'more' })),
      ],
      delete_candidates: [{ path: 'docs/civi-crm/architecture.md', reason: 'legacy field' }],
      unaffected_reason: '',
    })}\n\`\`\``;
    const r = parseTriage(text, opts);
    assert.deepEqual(r.affected.slice(0, 2).map((a) => [a.path, a.action]), [['docs/api/architecture.md', 'update'], ['apps/api/README.md', 'create']]);
    assert.equal(r.affected.length, 14, 'no per-run cap');
    assert.deepEqual(r.affected[0].source_files, ['apps/api/x.ts']);
    assert.deepEqual(r.dropped.map((d) => d.path), ['content/blog/x.md', 'docs/../../x.md']);
    assert.equal('overflow' in r, false);
    assert.deepEqual(r.deletes, [], 'legacy delete_candidates ignored');
  });
  test('a delete is kept for an existing doc and dropped for a missing one', () => {
    const r = parseTriage(
      JSON.stringify({
        affected: [
          { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'CRM app removed', source_files: ['apps/civi-crm/index.ts'] },
          { path: 'docs/never-was.md', action: 'delete', reason: 'x' },
        ],
      }),
      opts
    );
    assert.deepEqual(r.deletes, [{ path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'CRM app removed', source_files: ['apps/civi-crm/index.ts'] }]);
    assert.deepEqual(r.affected, []);
    assert.deepEqual(r.dropped, [{ path: 'docs/never-was.md', reason: 'delete of a doc that does not exist' }]);
  });
  test('delete beats update on the same path, in either order', () => {
    for (const order of [['update', 'delete'], ['delete', 'update']]) {
      const r = parseTriage(JSON.stringify({ affected: order.map((action) => ({ path: 'docs/api/architecture.md', action, reason: action })) }), opts);
      assert.deepEqual(r.deletes.map((d) => d.path), ['docs/api/architecture.md'], order.join(','));
      assert.deepEqual(r.affected, []);
    }
  });
  test('returns null on unparseable or schema-less output', () => {
    assert.equal(parseTriage('not json', opts), null);
    assert.equal(parseTriage('{"foo": 1}', opts), null);
  });
  test('empty affected is a valid, complete answer', () => {
    const r = parseTriage('{"affected": [], "unaffected_reason": "deps only"}', opts);
    assert.equal(r.affected.length, 0);
    assert.equal(r.unaffectedReason, 'deps only');
  });
  test('the prompt offers delete and no longer asks for delete_candidates', () => {
    assert.match(TRIAGE_SYSTEM, /"update" \| "create" \| "delete"/);
    assert.ok(!TRIAGE_SYSTEM.includes('delete_candidates'));
  });
});

describe('stale edits go back to triage', () => {
  const stale = () =>
    renderStaleBlock({
      docs: ['docs/api.md'],
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commits: [{ short: 'c0ffee1', subject: 'feat(server): read PORT' }],
      diff: '--- FILE: src/server.js (M) ---\n+const PORT = 8080;',
      current: { 'docs/api.md': '# HTTP API\n\nListens on 3000.\n' },
    });

  test('the block names the docs, the earlier range, its commits and its diff', () => {
    const text = stale();
    assert.match(text, /^<stale_edits>\n.*discarded: docs\/api\.md\n/);
    assert.match(text, /\(aaaaaaa\.\.bbbbbbb, already on the target branch before this range\)/);
    assert.match(text, /Commits:\n- c0ffee1 feat\(server\): read PORT/);
    assert.match(text, /<earlier_diff>\n--- FILE: src\/server\.js \(M\) ---\n\+const PORT = 8080;\n<\/earlier_diff>\n/);
    assert.match(text, /<stale_doc path="docs\/api\.md">\n# HTTP API\n\nListens on 3000\.\n<\/stale_doc>\n<\/stale_edits>$/, 'triage sees the current text');
    assert.match(renderStaleBlock({ docs: ['docs/big.md'], current: { 'docs/big.md': null } }), /<stale_doc path="docs\/big\.md">\(too large to include\)<\/stale_doc>/);
    assert.match(renderStaleBlock({ docs: ['docs/api.md'] }), /inside <diff>/, 'no earlier diff when the range already covers it');
    assert.equal(renderStaleBlock({ docs: [] }), '');
  });

  test('triage, writer prefix and checker all carry it; nothing changes without it', () => {
    const base = { guidelines: 'g', narrative: 'n', diff: 'd', manifest: 'm' };
    assert.equal(triageUser(base), triageUser({ ...base, stale: '' }));
    assert.ok(!triageUser(base).includes('stale_edits'));
    assert.ok(triageUser({ ...base, stale: stale() }).endsWith(stale()), 'last, so the prefix up to the manifest is unchanged');
    assert.equal(writerPrefix({ ...base, stale: stale() }), triageUser({ ...base, stale: stale() }));
    assert.match(checkerUser({ narrative: 'n', diff: 'd', docs: [], stale: stale() }), /<earlier_diff>/);
    assert.match(TRIAGE_SYSTEM, /<stale_edits> block is present, re-evaluate every doc it lists/);
  });

  test('a discarded delete is named as a delete, next to discarded edits', () => {
    const text = renderStaleBlock({ docs: [{ path: 'docs/a.md', kind: 'edit' }, { path: 'docs/b.md', kind: 'delete' }], current: { 'docs/a.md': 'a', 'docs/b.md': 'b' } });
    assert.match(text, /edit was discarded: docs\/a\.md\n/);
    assert.match(text, /deleted these docs, but the target branch changed them before the delete merged, so the delete was discarded: docs\/b\.md\n/);
    assert.match(text, /<stale_doc path="docs\/b\.md">\nb\n<\/stale_doc>/, 'current text included so triage can re-nominate it');
  });
});
