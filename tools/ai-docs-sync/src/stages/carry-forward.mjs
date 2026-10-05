import { approxTokens } from '#core/text.mjs';

import { classifyReviewerChanges, describeDecision, fixupsOfRevertedDelete, foreignBranchCommit, parseReviewerDecisions, planCarryForward, reconcileReviewerCarry } from '../carry.mjs';
import { GIT_LOG_FORMAT, isBotEmail, isToolCommit, parseGitLog, parseNameStatus, splitUnifiedDiff } from '../git.mjs';
import { parseMarker, regenerateFrom } from '../publish.mjs';
import { packDiff } from '../range.mjs';
import { renderStaleBlock } from '../triage.mjs';

export async function carryForward(ctx) {
  const { REPO, TARGET_BRANCH, cfg, from, gh, git, gitOk, head, isAncestor, isEditableDoc, isEditableDocPath, isIgnored, log, readCheckout, treeEntry } = ctx;
  // 5.12 step 1: rolling-branch edits overlay the checkout only while their PR is open; merged
  // means they are in the target, closed means "not now".
  const owner = REPO.split('/')[0];
  const findOpenPr = async () =>
    (await gh(`/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`${owner}:${cfg.branch}`)}&base=${encodeURIComponent(TARGET_BRANCH)}`))[0] ?? null;
  const openPr = await findOpenPr();
  const carried = new Map(); // path -> { mode, blob, content }
  const tombstones = new Set(); // docs the rolling branch deletes
  const staleCarried = []; // { path, kind, reason? }
  const obsolete = [];
  // Reviewer decisions, recorded in the tool's commit because every rebuild drops the reviewers' commits.
  let decisions = [];
  const discardedReviewer = [];
  const revertedFixups = new Map(); // restored doc -> carried fix-ups sent back to triage
  let carryBase = null;
  const remote = `refs/remotes/origin/${cfg.branch}`;
  // The lease for the force push: what we inspected, or "must not exist".
  const remoteSha = gitOk(['rev-parse', '--verify', '--quiet', remote]) ? git(['rev-parse', remote]) : '';
  if (remoteSha) {
    const base = git(['merge-base', 'HEAD', remote]);
    const branchCommits = parseGitLog(git(['log', `--format=${GIT_LOG_FORMAT}`, `${base}..${remote}`]));
    const changesOf = (sha) => parseNameStatus(git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', sha]));
    const foreign = foreignBranchCommit(branchCommits, { changesOf, isEditableDoc });
    if (foreign)
      throw new Error(
        `origin/${cfg.branch} has ${foreign.short} "${foreign.subject}" (${foreign.email}), which is neither the tool's nor an addition, edit, deletion or rename of an editable doc; ` +
          `refusing to build on it. Rename or delete that branch.`
      );
    if (openPr) {
      carryBase = base;
      const plan = planCarryForward({
        branchChanges: parseNameStatus(git(['diff', '--name-status', '-z', '--no-renames', base, remote])),
        targetHas: (f) => treeEntry(head, f) != null,
        targetChangedSinceBase: (f) => !gitOk(['diff', '--quiet', base, 'HEAD', '--', f]),
        isEditableDoc,
      });
      const lastTool = branchCommits.find(isToolCommit);
      const reconciled = reconcileReviewerCarry({
        decisions: classifyReviewerChanges({
          commits: [...branchCommits].reverse(),
          changesOf,
          baseHas: (f) => treeEntry(base, f) != null,
          remoteHas: (f) => treeEntry(remote, f) != null,
          isEditableDoc,
          previous: lastTool ? parseReviewerDecisions(`${lastTool.subject}\n\n${lastTool.body}`, isEditableDocPath) : [],
        }),
        stale: plan.stale,
        obsolete: plan.obsolete,
      });
      decisions = reconciled.decisions;
      discardedReviewer.push(...reconciled.discarded);
      for (const f of plan.restore) carried.set(f, { ...treeEntry(remote, f), content: git(['show', `${remote}:${f}`], { raw: true }) });
      for (const f of plan.restoreDeletes) tombstones.add(f);
      staleCarried.push(...reconciled.stale);
      obsolete.push(...plan.obsolete);
      // A doc back in the tree takes back the links an earlier run removed for it.
      const restored = [
        ...decisions.filter((x) => x.kind === 'declined-delete').map((x) => [x.path, 'the delete they followed was reverted by a reviewer']),
        ...reconciled.discarded.map((x) => [x.path, `the reviewer delete they followed was discarded because ${TARGET_BRANCH} changed the file`]),
      ];
      for (const [p, reason] of restored) {
        const fixups = fixupsOfRevertedDelete(p, carried, readCheckout);
        for (const q of fixups) {
          carried.delete(q);
          staleCarried.push({ path: q, kind: 'edit', reason });
        }
        if (fixups.length) revertedFixups.set(p, fixups);
      }
      log(
        `Open PR #${openPr.number}; carrying forward ${plan.restore.length} unmerged edit(s) and ${plan.restoreDeletes.length} delete(s) from origin/${cfg.branch}` +
          (plan.stale.length ? `; ${plan.stale.length} stale (target changed): ${plan.stale.map((x) => `${x.path} (${x.kind})`).join(', ')}` : '') +
          (plan.obsolete.length ? `; ${plan.obsolete.length} obsolete (target deleted the file): ${plan.obsolete.join(', ')}` : '')
      );
      for (const d of decisions) log(`  reviewer decision: ${describeDecision(d)}`);
      for (const d of reconciled.discarded) log(`  reviewer ${d.kind === 'renamed' ? 'rename' : 'delete'} of ${d.path} discarded: ${TARGET_BRANCH} changed the file`);
      for (const [p, qs] of revertedFixups) log(`  carried link fix-up(s) for ${p}, which is back, sent back to triage: ${qs.join(', ')}`);
    } else {
      log(`origin/${cfg.branch} exists with no open PR into ${TARGET_BRANCH}; its edits are not carried forward`);
    }
  }
  // A tombstone triage names again reads as the target's copy, but stays deleted unless kept.
  const undeleted = new Set();
  const isTombstone = (p) => tombstones.has(p) && !undeleted.has(p);
  const readCurrent = (p) => (carried.has(p) ? carried.get(p).content : isTombstone(p) ? null : readCheckout(p));
  const prevRuns = parseMarker(openPr?.body);
  // The PR must stop showing a discarded or obsolete change even when nothing else changes.
  const mustRefresh = Boolean(openPr && (staleCarried.length || obsolete.length || discardedReviewer.length));
  const reviewerRemoved = new Map(decisions.filter((d) => d.kind === 'deleted' || d.kind === 'renamed').map((d) => [d.path, d]));
  // New to the target, but the reviewer's rename rather than a doc the tool created.
  const renamedTo = new Set(decisions.filter((d) => d.kind === 'renamed').map((d) => d.to));
  const isNewDoc = (p) => !treeEntry(head, p) && !renamedTo.has(p);
  const stalePaths = staleCarried.map((x) => x.path);

  // Discarded edits go back to triage with the earlier code changes they documented. Where that
  // range starts comes from the PR marker, so it is only trusted once git confirms the ancestry.
  let staleText = '';
  const earlierByPath = new Map();
  const earlierPaths = new Set();
  if (staleCarried.length) {
    const starts = stalePaths.map((p) => {
      const s = regenerateFrom(prevRuns, p, carryBase);
      return s && isAncestor(s) ? s : carryBase;
    });
    const earliest = starts.sort((a, b) => Number(git(['rev-list', '--count', `${b}..HEAD`])) - Number(git(['rev-list', '--count', `${a}..HEAD`])))[0];
    let earlierDiff = '';
    let earlierCommits = [];
    if (earliest !== from && gitOk(['merge-base', '--is-ancestor', earliest, from])) {
      const older = splitUnifiedDiff(git(['diff', '-M', `${earliest}..${from}`])).filter((p) => !isEditableDoc(p.path) && !isIgnored(p.path));
      const packedOld = packDiff(older, cfg.max_stale_diff_tokens);
      for (const p of older) if (packedOld.included.includes(p.path)) earlierByPath.set(p.path, p);
      for (const p of older) for (const q of [p.path, p.oldPath]) if (q) earlierPaths.add(q);
      earlierDiff = packedOld.diff;
      earlierCommits = parseGitLog(git(['log', '--reverse', '--no-merges', `--format=${GIT_LOG_FORMAT}`, `${earliest}..${from}`]))
        .filter((c) => !isBotEmail(c.email))
        .slice(-50)
        .map((c) => ({ short: c.short, subject: c.subject }));
    }
    const current = Object.fromEntries(
      stalePaths.map((p) => {
        const text = readCurrent(p);
        return [p, text != null && approxTokens(text) <= cfg.max_doc_tokens ? text : null];
      })
    );
    staleText = renderStaleBlock({ docs: staleCarried, from: earliest, to: from, commits: earlierCommits, diff: earlierDiff, current });
    log(`Stale change(s) sent back to triage: ${stalePaths.join(', ')}` + (earlierDiff ? ` (earlier changes ${earliest.slice(0, 7)}..${from.slice(0, 7)}, ${earlierByPath.size} file(s))` : ''));
  }
  return { findOpenPr, openPr, carried, tombstones, staleCarried, obsolete, decisions, discardedReviewer, revertedFixups, carryBase, remoteSha, undeleted, readCurrent, prevRuns, mustRefresh, reviewerRemoved, isNewDoc, staleText, earlierByPath, earlierPaths };
}
