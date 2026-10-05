import { API } from '#core/api.mjs';

import { CURSOR_REF } from '../config.mjs';
import { selectRange } from '../range.mjs';

export async function pickRange(ctx) {
  const { PUSH_BEFORE, PUSH_FORCED, REPO, SINCE, TRIAGE_ONLY, cfg, gh, git, gitOk, head, log, pushWithToken } = ctx;
  // 5.2 range: cursor ref, then PUSH_BEFORE, then HEAD~1; SINCE overrides all
  let cursor = null;
  if (!SINCE) {
    const ref = await gh(`/repos/${REPO}/git/ref/ai-docs-sync/cursor`, { allow404: true });
    cursor = ref?.object?.sha ?? null;
    log(cursor ? `Cursor ref at ${cursor.slice(0, 7)}` : 'No cursor ref yet');
  }
  const isAncestor = (sha) => gitOk(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) && gitOk(['merge-base', '--is-ancestor', sha, 'HEAD']);
  const range = selectRange({ since: SINCE, cursor, pushBefore: PUSH_BEFORE, pushForced: PUSH_FORCED }, isAncestor);
  const pushUrl = `${API.github.gitUrl}/${REPO}.git`;
  // Every run that reaches a decision moves the cursor, so each commit is triaged once.
  const moveCursor = (why) => {
    if (TRIAGE_ONLY) return log(`${why}. TRIAGE_ONLY: cursor not moved.`);
    if (cursor === head) return log(`${why}. Cursor already at ${head.slice(0, 7)}.`);
    pushWithToken(['--force', pushUrl, `${head}:${CURSOR_REF}`]);
    log(`${why}. Cursor moved to ${head.slice(0, 7)}.`);
  };

  if (range.from === 'HEAD~1' && !gitOk(['rev-parse', '--verify', '--quiet', 'HEAD~1'])) {
    moveCursor('Single-commit history; nothing to compare');
    return { done: true };
  }
  let from = git(['rev-parse', range.from]);
  let capped = false;
  let count = Number(git(['rev-list', '--count', `${from}..HEAD`]));
  if (count > cfg.max_commits) {
    // First-parent, so the new start is on the target's own line and never before the old one.
    const line = git(['rev-list', '--first-parent', `--max-count=${cfg.max_commits + 1}`, `${from}..HEAD`]).split('\n');
    if (line.length > cfg.max_commits) {
      from = line[line.length - 1];
      capped = true;
      const all = count;
      count = Number(git(['rev-list', '--count', `${from}..HEAD`]));
      log(`Range has ${all} commits; capped at the newest ${cfg.max_commits} first-parent commits (from ${from.slice(0, 7)}). Backfill in slices with since=.`);
    }
  }
  log(`Range ${from.slice(0, 7)}..${head.slice(0, 7)} (${range.source}, ${count} commits)`);
  if (from === head) {
    moveCursor('Empty range; nothing to do');
    return { done: true };
  }
  return { isAncestor, pushUrl, moveCursor, from, capped, count };
}
