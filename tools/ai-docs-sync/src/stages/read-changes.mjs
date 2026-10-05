import { approxTokens } from '#core/text.mjs';

import { GIT_LOG_FORMAT, parseGitLog, parseNameStatus, splitUnifiedDiff } from '../git.mjs';
import { buildNarrative, collectPrs } from '../narrative.mjs';
import { classifyChanges, packDiff } from '../range.mjs';

export async function readChanges(ctx) {
  const { REPO, TARGET_BRANCH, capped, cfg, from, gh, ghAll, git, head, isEditableDoc, isIgnored, log, moveCursor, warn } = ctx;
  // 5.4 changed files and free exits
  const changes = parseNameStatus(git(['diff', '--name-status', '-z', '-M', `${from}..HEAD`]));
  const classified = classifyChanges(changes, { isEditableDoc, isIgnored });
  log(`Changed files: ${changes.length} (${classified.docs.length} docs, ${classified.code.length} code, ${classified.ignored.length} ignored)`);
  for (const c of changes) log(`  ${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`);
  if (classified.skipReason) {
    moveCursor(`Skip: ${classified.skipReason}`);
    return { done: true };
  }
  const changedPaths = changes.map((c) => c.path);

  // 5.3 narrative
  const commits = parseGitLog(git(['log', '--reverse', `--format=${GIT_LOG_FORMAT}`, `${from}..HEAD`]));
  const api = {
    pr: (n) => gh(`/repos/${REPO}/pulls/${n}`),
    pullsForCommit: (sha) => gh(`/repos/${REPO}/commits/${sha}/pulls`),
    prCommits: async (n) =>
      (await ghAll(`/repos/${REPO}/pulls/${n}/commits`)).map((c) => ({
        sha: c.sha,
        subject: (c.commit?.message ?? '').split('\n')[0],
        email: c.commit?.author?.email ?? '',
      })),
  };
  const { linked, prs, lookups, lookupsExhausted } = await collectPrs(commits, api, {
    targetBranch: TARGET_BRANCH,
    rollingBranch: cfg.branch,
    maxLookups: cfg.max_pr_lookups,
  });
  if (lookupsExhausted) warn(`PR lookup cap (${cfg.max_pr_lookups}) reached; remaining commits listed as not from a PR`);
  const narrative = buildNarrative({ commits, linked, prs, targetBranch: TARGET_BRANCH, from, to: head, budget: cfg.narrative_max_tokens, capped });
  log(`Narrative: ${commits.length} commits, ${prs.size} PRs (${lookups} lookups), ~${approxTokens(narrative)} tokens`);
  log(`\n${narrative}\n`);

  // 5.5 packed code diff from local git: one diff for the range, filtered to code files, so a
  // large push never turns into an oversized argument list.
  const codeSet = new Set(classified.code.map((c) => c.path));
  const patches = splitUnifiedDiff(git(['diff', '-M', `${from}..HEAD`])).filter((p) => codeSet.has(p.path));
  const packed = packDiff(patches, cfg.max_diff_tokens);
  log(`Packed diff: ${packed.included.length} files, ~${approxTokens(packed.diff)} tokens` + (packed.omitted.length ? `, ${packed.omitted.length} over budget` : ''));
  return { classified, changedPaths, commits, linked, prs, narrative, patches, packed };
}
