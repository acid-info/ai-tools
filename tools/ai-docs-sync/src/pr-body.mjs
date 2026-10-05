import { API } from './api.mjs';
import { BANNER_DIFF_MAX, PR_BODY_MAX } from './config.mjs';
import { codeBlock, defuse, inlineCode } from './markdown.mjs';
import { renderMarker, short7 } from './publish.mjs';

function checkerLines(k, notes = true) {
  const issues = notes ? (k.check?.issues ?? []).map((i) => `    - [${i.severity}] ${defuse(i.note)}`) : [];
  if (k.check?.unchecked) return ['  - Checker: **unchecked** (no verdict for this file)'];
  if (k.check?.action === 'correct')
    return [
      k.corrected ? '  - Checker requested changes, addressed in the correction pass' + (notes ? ':' : '') : '  - Checker requested changes; the correction pass failed, first draft kept' + (notes ? ':' : ''),
      ...issues,
    ];
  if (issues.length) return ['  - Checker: ok, with notes (not blocking):', ...issues];
  return ['  - Checker: ok'];
}

const FLAG_NAMES = { new_urls: 'new URLs', raw_html: 'raw HTML', vendor_names: 'vendor names' };
const flagText = (f) => `${FLAG_NAMES[f.kind] ?? f.kind}: ${f.detail.slice(0, 20).map((d) => inlineCode(d, 200)).join(', ')}`;

