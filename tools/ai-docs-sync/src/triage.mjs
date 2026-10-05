import { canonicalise } from '#core/paths.mjs';

import { UNTRUSTED, cleanList, parseJsonObject } from './prompting.mjs';

export const TRIAGE_SYSTEM = `You decide which documentation files a code change invalidates. You are given the change
narrative (commit and PR messages: why the code changed), the code diff (what changed), a
manifest of the editable docs (path, first heading, size, directories they link to) and the
repository's guidelines. You do not see the doc bodies, except those in <stale_edits>.

Pick a doc only when the diff changes behaviour, structure, commands, names, paths or
configuration that a doc with that heading and location would plausibly describe. Dependency
bumps, formatting, tests and refactors that keep behaviour are usually not worth a docs pass.
Nominate a "create" when the change adds a user- or developer-facing surface (an app, package,
service, CLI command, config area, API, workflow or integration) that no doc in the manifest
covers, and documenting it inside an existing doc would be out of that doc's scope or would
bloat it. Otherwise prefer an "update" of the closest existing doc. A new app or package with no
README, when a sibling has one, is the typical case. A create's path must follow its neighbours
in the manifest: the same directory as comparable docs, the same file naming style (case,
separators, README.md vs index.md). Its reason states what the new doc covers and which
existing doc should link to it.
Nominate a "delete" only when the doc's whole subject no longer exists in the code after this
change: a removed app, package, feature, command, endpoint or config area. A doc that is only
partly invalidated is an "update". Never merge or consolidate docs. A delete's source_files must
name the diff files that removed the subject; judge by the diff, not by what the narrative claims.
${UNTRUSTED}

Respond with ONLY a JSON object, no markdown fences:
{
  "affected": [
    { "path": "docs/x.md", "action": "update" | "create" | "delete",
      "reason": "one or two sentences naming what in the doc is now wrong or missing, or what was removed",
      "source_files": ["paths from the diff the reason rests on"] }
  ],
  "unaffected_reason": "one sentence when affected is empty, else empty string"
}
Paths must be taken verbatim from the manifest for "update" and "delete"; a "create" path must
sit next to comparable docs. Order affected by importance. Do not invent problems.

When a <stale_edits> block is present, re-evaluate every doc it lists, reading its current text
in <stale_doc>: nominate it again as an "update" when that text still misses or contradicts the changes in
<earlier_diff> or <diff>, or as a "delete" when it was listed as deleted and its whole subject is
still gone. Its source_files may name files from <earlier_diff>. Leave it out when the doc already
reflects them.

When a <reviewer_decisions> block is present, a human reviewer made those calls on the docs pull
request and they stand: never nominate a doc a reviewer deleted or renamed away, never "create" a
doc a reviewer declined or one that would take over what a reviewer deleted, and never "delete" a
doc whose delete a reviewer reverted, nor ask for links to it to be removed.`;

// Triage otherwise sees no doc bodies, so `current` carries them (null when too large). `diff` is
// empty when the earlier code changes are already inside the range.
export function renderStaleBlock({ docs = [], from, to, commits = [], diff = '', current = {} } = {}) {
  if (!docs.length) return '';
  const entries = docs.map((d) => (typeof d === 'string' ? { path: d, kind: 'edit' } : d));
  const of = (kind) => entries.filter((e) => e.kind === kind && !e.reason).map((e) => e.path);
  const lines = ['<stale_edits>'];
  if (of('edit').length)
    lines.push(`An earlier run edited these docs, but the target branch changed them before the edit merged, so the edit was discarded: ${of('edit').join(', ')}`);
  if (of('delete').length)
    lines.push(`An earlier run deleted these docs, but the target branch changed them before the delete merged, so the delete was discarded: ${of('delete').join(', ')}`);
  for (const reason of new Set(entries.filter((e) => e.reason).map((e) => e.reason)))
    lines.push(`An earlier run edited these docs, but the edit was discarded because ${reason}: ${entries.filter((e) => e.reason === reason).map((e) => e.path).join(', ')}`);
  if (diff) {
    lines.push(
      `The discarded changes documented the code changes below (${String(from).slice(0, 7)}..${String(to).slice(0, 7)}, already on the target branch before this range), as well as anything in <diff>.`,
      ...(commits.length ? ['Commits:', ...commits.map((c) => `- ${c.short} ${c.subject}`)] : []),
      `<earlier_diff>\n${diff}\n</earlier_diff>`
    );
  } else {
    lines.push('The code changes those edits documented are inside <diff>.');
  }
  for (const { path: p } of entries) {
    const text = current[p];
    lines.push(text == null ? `<stale_doc path="${p}">(too large to include)</stale_doc>` : `<stale_doc path="${p}">\n${text.replace(/\n$/, '')}\n</stale_doc>`);
  }
  lines.push('</stale_edits>');
  return lines.join('\n');
}

// Paths only: the filter after triage is what enforces the decisions; this saves nominations.
export function renderReviewerBlock(decisions = []) {
  if (!decisions.length) return '';
  const of = (kind) => decisions.filter((d) => d.kind === kind);
  const lines = ['<reviewer_decisions>'];
  if (of('deleted').length) lines.push(`Deleted by a reviewer: ${of('deleted').map((d) => d.path).join(', ')}`);
  if (of('renamed').length) lines.push(`Renamed by a reviewer: ${of('renamed').map((d) => `${d.path} -> ${d.to}`).join(', ')}`);
  if (of('declined-create').length) lines.push(`New docs a reviewer declined: ${of('declined-create').map((d) => d.path).join(', ')}`);
  if (of('declined-delete').length) lines.push(`Deletes a reviewer reverted: ${of('declined-delete').map((d) => d.path).join(', ')}`);
  lines.push('</reviewer_decisions>');
  return lines.join('\n');
}

export function triageUser({ guidelines, narrative, diff, manifest, stale = '', reviewer = '' }) {
  return [
    guidelines ? `<guidelines>\n${guidelines}\n</guidelines>` : '',
    `<narrative>\n${narrative}\n</narrative>`,
    `<diff>\n${diff}\n</diff>`,
    `<manifest>\n${manifest}\n</manifest>`,
    stale,
    reviewer,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseTriage(text, { isEditableDocPath, exists }) {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.affected)) return null;
  const byPath = new Map();
  const dropped = [];
  for (const item of parsed.affected) {
    const p = canonicalise(item?.path);
    if (!p || !isEditableDocPath(p)) {
      dropped.push({ path: String(item?.path ?? ''), reason: 'outside the editable allowlist' });
      continue;
    }
    const isDelete = item.action === 'delete';
    if (isDelete && !exists(p)) {
      dropped.push({ path: p, reason: 'delete of a doc that does not exist' });
      continue;
    }
    const prev = byPath.get(p);
    if (prev && (prev.action === 'delete' || !isDelete)) continue;
    const entry = {
      path: p,
      // The model's action is a hint; whether the file exists decides between update and create.
      action: isDelete ? 'delete' : exists(p) ? 'update' : 'create',
      reason: String(item.reason ?? '').trim(),
      source_files: cleanList(item.source_files).map(canonicalise).filter(Boolean),
    };
    if (prev) {
      byPath.delete(p);
      dropped.push({ path: p, reason: 'nominated for both delete and update; the delete wins' });
    }
    byPath.set(p, entry);
  }
  const all = [...byPath.values()];
  return {
    affected: all.filter((a) => a.action !== 'delete'),
    deletes: all.filter((a) => a.action === 'delete'),
    dropped,
    unaffectedReason: String(parsed.unaffected_reason ?? '').trim(),
  };
}
