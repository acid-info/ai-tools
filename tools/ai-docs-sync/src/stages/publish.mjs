import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderReviewerDecisions } from '../carry.mjs';
import { createApiCommit } from '../commit.mjs';
import { STATUS_CONTEXT } from '../config.mjs';
import { BOT_EMAIL, BOT_NAME } from '../git.mjs';
import { unifiedDiff } from '../linediff.mjs';
import { narrativeOutline } from '../narrative.mjs';
import { renderPrBody } from '../pr-body.mjs';
import { commitMessage, commitScope, lastRunFor, prTitle, regenerateFrom } from '../publish.mjs';

export async function publish(ctx) {
  const { DRY_RUN, REPO, RUN_URL, TARGET_BRANCH, capped, carried, carryBase, cfg, commits, count, decisions, delPlan, dropped, findOpenPr, from, gh, ghCommit, git, head, heldBack, isNewDoc, kept, keptDeletes, keptPaths, linked, log, moveCursor, openPr, packed, prevRuns, prs, pushUrl, pushWithToken, remoteSha, reviewer, reviewerRemoved, staleCarried, tombstones, treeEntry, usage, warn } = ctx;
  const scope = commitScope(cfg.branch);
  const carriedOnly = [...carried.keys()].filter((p) => !keptPaths.has(p));
  const carriedDeletesOnly = [...tombstones].filter((p) => !keptPaths.has(p));
  const toolCarriedDeletes = carriedDeletesOnly.filter((p) => !reviewerRemoved.has(p));
  const title = prTitle({ scope, target: TARGET_BRANCH, to: head });
  const prBody = renderPrBody({
    repo: REPO,
    target: TARGET_BRANCH,
    from,
    to: head,
    commitCount: count,
    capped,
    runUrl: RUN_URL,
    kept,
    deleted: keptDeletes,
    reviewer,
    carried: [
      ...carriedOnly.map((p) => ({ path: p, run: lastRunFor(prevRuns, p), created: isNewDoc(p) })),
      ...toolCarriedDeletes.map((p) => ({ path: p, run: lastRunFor(prevRuns, p), deleted: true })),
    ],
    stale: staleCarried.filter((x) => !x.reason).map(({ path: p, kind }) => ({ path: p, kind, since: regenerateFrom(prevRuns, p, carryBase), redone: keptPaths.has(p) })),
    dropped,
    heldBack,
    suggestedDeletes: delPlan.suggested,
    omittedDiff: packed.omitted,
    outline: narrativeOutline({ commits, linked, prs }),
    usage: { entries: usage.entries, total: usage.total(), unpriced: usage.unpriced() },
    runs: [...prevRuns, { at: new Date().toISOString(), from, to: head, files: [...keptPaths] }],
  });

  if (DRY_RUN) {
    log(`\n===== DRY RUN -- would push ${cfg.branch} and ${openPr ? `update PR #${openPr.number}` : 'open a PR'} =====`);
    log(
      `Files: ${[...keptPaths].join(', ')}` +
        (carriedOnly.length ? `; carried: ${carriedOnly.join(', ')}` : '') +
        (carriedDeletesOnly.length ? `; carried deletes: ${carriedDeletesOnly.join(', ')}` : '')
    );
    if (decisions.length) log(`Commit message would record:\n${renderReviewerDecisions(decisions).join('\n')}`);
    for (const k of kept) log(`\n${unifiedDiff(k.current ?? '', k.content, k.path) || `(no textual diff for ${k.path})`}`);
    for (const d of keptDeletes) log(`\n${unifiedDiff(d.current, '', d.path) || `(${d.path} is empty; deleted)`}`);
    log(`\n----- PR title -----\n${title}\n----- PR body -----\n${prBody}`);
    moveCursor('Dry run');
    return { done: true };
  }

  // Built with plumbing in a throwaway index: the working tree never changes and no file is
  // written through a path on disk.
  const tmp = mkdtempSync(join(tmpdir(), 'ai-docs-sync-'));
  let tree;
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    const stage = (mode, blob, p) => {
      if (!/^1006[04][04]$/.test(mode)) throw new Error(`refusing to stage ${p}: tree mode ${mode} is not a regular file`);
      git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], { env });
    };
    git(['read-tree', head], { env });
    for (const p of carriedOnly) stage(carried.get(p).mode, carried.get(p).blob, p);
    for (const k of kept) stage(treeEntry(head, k.path)?.mode ?? '100644', git(['hash-object', '-w', '--stdin'], { input: k.content }), k.path);
    for (const p of [...keptDeletes.map((d) => d.path), ...carriedDeletesOnly]) git(['update-index', '--force-remove', '--', p], { env });
    tree = git(['write-tree'], { env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // With an open PR the push still happens, so the PR stops showing edits that were dropped.
  if (tree === git(['rev-parse', `${head}^{tree}`]) && !openPr) {
    moveCursor('The edits reproduce the target tree exactly; nothing to publish');
    return { done: true };
  }
  // Through the API so GitHub signs it. Only the Actions token, with no custom author, gets a
  // signature (author `github-actions[bot]`); any other token, as in a local run, would author the
  // commit as itself, so the bot is set explicitly and the commit stays unsigned.
  const created = await createApiCommit({
    gh: ghCommit ?? gh,
    git,
    repo: REPO,
    parent: head,
    tree,
    author: ghCommit ? undefined : { name: BOT_NAME, email: BOT_EMAIL },
    message: commitMessage({
      scope,
      from,
      to: head,
      target: TARGET_BRANCH,
      files: kept.map((k) => k.path),
      deleted: keptDeletes.map((d) => d.path),
      carried: carriedOnly,
      carriedDeleted: toolCarriedDeletes,
      reviewerDeleted: carriedDeletesOnly.filter((p) => reviewerRemoved.has(p)),
      decisions,
      runUrl: RUN_URL,
    }),
  });
  const commit = created.sha;
  if (!created.verified) warn(`commit ${commit.slice(0, 7)} is not signed (${created.reason}); a "require signed commits" rule will block the PR`);
  // Pushed, not moved through the API, so the lease pins the push to the branch state the
  // ownership check inspected, and a push with DOCS_SYNC_TOKEN still triggers CI.
  pushWithToken([`--force-with-lease=refs/heads/${cfg.branch}:${remoteSha}`, pushUrl, `${commit}:refs/heads/${cfg.branch}`], { fetch: [pushUrl, commit] });
  log(`Pushed ${cfg.branch} at ${commit.slice(0, 7)}` + (created.verified ? ' (signed by GitHub)' : ''));

  let pr = openPr;
  if (pr) {
    await gh(`/repos/${REPO}/pulls/${pr.number}`, { method: 'PATCH', body: { title, body: prBody } });
    log(`Updated PR #${pr.number}: ${pr.html_url}`);
  } else {
    try {
      pr = await gh(`/repos/${REPO}/pulls`, { method: 'POST', body: { title, head: cfg.branch, base: TARGET_BRANCH, body: prBody } });
      log(`Opened PR #${pr.number}: ${pr.html_url}`);
    } catch (e) {
      if (e.status === 403)
        throw new Error(
          `Creating the PR was refused (403). Enable "Allow GitHub Actions to create and approve pull requests" ` +
            `(Settings -> Actions -> General -> Workflow permissions) or set DOCS_SYNC_TOKEN. ${cfg.branch} was pushed; ` +
            `the next run rebuilds it. GitHub said: ${e.text}`
        );
      // A create retried after a 5xx can find its own first attempt.
      if (e.status !== 422 || !(pr = await findOpenPr())) throw e;
      await gh(`/repos/${REPO}/pulls/${pr.number}`, { method: 'PATCH', body: { title, body: prBody } });
      log(`Updated PR #${pr.number}: ${pr.html_url}`);
    }
  }
  if (cfg.label) {
    try {
      await gh(`/repos/${REPO}/issues/${pr.number}/labels`, { method: 'POST', body: { labels: [cfg.label] } });
    } catch (e) {
      warn(`could not add label "${cfg.label}" (${e.status ?? e.message}); continuing`);
    }
  }

  moveCursor('Published');

  try {
    await gh(`/repos/${REPO}/statuses/${commit}`, {
      method: 'POST',
      body: {
        state: 'success',
        context: STATUS_CONTEXT,
        description:
          `${kept.filter((k) => k.action === 'create').length} new, ${kept.filter((k) => k.action !== 'create').length} edited, ${keptDeletes.length} deleted, ${dropped.length + heldBack.length} held back` +
          (decisions.length ? `, ${decisions.length} reviewer change(s)` : ''),
        ...(RUN_URL ? { target_url: RUN_URL } : {}),
      },
    });
  } catch (e) {
    warn(`could not post the ${STATUS_CONTEXT} status (${e.status ?? e.message})`);
  }
}