// Parentheses are escaped too: they would end a Markdown link.
export const blobUrl = (repo, sha, p) =>
  `${API.github.gitUrl}/${repo}/blob/${sha}/${p.split('/').map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;

function banner(kind, p, detail, withDiff, byReviewer = false) {
  const head =
    kind === 'guideline_delete'
      ? `> **Guideline file deleted${byReviewer ? ' by a reviewer' : ''}: ${inlineCode(p)}.** Every later model run in this repo loses what it says. Read what it removes.`
      : `> **Guideline file edited: ${inlineCode(p)}.** Whatever merges here is obeyed by every later model run in this repo. Read this diff line by line.`;
  const out = ['> [!WARNING]', head, ''];
  if (!withDiff) return [...out, '_Diff not shown, to keep this body under the size limit; it is in the commit._', ''];
  if (detail.length <= BANNER_DIFF_MAX) return [...out, codeBlock(detail, 'diff'), ''];
  const cut = detail.slice(0, BANNER_DIFF_MAX);
  return [...out, codeBlock(cut.slice(0, cut.lastIndexOf('\n') + 1), 'diff'), `_Diff cut at ${BANNER_DIFF_MAX} characters; the full diff is in the commit._`, ''];
}

const list = (paths, max = 20) => `${paths.slice(0, max).map((l) => inlineCode(l)).join(', ')}${paths.length > max ? `, and ${paths.length - max} more` : ''}`;

// One entry of "Reviewer changes on this branch", with its undo hint. `r.fixed` are the docs whose
// links were fixed this run, `r.linkers` the docs that still link to the path.
function reviewerLines(r, { repo, target, to, detail }) {
  const p = inlineCode(r.path);
  const head = {
    deleted: `- ${p} deleted by a reviewer. To undo, restore the file on the branch` + (repo && detail ? ` ([${short7(to)} copy](${blobUrl(repo, to, r.path)})).` : '.'),
    renamed: `- ${p} renamed to ${inlineCode(r.to ?? '')} by a reviewer. To undo, rename it back on the branch.`,
    'declined-create': `- ${p} new doc declined by a reviewer; not created again while this PR is open. To undo, add the file back on the branch.`,
    'declined-delete': `- ${p} delete reverted by a reviewer; not deleted again while this PR is open. To undo, delete it again on the branch.`,
    discarded: `- Reviewer delete of ${p} discarded because ${inlineCode(target)} changed the file; delete it again on the branch if still wanted.`,
  }[r.kind];
  if (!head) return [];
  if (!detail) return [head];
  const out = [head];
  if (r.fixed?.length) out.push(`  - Links to it fixed this run in ${list(r.fixed)}`);
  if (r.linkers?.length) out.push(`  - Still linked from ${list(r.linkers)}`);
  for (const q of r.requeued ?? [])
    out.push(`  - The carried link fix-up in ${inlineCode(q.path)} was discarded and sent back to triage: ${q.redone ? 'redone this run' : 'not selected again'}.`);
  return out;
}

// Over `maxChars` detail is shed level by level; the deleted paths and the marker are never cut.
export function renderPrBody({
  repo = '',
  target,
  from,
  to,
  commitCount,
  capped = false,
  runUrl,
  kept = [],
  deleted = [],
  reviewer = [],
  carried = [],
  stale = [],
  dropped = [],
  heldBack = [],
  suggestedDeletes = [],
  omittedDiff = [],
  outline = [],
  usage = { entries: [], total: 0, unpriced: [] },
  runs = [],
  maxChars = PR_BODY_MAX,
}) {
  const sec = (title, lines) => (lines.length ? ['', `#### ${title}`, ...lines] : []);
  const created = kept.filter((k) => k.action === 'create');
  const edited = kept.filter((k) => k.action !== 'create');

  const render = (level) => {
    const notes = level < 1;
    const flags = level < 2;
    const detail = level < 3;
    const head = [];
    for (const k of [...deleted, ...reviewer, ...kept]) {
      const g = k.flags?.find((f) => f.kind === 'guideline_edit' || f.kind === 'guideline_delete');
      if (g) head.push(...banner(g.kind, k.path, g.detail, detail, reviewer.includes(k)));
    }
    head.push(
      `Automated documentation update for ${inlineCode(target)}.`,
      '',
      `**Range:** \`${short7(from)}..${short7(to)}\` on ${inlineCode(target)}, ${commitCount} commit(s)` +
        (capped ? ' (capped: older commits were not processed)' : '') +
        (runUrl ? ` -- [run](${runUrl})` : '')
    );
    head.push(
      ...sec(
        'Deleted this run',
        deleted.flatMap((d) => {
          if (!detail) return [`- ${inlineCode(d.path)} (deleted)`];
          const linkers = d.flags?.find((f) => f.kind === 'broken_inbound_links')?.detail ?? [];
          return [
            `- ${inlineCode(d.path)} -- ${defuse(d.reason)}`,
            ...checkerLines(d, notes),
            ...(linkers.length ? [`  - Still linked from, not fixed here: ${linkers.slice(0, 20).map((l) => inlineCode(l)).join(', ')}${linkers.length > 20 ? `, and ${linkers.length - 20} more` : ''}`] : []),
            ...(repo ? [`  - To restore it: [${short7(to)} copy](${blobUrl(repo, to, d.path)})`] : []),
          ];
        })
      ),
      ...sec('Reviewer changes on this branch', reviewer.flatMap((r) => reviewerLines(r, { repo, target, to, detail })))
    );
    const rest = [
      ...sec(
        'New docs',
        created.flatMap((k) => {
          if (!detail) return [`- ${inlineCode(k.path)} (create)`];
          const unlinked = k.flags?.find((f) => f.kind === 'unlinked_new_doc');
          const linkers = k.linkedFrom ?? [];
          return [
            `- ${inlineCode(k.path)} -- ${defuse(k.reason)}`,
            ...checkerLines(k, notes),
            linkers.length
              ? `  - Linked from ${linkers.slice(0, 5).map((l) => inlineCode(l)).join(', ')}${linkers.length > 5 ? `, and ${linkers.length - 5} more` : ''}`
              : `  - **Not linked from any doc**${unlinked ? ` (${defuse(unlinked.detail[0])})` : ''}`,
          ];
        })
      ),
      ...sec(
        'Edited this run',
        edited.flatMap((k) =>
          detail
            ? [
                `- ${inlineCode(k.path)} (${k.action}) -- ${defuse(k.reason)}`,
                ...checkerLines(k, notes),
                ...(flags && k.dashesFixed ? [`  - ${k.dashesFixed} line(s) had en/em dashes replaced with \`--\``] : []),
              ]
            : [`- ${inlineCode(k.path)} (${k.action})`]
        )
      ),
      ...sec(
        'Carried forward from earlier runs (unchanged this run)',
        carried.map((c) => `- ${inlineCode(c.path)}` + (c.deleted ? ' (deleted)' : c.created ? ' (new)' : '') + (detail && c.run ? ` (from \`${short7(c.run.from)}..${short7(c.run.to)}\`)` : ''))
      ),
      ...sec(
        `Earlier changes discarded because ${inlineCode(target)} changed the file`,
        stale.map(
          (st) =>
            `- ${inlineCode(st.path)}${st.kind === 'delete' ? ' (delete)' : ''}: ` +
            (st.redone
              ? 'redone this run on top of the new version (see above).'
              : 'triage was asked again and did not select it.' + (detail && st.since ? ` To force it, re-run with \`since=${st.since}\`.` : ''))
        )
      ),
      ...sec('Held back', [
        ...dropped.map((d) => (detail ? `- ${inlineCode(d.path)} -- gate ${d.gate}: ${defuse(d.reason)}` : `- ${inlineCode(d.path)} (gate ${d.gate})`)),
        ...heldBack.map((h) => (detail ? `- ${inlineCode(h.path)} -- ${defuse(h.reason)}` : `- ${inlineCode(h.path)}`)),
      ]),
      ...(flags
        ? sec(
            'New links, raw HTML and vendor names to check',
            kept.flatMap((k) => (k.flags ?? []).filter((f) => FLAG_NAMES[f.kind]).map((f) => `- ${inlineCode(k.path)}: ${flagText(f)}`))
          )
        : []),
      ...sec(
        'Suggested deletions (not acted on)',
        suggestedDeletes.map((d) => (detail ? `- ${inlineCode(d.path)} -- ${defuse(d.reason)}${d.why ? ` (${defuse(d.why)})` : ''}` : `- ${inlineCode(d.path)}`))
      ),
      ...sec('Diff not shown to the models (over budget)', omittedDiff.slice(0, 100).map((p) => `- ${inlineCode(p)}`)),
    ];
    return { head: head.join('\n'), rest };
  };

  const narrative = outline.flatMap((g) => [
    g.pr ? `- #${g.pr.number} ${defuse(g.pr.title, 200)}` : '- Commits not from a PR',
    ...g.commits.map((c) => `  - \`${short7(c.short)}\` ${defuse(c.subject, 200)}`),
  ]);
  const cost = (e) => (e.cost == null ? '?' : `$${e.cost.toFixed(4)}`);
  const tail = sec('API usage', [
    '| Call | Model | In | Cached | Out | Cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...usage.entries.map((e) => `| ${defuse(e.label, 120)} | ${e.model} | ${e.input} | ${e.cacheRead} | ${e.output} | ${cost(e)} |`),
    '',
    `Total ~$${usage.total.toFixed(4)}` + (usage.unpriced.length ? ` (excludes unpriced: ${usage.unpriced.join(', ')})` : ''),
  ]).join('\n');

  const marker = renderMarker(runs);
  const budget = maxChars - marker.length - 200;
  const MAX_LEVEL = 4;
  let level = 0;
  let parts = render(level);
  const size = (p) => p.head.length + p.rest.join('\n').length + 1;
  while (level < MAX_LEVEL && size(parts) + tail.length > budget) parts = render(++level);

  const keepTail = size(parts) + tail.length <= budget;
  let room = budget - parts.head.length - 1 - (keepTail ? tail.length + 1 : 0);
  const rest = [];
  for (const [i, line] of parts.rest.entries()) {
    if (line.length + 1 > room - 60) {
      rest.push(`- ... ${parts.rest.length - i} more line(s) not shown; see the commit`);
      break;
    }
    rest.push(line);
    room -= line.length + 1;
  }
  const narr = [];
  for (const [i, line] of narrative.entries()) {
    if (line.length + 1 > room - 60) {
      narr.push(`- ... ${narrative.length - i} more line(s) not shown`);
      break;
    }
    narr.push(line);
    room -= line.length + 1;
  }
  let text = [parts.head, ...rest, ...sec('Commits and PRs in this range', narr), ...(keepTail ? [tail] : [])].join('\n');
  const limit = maxChars - marker.length - 2;
  if (text.length > limit) text = text.slice(0, limit - 20) + '\n\n... (truncated)';
  return `${text}\n\n${marker}\n`;
}
