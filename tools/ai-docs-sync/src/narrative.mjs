import { approxTokens } from '#core/text.mjs';

import { DEFAULTS } from './config.mjs';
import { isBotCommit } from './git.mjs';

export function prNumberFromSubject(subject) {
  const merge = subject.match(/^Merge pull request #(\d+)\b/);
  if (merge) return Number(merge[1]);
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  return squash ? Number(squash[1]) : null;
}

export function cleanPrBody(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*[-*]\s+\[[ xX]\]/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const normalisePr = (pr) => ({
  number: pr.number,
  title: pr.title ?? '',
  body: cleanPrBody(pr.body),
  labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
  head: pr.head?.ref ?? '',
  base: pr.base?.ref ?? '',
  user: pr.user?.login ?? '',
});

// One lookup covers every commit of a found PR, matched by SHA or, since a rebase merge rewrites
// SHAs, by subject + author email.
export async function collectPrs(commits, api, { targetBranch, rollingBranch, maxLookups = DEFAULTS.max_pr_lookups }) {
  const linked = new Map(); // sha -> pr number
  const prs = new Map(); // number -> normalised pr
  const candidates = commits.filter((c) => !isBotCommit(c));
  const wanted = new Set();
  for (const c of candidates) {
    const n = prNumberFromSubject(c.subject);
    if (n) {
      linked.set(c.sha, n);
      wanted.add(n);
    }
  }
  for (const n of wanted) {
    try {
      const pr = await api.pr(n);
      if (pr) prs.set(n, normalisePr(pr));
    } catch (e) {
      // A subject can cite a PR from another repo or a deleted one; that is not fatal.
      prs.set(n, null);
      void e;
    }
  }
  let lookups = 0;
  let lookupsExhausted = false;
  for (const c of candidates) {
    if (linked.has(c.sha) || c.parents.length > 1) continue;
    if (lookups >= maxLookups) {
      lookupsExhausted = true;
      break;
    }
    lookups++;
    let found = [];
    try {
      found = (await api.pullsForCommit(c.sha)) ?? [];
    } catch {
      continue;
    }
    const pr = found.find((p) => p.base?.ref === targetBranch) ?? found[0];
    if (!pr) continue;
    linked.set(c.sha, pr.number);
    if (!prs.has(pr.number)) prs.set(pr.number, normalisePr(pr));
    try {
      const prCommits = (await api.prCommits(pr.number)) ?? [];
      const bySha = new Set(prCommits.map((x) => (typeof x === 'string' ? x : x.sha)));
      const byIdentity = new Set(prCommits.filter((x) => typeof x !== 'string').map((x) => `${x.email}\n${x.subject}`));
      for (const other of candidates) {
        if (linked.has(other.sha)) continue;
        if (bySha.has(other.sha) || byIdentity.has(`${other.authorEmail}\n${other.subject}`)) linked.set(other.sha, pr.number);
      }
    } catch {
      // Without the commit list the other commits of this PR cost one lookup each; acceptable.
    }
  }
  // Only PRs into the target branch, and never the rolling PR: its body is the tool's own text.
  for (const [n, pr] of prs) {
    if (!pr || pr.base !== targetBranch || pr.head === rollingBranch) prs.delete(n);
  }
  return { linked, prs, lookups, lookupsExhausted };
}

// Packs the narrative into `budget` tokens: subjects and headers always fit; commit bodies are
// truncated before PR bodies, longest first, with a marker.
export function groupCommits({ commits, linked, prs }) {
  const groups = new Map(); // pr number -> commits
  const loose = [];
  for (const c of commits.filter((x) => !isBotCommit(x))) {
    const n = linked.get(c.sha);
    const isMerge = c.parents.length > 1;
    if (n && prs.has(n)) {
      if (!groups.has(n)) groups.set(n, []);
      if (!isMerge) groups.get(n).push(c);
    } else if (!isMerge) {
      loose.push(c);
    }
    // A merge commit contributes only its PR number; one for a filtered PR contributes nothing.
  }
  return { groups, loose };
}

// Headings only (PR numbers, titles, commit subjects), for the PR body.
export function narrativeOutline({ commits, linked, prs }) {
  const { groups, loose } = groupCommits({ commits, linked, prs });
  const entry = (c) => ({ short: c.short || (c.sha ?? '').slice(0, 7), subject: c.subject });
  const out = [...groups].map(([n, list]) => ({ pr: { number: n, title: prs.get(n).title }, commits: list.map(entry) }));
  if (loose.length) out.push({ pr: null, commits: loose.map(entry) });
  return out;
}

export function buildNarrative({ commits, linked, prs, targetBranch, from, to, budget = DEFAULTS.narrative_max_tokens, capped = false }) {
  const short = (s) => (s ?? '').slice(0, 7);
  const { groups, loose } = groupCommits({ commits, linked, prs });
  const bodies = []; // { kind: 'pr'|'commit', text }
  const body = (kind, text) => {
    const b = { kind, text: text ?? '' };
    bodies.push(b);
    return b;
  };
  const sections = [];
  for (const [n, list] of groups) {
    const pr = prs.get(n);
    const meta = [pr.user, pr.head ? `head ${pr.head}` : ''].filter(Boolean).join(', ');
    const lines = [`### PR #${n} "${pr.title}"${meta ? ` (${meta})` : ''}`];
    if (pr.labels.length) lines.push(`labels: ${pr.labels.join(', ')}`);
    const prBody = body('pr', pr.body);
    const commitLines = list.map((c) => ({ head: `- ${c.short || short(c.sha)} ${c.subject}`, body: body('commit', c.body) }));
    sections.push({ lines, prBody, commitLines });
  }
  if (loose.length) {
    sections.push({
      lines: ['### Commits not from a PR'],
      prBody: null,
      commitLines: loose.map((c) => ({ head: `- ${c.short || short(c.sha)} ${c.subject}`, body: body('commit', c.body) })),
    });
  }
  const title = `## Change narrative (${targetBranch}, ${short(from)}..${short(to)})`;
  const notes = [];
  if (capped) notes.push(`Range capped at the newest ${DEFAULTS.max_commits} first-parent commits.`);

  const render = () => {
    const out = [title];
    if (notes.length) out.push('', ...notes);
    for (const s of sections) {
      out.push('', ...s.lines);
      if (s.prBody?.text) out.push(s.prBody.text);
      for (const c of s.commitLines) {
        out.push(c.head);
        if (c.body.text) out.push(c.body.text.replace(/^/gm, '  '));
      }
    }
    return out.join('\n');
  };

  const MARK = ' [truncated]';
  for (let guard = 0; guard < 10_000; guard++) {
    const text = render();
    const over = approxTokens(text) - budget;
    if (over <= 0) return text;
    const pick = (kind) => bodies.filter((b) => b.kind === kind && b.text).sort((a, b) => b.text.length - a.text.length)[0];
    const target = pick('commit') ?? pick('pr');
    if (!target) return text;
    const bare = target.text.endsWith(MARK) ? target.text.slice(0, -MARK.length) : target.text;
    const keep = Math.max(0, bare.length - over * 4 - MARK.length);
    target.text = keep > 0 ? bare.slice(0, keep).trimEnd() + MARK : '';
  }
  return render();
}

