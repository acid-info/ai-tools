import { canonicalise } from '#core/paths.mjs';

import { isBotEmail, isToolCommit } from './git.mjs';
import { inboundLinks } from './links.mjs';

// The commit that makes the rolling branch someone else's work, or null. `changesOf` keeps renames.
export function foreignBranchCommit(commits, { changesOf, isEditableDoc }) {
  if (!commits.length) return null;
  if (!commits.some(isToolCommit)) return commits[0];
  const carriable = (ch) =>
    ['A', 'M', 'D'].includes(ch.status) ? isEditableDoc(ch.path) : ['R', 'C'].includes(ch.status) && isEditableDoc(ch.path) && isEditableDoc(ch.oldPath);
  return commits.find((c) => !isBotEmail(c.email) && c.parents.length < 2 && !changesOf(c.sha).every(carriable)) ?? null;
}

export const REVIEWER_KINDS = ['deleted', 'renamed', 'declined-create', 'declined-delete'];
const REVIEWER_HEADER = 'Reviewer decisions:';
// A path that could break the one-decision-per-line format never becomes a decision.

const lineSafe = (p) => typeof p === 'string' && !/[\x00-\x1f\x7f]/.test(p) && !p.includes(' -> ');

const sortDecisions = (list) =>
  [...list].sort((a, b) => REVIEWER_KINDS.indexOf(a.kind) - REVIEWER_KINDS.indexOf(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export const describeDecision = (d) => `${d.kind} ${d.path}${d.kind === 'renamed' ? ` -> ${d.to}` : ''}`;

export function renderReviewerDecisions(decisions) {
  if (!decisions.length) return [];
  return [REVIEWER_HEADER, ...sortDecisions(decisions).map((d) => `- ${describeDecision(d)}`)];
}

// Reads back what `commitMessage` wrote. Anyone who can push can forge these lines, which is
// harmless: a decision only ever stops the tool, and each is revalidated against the tree.
export function parseReviewerDecisions(message, isEditableDocPath) {
  const lines = String(message ?? '').split('\n');
  const start = lines.indexOf(REVIEWER_HEADER);
  if (start < 0) return [];
  const ok = (p) => {
    const c = canonicalise(p);
    return c === p && lineSafe(c) && isEditableDocPath(c);
  };
  const out = new Map();
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    const m = line.match(/^- (deleted|renamed|declined-create|declined-delete) (.+)$/);
    if (!m) continue;
    const [, kind, rest] = m;
    if (kind === 'renamed') {
      const parts = rest.split(' -> ');
      if (parts.length === 2 && ok(parts[0]) && ok(parts[1]) && parts[0] !== parts[1]) out.set(parts[0], { kind, path: parts[0], to: parts[1] });
    } else if (ok(rest)) {
      out.set(rest, { kind, path: rest });
    }
  }
  return [...out.values()];
}

// What reviewers did on the rolling branch since the tool's last commit, on top of `previous`
// (the decisions that commit recorded), revalidated against the net branch state. `commits` are
// oldest first. Each reviewer change replaces the decision on its path.
export function classifyReviewerChanges({ commits, changesOf, baseHas, remoteHas, isEditableDoc, previous = [] }) {
  const map = new Map(previous.map((d) => [d.path, { ...d }]));
  let lastTool = -1;
  commits.forEach((c, i) => {
    if (isToolCommit(c)) lastTool = i;
  });
  const removed = (p, to) => {
    if (!baseHas(p)) map.set(p, { kind: 'declined-create', path: p });
    else map.set(p, to ? { kind: 'renamed', path: p, to } : { kind: 'deleted', path: p });
  };
  const added = (p) => {
    if (baseHas(p)) map.set(p, { kind: 'declined-delete', path: p });
    else if (map.get(p)?.kind === 'declined-create') map.delete(p);
  };
  for (const c of commits.slice(lastTool + 1)) {
    if (isToolCommit(c) || c.parents.length > 1) continue;
    for (const ch of changesOf(c.sha)) {
      if (ch.status === 'D') removed(ch.path);
      else if (ch.status === 'A') added(ch.path);
      else if (ch.status === 'R') {
        removed(ch.oldPath, ch.path);
        added(ch.path);
      } else if (ch.status === 'C') added(ch.path);
    }
  }
  const out = [];
  for (const d of map.values()) {
    if (!lineSafe(d.path) || !isEditableDoc(d.path)) continue;
    if (d.kind === 'deleted' || d.kind === 'renamed') {
      if (remoteHas(d.path) || !baseHas(d.path)) continue;
      // A rename whose new file is gone again is just a delete.
      if (d.kind === 'renamed' && !(lineSafe(d.to) && isEditableDoc(d.to) && remoteHas(d.to))) out.push({ kind: 'deleted', path: d.path });
      else out.push(d);
    } else if (d.kind === 'declined-create') {
      if (!remoteHas(d.path) && !baseHas(d.path)) out.push(d);
    } else if (d.kind === 'declined-delete') {
      if (remoteHas(d.path)) out.push(d);
    }
  }
  return sortDecisions(out);
}

// A reviewer delete is live only while it is carried. The target changing the file discards it,
// and the target deleting the file makes it moot.
export function reconcileReviewerCarry({ decisions, stale, obsolete }) {
  const removes = new Set(decisions.filter((d) => d.kind === 'deleted' || d.kind === 'renamed').map((d) => d.path));
  const discarded = stale.filter((s) => s.kind === 'delete' && removes.has(s.path)).map((s) => decisions.find((d) => d.path === s.path));
  const gone = new Set([...discarded.map((d) => d.path), ...obsolete.filter((p) => removes.has(p))]);
  return {
    decisions: decisions.filter((d) => !gone.has(d.path)),
    stale: stale.filter((s) => !(s.kind === 'delete' && removes.has(s.path))),
    discarded,
  };
}

// Carried edits that only removed links to `p`, which a reviewer has since restored. `carried`
// maps a path to { content }.
export function fixupsOfRevertedDelete(p, carried, readTarget) {
  const out = [];
  for (const [q, { content }] of carried) {
    const target = readTarget(q);
    if (target == null || q === p) continue;
    const linksNow = inboundLinks([{ path: q, content }], [p]).get(p).length > 0;
    const linkedBefore = inboundLinks([{ path: q, content: target }], [p]).get(p).length > 0;
    if (linkedBefore && !linksNow) out.push(q);
  }
  return out;
}

// Drops every triage nomination a reviewer decision rules out, with the reason.
export function applyReviewerDecisions({ affected, deletes, decisions }) {
  const by = new Map(decisions.map((d) => [d.path, d]));
  const dropped = [];
  const why = (d, a) => {
    if (!d) return null;
    if (d.kind === 'deleted') return 'deleted by a reviewer';
    if (d.kind === 'renamed') return `renamed by a reviewer to ${d.to}`;
    if (d.kind === 'declined-create' && a.action === 'create') return 'new doc declined by a reviewer';
    if (d.kind === 'declined-delete' && a.action === 'delete') return 'delete reverted by a reviewer';
    return null;
  };
  const keep = (list) =>
    list.filter((a) => {
      const reason = why(by.get(a.path), a);
      if (reason) dropped.push({ path: a.path, action: a.action, reason });
      return !reason;
    });
  return { affected: keep(affected), deletes: keep(deletes), dropped };
}

// Read side of 5.12 step 1. `branchChanges` must come from `--no-renames`: a delete plus a create is not an R.
export function planCarryForward({ branchChanges, targetHas, targetChangedSinceBase, isEditableDoc }) {
  const restore = [];
  const restoreDeletes = [];
  const stale = [];
  const obsolete = [];
  const ignored = [];
  for (const { status, path: p } of branchChanges) {
    if (!isEditableDoc(p) || !['A', 'M', 'D'].includes(status)) ignored.push(p);
    // An added file was never in the target, so only M and D can find it gone.
    else if (status !== 'A' && !targetHas(p)) obsolete.push(p);
    else if (targetChangedSinceBase(p)) stale.push({ path: p, kind: status === 'D' ? 'delete' : 'edit' });
    else if (status === 'D') restoreDeletes.push(p);
    else restore.push(p);
  }
  return { restore, restoreDeletes, stale, obsolete, ignored };
}

