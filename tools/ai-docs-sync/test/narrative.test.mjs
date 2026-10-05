import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BOT_EMAIL, isBotEmail, parseGitLog } from '../src/git.mjs';
import { buildNarrative, cleanPrBody, collectPrs, prNumberFromSubject } from '../src/narrative.mjs';
import { approxTokens } from '../src/text.mjs';

describe('narrative', () => {
  const LOG =
    'sha1\0abc1234\0Ann\0ann@example.com\0ann@example.com\0p0\0refactor(web): post funnel forms to apps/api (#153)\0Moves the intake POST.\n\n- squashed one\n- squashed two\n\x01' +
    '\nsha2\0abc2345\0Bob\0bob@example.com\0noreply@github.com\0p1 p2\0Merge pull request #154 from org/feature\0\x01' +
    '\nsha3\0abc3456\0Cy\0cy@example.com\0merger@example.com\0p3\0feat(web): list legal links\0Body three.\x01' +
    `\nsha4\0abc4567\0Bot\0${BOT_EMAIL}\0${BOT_EMAIL}\0p4\0docs(repo): sync with 1..2\0Range: x\x01` +
    '\nsha5\0abc5678\0Di\0di@example.com\0merger@example.com\0p5\0chore(deps): bump\0\x01';

  test('parses the git log record format', () => {
    const commits = parseGitLog(LOG);
    assert.equal(commits.length, 5);
    assert.equal(commits[2].authorEmail, 'cy@example.com');
    assert.equal(commits[2].email, 'merger@example.com');
    assert.deepEqual(commits[1].parents, ['p1', 'p2']);
    assert.equal(commits[0].body, 'Moves the intake POST.\n\n- squashed one\n- squashed two');
    assert.equal(prNumberFromSubject(commits[0].subject), 153);
    assert.equal(prNumberFromSubject(commits[1].subject), 154);
    assert.equal(prNumberFromSubject(commits[2].subject), null);
    assert.ok(isBotEmail(commits[3].email));
    assert.ok(isBotEmail('12345+docs-bot[bot]@users.noreply.github.com'));
    assert.ok(!isBotEmail('ann@example.com'));
  });

  test('PR bodies lose HTML comments and template checkboxes', () => {
    assert.equal(cleanPrBody('Real text\n<!-- template -->\n- [ ] I ran the tests\n- [x] done\nMore'), 'Real text\n\nMore');
  });

  test('links commits to PRs: subjects free, one lookup per PR, caps, filters base and the rolling PR', async () => {
    const commits = parseGitLog(LOG);
    const calls = { pr: [], pulls: [], prCommits: [] };
    const api = {
      pr: async (n) => {
        calls.pr.push(n);
        if (n === 153) return { number: 153, title: 'funnel', body: 'b', head: { ref: 'web/funnel' }, base: { ref: 'develop' }, user: { login: 'ann' }, labels: [{ name: 'web' }] };
        if (n === 154) return { number: 154, title: 'rolling', body: '', head: { ref: 'docs/repo/sync' }, base: { ref: 'develop' } };
        throw new Error('404');
      },
      pullsForCommit: async (sha) => {
        calls.pulls.push(sha);
        if (sha === 'sha3') return [{ number: 160, title: 'legal', body: 'x', head: { ref: 'f' }, base: { ref: 'develop' } }];
        return [];
      },
      prCommits: async (n) => {
        calls.prCommits.push(n);
        // sha3 by SHA; sha5 as a rebased commit: new SHA, same subject and author.
        return [{ sha: 'sha3', subject: 'feat(web): list legal links', email: 'cy@example.com' }, { sha: 'rebased-away', subject: 'chore(deps): bump', email: 'di@example.com' }];
      },
    };
    const { linked, prs, lookups } = await collectPrs(commits, api, { targetBranch: 'develop', rollingBranch: 'docs/repo/sync' });
    assert.equal(linked.get('sha1'), 153);
    assert.equal(linked.get('sha3'), 160);
    assert.equal(linked.get('sha5'), 160, 'marked via prCommits by subject + author, not looked up');
    assert.deepEqual(calls.pulls, ['sha3'], 'merge commits and bot commits are never looked up');
    assert.ok(prs.has(153) && prs.has(160));
    assert.ok(!prs.has(154), 'rolling PR excluded');
    assert.equal(lookups, 1);
    assert.deepEqual(prs.get(153).labels, ['web']);
  });

  test('lookup cap is honoured', async () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `s${i}`, short: `s${i}`, authorEmail: 'x@y', email: 'x@y', parents: ['p'], subject: `c${i}`, body: '' }));
    let n = 0;
    const api = { pr: async () => null, pullsForCommit: async () => (n++, []), prCommits: async () => [] };
    const r = await collectPrs(commits, api, { targetBranch: 'develop', rollingBranch: 'r', maxLookups: 2 });
    assert.equal(n, 2);
    assert.equal(r.lookupsExhausted, true);
  });

  test('renders PR groups, keeps squash bodies, drops merge boilerplate and bot commits', () => {
    const commits = parseGitLog(LOG);
    const linked = new Map([['sha1', 153], ['sha2', 154]]);
    const prs = new Map([[153, { number: 153, title: 'funnel', body: 'Moves it.', labels: [], head: 'web/funnel', base: 'develop', user: 'ann' }]]);
    const text = buildNarrative({ commits, linked, prs, targetBranch: 'develop', from: 'aaaaaaaaaa', to: 'bbbbbbbbbb' });
    assert.match(text, /^## Change narrative \(develop, aaaaaaa\.\.bbbbbbb\)/);
    assert.match(text, /### PR #153 "funnel" \(ann, head web\/funnel\)\nMoves it\.\n- abc1234 refactor\(web\)/);
    assert.match(text, /  - squashed two/, 'squash body kept whole');
    assert.ok(!text.includes('Merge pull request'), 'merge commit contributes only its PR number');
    assert.ok(!text.includes('docs(repo): sync'), 'bot commit dropped');
    assert.match(text, /### Commits not from a PR\n- abc3456 feat\(web\): list legal links\n  Body three\.\n- abc5678 chore\(deps\): bump/);
  });

  test('packing never drops a subject; bodies are truncated longest first with a marker', () => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      sha: `sha${i}`,
      short: `sha${i}`,
      authorEmail: 'x@y',
      email: 'x@y',
      parents: ['p'],
      subject: `subject number ${i}`,
      body: i === 3 ? 'L'.repeat(4000) : 'short body',
    }));
    const prs = new Map([[1, { number: 1, title: 't', body: 'P'.repeat(2000), labels: [], head: 'h', base: 'develop', user: 'u' }]]);
    const linked = new Map([['sha0', 1]]);
    const text = buildNarrative({ commits, linked, prs, targetBranch: 'develop', from: 'a', to: 'b', budget: 400 });
    for (let i = 0; i < 10; i++) assert.ok(text.includes(`subject number ${i}`), `subject ${i} present`);
    assert.ok(approxTokens(text) <= 400 + 20, `within budget: ${approxTokens(text)}`);
    assert.ok(!text.includes('L'.repeat(4000)));
    assert.ok(text.includes('[truncated]'));
    assert.ok(text.includes('P'.repeat(200)), 'commit bodies go before PR bodies');
  });
});
