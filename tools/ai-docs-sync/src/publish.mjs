import { renderReviewerDecisions } from './carry.mjs';
import { MARKER_MAX_CHARS, MARKER_RUNS } from './config.mjs';
import { canonicalise } from './paths.mjs';

// `docs/<project>/sync` -> `<project>`.
export function commitScope(branch) {
  const m = String(branch).match(/^[^/]+\/([^/]+)\/[^/]+$/);
  return m ? m[1] : 'repo';
}

export const short7 = (s) => String(s ?? '').slice(0, 7);

// Fixed template: nothing model- or narrative-derived beyond allowlisted paths.
export function commitMessage({ scope, from, to, target, files, deleted = [], carried = [], carriedDeleted = [], reviewerDeleted = [], decisions = [], runUrl }) {
  const lines = [`docs(${scope}): sync with ${short7(from)}..${short7(to)}`, '', `Range: ${from}..${to} on ${target}`, '', 'Files:'];
  for (const f of files) lines.push(`- ${f}`);
  for (const f of deleted) lines.push(`- ${f} (deleted)`);
  for (const f of carried) lines.push(`- ${f} (carried forward)`);
  for (const f of carriedDeleted) lines.push(`- ${f} (deleted, carried forward)`);
  for (const f of reviewerDeleted) lines.push(`- ${f} (deleted by reviewer, carried forward)`);
  // The next run reads this back: the rebuild drops the reviewers' own commits.
  if (decisions.length) lines.push('', ...renderReviewerDecisions(decisions));
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n') + '\n';
}

export const prTitle = ({ scope, target, to }) => `docs(${scope}): sync docs with ${target} (up to ${short7(to)})`;
const MARKER_RE = /<!-- ai-docs-sync (\{[\s\S]*?\}) -->/;

// Informational only, never read for control flow; re-validated because maintainers can edit
// the PR body.
export function parseMarker(body) {
  const m = String(body ?? '').match(MARKER_RE);
  if (!m) return [];
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return (Array.isArray(parsed?.runs) ? parsed.runs : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      at: str(r.at, 40),
      from: str(r.from, 40).replace(/[^0-9a-f]/gi, ''),
      to: str(r.to, 40).replace(/[^0-9a-f]/gi, ''),
      files: (Array.isArray(r.files) ? r.files : []).map(canonicalise).filter(Boolean),
    }))
    .slice(-MARKER_RUNS);
}

// `>` is escaped so no string in the JSON can close the comment.
export function renderMarker(runs, maxChars = MARKER_MAX_CHARS) {
  const render = (rs) => `<!-- ai-docs-sync ${JSON.stringify({ v: 1, runs: rs }).replace(/>/g, '\\u003e')} -->`;
  let kept = runs.slice(-MARKER_RUNS);
  let text = render(kept);
  while (text.length > maxChars && kept.length > 1) text = render((kept = kept.slice(1)));
  return text;
}

// The most recent earlier run that touched `path`, for the carried-forward list.
export const lastRunFor = (runs, p) => [...runs].reverse().find((r) => r.files.includes(p)) ?? null;

// Where a re-run must start to regenerate a dropped edit: the earliest run that touched the file.
// The merge base is only a fallback: every run rebuilds the branch, so it is the last run's head.
export const regenerateFrom = (runs, p, fallback) => runs.find((r) => r.files.includes(p) && r.from)?.from || fallback || '';
