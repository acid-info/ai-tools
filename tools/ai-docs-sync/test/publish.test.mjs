import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { API } from '#core/api.mjs';
import { costOf } from '#core/models.mjs';
import { makeUsageLog } from '#core/usage.mjs';

import { MARKER_MAX_CHARS, PR_BODY_MAX } from '../src/config.mjs';
import { BOT_EMAIL, gitAuthEnv } from '../src/git.mjs';
import { narrativeOutline } from '../src/narrative.mjs';
import { blobUrl, renderPrBody } from '../src/pr-body.mjs';
import { commitMessage, commitScope, lastRunFor, parseMarker, prTitle, regenerateFrom, renderMarker } from '../src/publish.mjs';

describe('publishing helpers', () => {
  test('commit scope, subject and body follow the fixed template', () => {
    assert.equal(commitScope('docs/web/sync'), 'web');
    assert.equal(commitScope('docs-sync'), 'repo');
    const msg = commitMessage({ scope: 'web', from: 'a'.repeat(40), to: 'b'.repeat(40), target: 'develop', files: ['docs/x.md'], deleted: ['docs/gone.md'], carried: ['README.md'], carriedDeleted: ['docs/old.md'], runUrl: 'https://r' });
    assert.match(msg, /^docs\(web\): sync with aaaaaaa\.\.bbbbbbb\n\nRange: a{40}\.\.b{40} on develop\n\nFiles:\n- docs\/x\.md\n- docs\/gone\.md \(deleted\)\n- README\.md \(carried forward\)\n- docs\/old\.md \(deleted, carried forward\)\n\nRun: https:\/\/r\n$/);
    assert.ok(!/co-authored|generated/i.test(msg));
    assert.equal(prTitle({ scope: 'web', target: 'develop', to: 'c'.repeat(40) }), 'docs(web): sync docs with develop (up to ccccccc)');
  });

  test('the push credential is an env-only extraheader that disables stored credentials', () => {
    const env = gitAuthEnv('tok');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_1, '');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  test('marker round-trips, cannot be closed from inside, and ignores junk', () => {
    const runs = [{ at: '2026-09-23T00:00:00Z', from: 'abc', to: 'def', files: ['docs/a-->b.md'] }];
    const marker = renderMarker(runs);
    assert.equal(marker.indexOf('-->'), marker.length - 3, 'only the real terminator');
    assert.deepEqual(parseMarker(`text\n${marker}\n`), runs);
    assert.deepEqual(parseMarker('<!-- ai-docs-sync {"v":1,"runs":[{"from":"zz;rm","files":["../x.md","ok.md",3]}]} -->'), [{ at: '', from: '', to: '', files: ['ok.md'] }]);
    assert.deepEqual(parseMarker('no marker'), []);
    assert.deepEqual(parseMarker('<!-- ai-docs-sync {broken -->'), []);
    const many = Array.from({ length: 30 }, (_, i) => ({ at: '', from: String(i), to: '', files: [] }));
    assert.equal(renderMarker(many).match(/"from":/g).length, 20, 'keeps the last 20');
    const wide = [{ at: '', from: 'a', to: 'b', files: Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`) }];
    assert.equal(parseMarker(renderMarker(wide))[0].files.length, 300, 'no per-run file cap');
    const big = Array.from({ length: 10 }, (_, i) => ({ at: '', from: `${i}`, to: '', files: Array.from({ length: 200 }, (_, j) => `docs/run${i}/file-${j}.md`) }));
    const sized = renderMarker(big);
    assert.ok(sized.length <= MARKER_MAX_CHARS, `${sized.length}`);
    const left = parseMarker(sized);
    assert.ok(left.length < 10 && left.length >= 1);
    assert.equal(left.at(-1).from, '9', 'the oldest runs go first');
    assert.equal(parseMarker(renderMarker([big[0]], 100)).length, 1, 'the newest run always stays');
    const hist = [{ from: 'f1', to: '1', files: ['a.md'] }, { from: 'f2', to: '2', files: ['a.md', 'b.md'] }];
    assert.equal(lastRunFor(hist, 'a.md').to, '2');
    assert.equal(regenerateFrom(hist, 'a.md', 'base'), 'f1', 'the earliest run that touched it');
    assert.equal(regenerateFrom(hist, 'c.md', 'base'), 'base');
  });

  test('narrative outline has PR titles and subjects only', () => {
    const commits = [
      { sha: 's1', short: 's1', email: 'a@x', parents: ['p'], subject: 'feat: one', body: 'long body' },
      { sha: 's2', short: 's2', email: BOT_EMAIL, parents: ['p'], subject: 'docs: sync', body: '' },
      { sha: 's3', short: 's3', email: 'b@x', parents: ['p'], subject: 'fix: loose', body: '' },
    ];
    const outline = narrativeOutline({ commits, linked: new Map([['s1', 5]]), prs: new Map([[5, { title: 'PR five' }]]) });
    assert.deepEqual(outline, [
      { pr: { number: 5, title: 'PR five' }, commits: [{ short: 's1', subject: 'feat: one' }] },
      { pr: null, commits: [{ short: 's3', subject: 'fix: loose' }] },
    ]);
  });
});

describe('PR body', () => {
  const base = () => ({
    repo: 'o/r',
    target: 'develop',
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    commitCount: 3,
    runUrl: 'https://github.com/o/r/actions/runs/1',
    kept: [
      {
        path: 'docs/api.md',
        action: 'update',
        reason: 'Endpoint moved; thanks @alice, fixes #12 <!--',
        check: { action: 'correct', issues: [{ severity: 'must', note: 'Claims hCaptcha <b>still</b> runs' }] },
        corrected: true,
        dashesFixed: 2,
        flags: [{ kind: 'new_urls', detail: ['https://evil.example/@x'] }],
      },
      {
        path: 'AGENTS.md',
        action: 'update',
        reason: 'Commands changed',
        check: { action: 'proceed', unchecked: true, issues: [] },
        flags: [{ kind: 'guideline_edit', detail: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new ``` closes #3\n' }],
      },
    ],
    deleted: [
      {
        path: 'docs/crm (old).md',
        action: 'delete',
        reason: 'CRM app removed',
        check: { action: 'proceed', issues: [] },
        flags: [{ kind: 'broken_inbound_links', detail: ['docs/specs/x.md'] }],
      },
      {
        path: 'apps/crm/CLAUDE.md',
        action: 'delete',
        reason: 'CRM app removed',
        check: { action: 'proceed', issues: [] },
        flags: [{ kind: 'guideline_delete', detail: '--- a/apps/crm/CLAUDE.md\n+++ b/apps/crm/CLAUDE.md\n@@ -1,1 +0,0 @@\n-rule\n' }],
      },
    ],
    carried: [{ path: 'README.md', run: { from: '1111111aaa', to: '2222222bbb' } }, { path: 'docs/was.md', deleted: true }],
    stale: [
      { path: 'docs/old.md', since: 'c'.repeat(40), redone: false },
      { path: 'docs/api.md', since: 'd'.repeat(40), redone: true },
      { path: 'docs/del.md', since: 'e'.repeat(40), redone: false, kind: 'delete' },
    ],
    dropped: [{ path: 'docs/bad.md', gate: 2, reason: 'broken relative link(s): ./@nope.md' }],
    heldBack: [{ path: 'docs/huge.md', reason: 'too large for a full rewrite in v1' }],
    suggestedDeletes: [{ path: 'docs/gone.md', reason: 'App removed', why: 'no cited source file is in the diff' }],
    omittedDiff: ['big/file.ts'],
    outline: [{ pr: { number: 153, title: 'refactor: move funnel, closes #99' }, commits: [{ short: 'abc1234', subject: 'refactor @bob' }] }],
    usage: { entries: [{ label: 'triage', model: 'claude-sonnet-5', input: 10, cacheRead: 0, output: 5, cost: 0.001 }], total: 0.001, unpriced: [] },
    runs: [{ at: 't', from: 'a', to: 'b', files: ['docs/api.md', 'AGENTS.md', 'docs/crm (old).md', 'apps/crm/CLAUDE.md'] }],
  });

  test('renders every section, bannered guideline diffs first, everything defused', () => {
    const body = renderPrBody(base());
    assert.ok(body.startsWith('> [!WARNING]\n> **Guideline file deleted: `apps/crm/CLAUDE.md`.**'), 'delete banner at the very top');
    assert.match(body, /> \*\*Guideline file edited: `AGENTS\.md`\.\*\*/);
    assert.match(body, /````diff\n[\s\S]*\+new ``` closes #​3\n````/, 'fence outlasts the backticks in the diff, keyword defused');
    const headings = ['Deleted this run', 'Edited this run', 'Carried forward', 'Earlier changes discarded because `develop` changed the file', 'Held back', 'New links, raw HTML and vendor names to check', 'Suggested deletions (not acted on)', 'Diff not shown', 'Commits and PRs in this range', 'API usage'];
    for (const h of headings) assert.ok(body.includes(`\n#### ${h}`), h);
    const at = headings.map((h) => body.indexOf(`\n#### ${h}`));
    assert.deepEqual([...at].sort((x, y) => x - y), at, 'sections in order: deletes before edits');
    assert.ok(!body.includes('Also likely affected') && !body.includes('Delete candidates'));
    assert.ok(!/^#{1,3} /m.test(body), 'no heading above level 4');
    assert.match(body, /thanks @​alice, fixes #​12 &lt;!--/);
    assert.match(body, /addressed in the correction pass:\n    - \[must\] Claims hCaptcha &lt;b&gt;still&lt;\/b&gt; runs/);
    assert.match(body, /Checker: \*\*unchecked\*\*/);
    assert.match(body, /2 line\(s\) had en\/em dashes replaced/);
    assert.match(body, /- `docs\/crm \(old\)\.md` -- CRM app removed\n  - Checker: ok\n  - Still linked from, not fixed here: `docs\/specs\/x\.md`\n  - To restore it: \[bbbbbbb copy\]\(https:\/\/github\.com\/o\/r\/blob\/b{40}\/docs\/crm%20%28old%29\.md\)/);
    assert.match(body, /`README\.md` \(from `1111111\.\.2222222`\)/);
    assert.match(body, /- `docs\/was\.md` \(deleted\)/);
    assert.match(body, /`docs\/old\.md`: triage was asked again and did not select it\. To force it, re-run with `since=c{40}`/);
    assert.match(body, /`docs\/del\.md` \(delete\): triage was asked again/);
    assert.match(body, /`docs\/api\.md`: redone this run on top of the new version/);
    assert.match(body, /gate 2: broken relative link\(s\): \.\/@​nope\.md/);
    assert.match(body, /new URLs: `https:\/\/evil\.example\/@​x`/);
    assert.match(body, /- `docs\/gone\.md` -- App removed \(no cited source file is in the diff\)/);
    assert.match(body, /- #153 refactor: move funnel, closes #​99\n  - `abc1234` refactor @​bob/);
    assert.match(body, /Total ~\$0\.0010/);
    assert.ok(!/<!--(?! ai-docs-sync )/.test(body), 'the only HTML comment is the marker');
    assert.equal(body.match(/-->/g).length, 1);
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('restore links escape characters that would end a Markdown link', () => {
    assert.equal(blobUrl('o/r', 'abc', 'docs/a (b)/c d.md'), 'https://github.com/o/r/blob/abc/docs/a%20%28b%29/c%20d.md');
  });

  test('over the cap the narrative is trimmed first and the marker survives', () => {
    const outline = [{ pr: null, commits: Array.from({ length: 3000 }, (_, i) => ({ short: `c${i}`, subject: `subject ${i} `.repeat(4) })) }];
    const body = renderPrBody({ ...base(), outline });
    assert.ok(body.length <= PR_BODY_MAX, `${body.length}`);
    assert.match(body, /more line\(s\) not shown/);
    assert.match(body, /#### API usage/, 'sections after the narrative are kept');
    assert.match(body, /\[must\] Claims hCaptcha/, 'no detail shed while the narrative alone is over');
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('a guideline banner diff is capped and points at the commit', () => {
    const huge = base();
    huge.kept[1].flags[0].detail = '+x\n'.repeat(40_000);
    const body = renderPrBody(huge);
    assert.ok(body.length <= PR_BODY_MAX);
    assert.match(body, /_Diff cut at 8000 characters; the full diff is in the commit\._/);
    assert.ok(!body.includes('(truncated)'));
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('200 edited and 50 deleted files: under the cap, every deleted path listed, marker intact', () => {
    const long = 'A reason that goes on for a while about what changed in the code. '.repeat(4);
    const issues = Array.from({ length: 5 }, (_, i) => ({ severity: 'should', note: `note ${i} `.repeat(30) }));
    const kept = Array.from({ length: 200 }, (_, i) => ({
      path: `docs/area-${i}/some-fairly-long-document-name-${i}.md`,
      action: 'update',
      reason: long,
      check: { action: 'proceed', issues },
      dashesFixed: 1,
      flags: [{ kind: 'new_urls', detail: [`https://example.com/${i}/${'x'.repeat(80)}`] }],
    }));
    const deleted = Array.from({ length: 50 }, (_, i) => ({
      path: `docs/removed-${i}/the-removed-feature-document-${i}.md`,
      action: 'delete',
      reason: long,
      check: { action: 'proceed', issues },
      flags: [{ kind: 'broken_inbound_links', detail: [`docs/specs/s${i}.md`] }],
    }));
    const runs = [{ at: 't', from: 'a', to: 'b', files: [...kept, ...deleted].map((f) => f.path) }];
    const outline = [{ pr: null, commits: Array.from({ length: 500 }, (_, i) => ({ short: `c${i}`, subject: `subject ${i}` })) }];
    const body = renderPrBody({ ...base(), kept, deleted, runs, outline });
    assert.ok(body.length <= PR_BODY_MAX, `${body.length}`);
    for (const d of deleted) assert.ok(body.includes(`\`${d.path}\``), d.path);
    assert.deepEqual(parseMarker(body), runs);
    assert.ok(!body.includes('(truncated)'));

    const thousands = Array.from({ length: 3000 }, (_, i) => ({ ...kept[0], path: `docs/many/doc-${i}.md` }));
    const cut = renderPrBody({ ...base(), kept: thousands, deleted, runs, outline });
    assert.ok(cut.length <= PR_BODY_MAX, `${cut.length}`);
    for (const d of deleted) assert.ok(cut.includes(`\`${d.path}\``), d.path);
    assert.match(cut, /more line\(s\) not shown; see the commit/);
    assert.deepEqual(parseMarker(cut), runs);
  });

  test('usage entries carry their cost', () => {
    assert.equal(costOf('claude-sonnet-5', { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }), 2);
    assert.equal(costOf('mystery', { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }), null);
    const u = makeUsageLog();
    u.log('triage', 'claude-sonnet-5', { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 });
    assert.equal(u.entries[0].cost, 2);
  });
});
