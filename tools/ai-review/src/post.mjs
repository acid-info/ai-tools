import { RANK } from './review.mjs';

const ICON = { critical: '🔴', major: '🟠', minor: '🟡' };

// GitHub caps a comment body at 65536 chars; losing the marker beats losing the review.
const MAX_BODY = 60_000;

// Models sometimes return a null/missing/non-numeric line: anchor only valid ones.
export function issueLine(i) {
  const n = Number(i.line);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Model text derives from untrusted PR content: a crafted diff could steer a
// model into emitting @mentions that ping arbitrary users/teams when posted.
// A zero-width space after "@" keeps the text readable but kills the mention.
export const deMention = (s) => String(s ?? '').replace(/@(?=[A-Za-z\d_/-])/g, '@​');

// `🟠 Major (bug)`: icon, sentence-case severity, category.
function severityLabel(i) {
  const sev = String(i.severity ?? '');
  const category = i.category ? ` (${deMention(i.category)})` : '';
  return `${ICON[i.severity] ?? '•'} ${sev.charAt(0).toUpperCase()}${sev.slice(1)}${category}`;
}

const list = (paths) => `${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', …' : ''}`;

function warningsFor(meta, cfg) {
  const warnings = [];
  if (meta.unlisted)
    warnings.push(`Partial review: GitHub's file listing is capped and left ${meta.unlisted} changed file(s) unlisted.`);
  if (meta.omitted) warnings.push(`Partial review: ${meta.omitted} file(s) exceeded the diff token budget and were not reviewed.`);
  if (meta.noPatch.length)
    warnings.push(
      `Partial review: ${meta.noPatch.length} file(s) had no reviewable diff from GitHub (too large) ` +
        `and were not reviewed (${list(meta.noPatch)}).`
    );
  if (meta.claudeFailed)
    warnings.push(
      `Single-model review: the ${cfg.anthropic_model} reviewer failed ` +
        `(${cfg.openai_model} only, synthesized by ${meta.synthModel}).`
    );
  if (meta.codexFailed)
    warnings.push(
      `Single-model review: the ${cfg.openai_model} reviewer failed ` +
        `(${cfg.anthropic_model} only, synthesized by ${meta.synthModel}).`
    );
  if (meta.claudeUnparsed)
    warnings.push(
      `The ${cfg.anthropic_model} reviewer returned output that could not be parsed, ` +
        `so its findings are missing. See the Actions log for the raw response.`
    );
  if (meta.codexUnparsed)
    warnings.push(
      `The ${cfg.openai_model} reviewer returned output that could not be parsed, ` +
        `so its findings are missing. See the Actions log for the raw response.`
    );
  if (meta.synthFailed) warnings.push('The synthesis step failed. This shows the unmerged reviewer output, which may contain duplicates.');
  return warnings;
}

// The review to post: `body` with inline `comments`, and `flatBody` for when GitHub refuses the
// inline anchors. `usage` is the API usage section, as lines.
export function renderReview(merged, meta, { cfg, prNumber, usage = [], warn = console.warn }) {
  const minRank = RANK[cfg.min_severity_to_post] ?? 2;
  const toPost = merged.issues.filter((i) => (RANK[i.severity] ?? 0) >= minRank);
  const criticals = merged.issues.filter((i) => i.severity === 'critical');
  const others = toPost.filter((i) => i.severity !== 'critical');
  const warnings = warningsFor(meta, cfg);

  // GitHub rejects the WHOLE review if any comment anchors outside the diff, so
  // only anchor lines that exist on the RIGHT side of a reviewed hunk.
  const anchorable = (i) => {
    const line = issueLine(i);
    return line !== null && (meta.validLines.get(i.file)?.has(line) ?? false);
  };
  const anchored = toPost.filter(anchorable);
  const unanchored = toPost.filter((i) => !anchorable(i));

  const flatItem = (i) =>
    `- ${severityLabel(i)} ` +
    `\`${i.file}${issueLine(i) ? `:${issueLine(i)}` : ''}\`: ${deMention(i.issue)}` +
    (i.suggested_fix ? ` **Suggested fix:** ${deMention(i.suggested_fix)}` : '');

  const bodyLines = [
    `## AI review (${cfg.anthropic_model} + ${cfg.openai_model})`,
    '',
    deMention(merged.summary ?? ''),
    '',
    `**${criticals.length} critical**, ${others.length} other issue(s) shown ` +
      `(threshold: ${cfg.min_severity_to_post}).` +
      (meta.skipped ? ` ${meta.skipped} generated/lock file(s) skipped.` : ''),
    ...(warnings.length ? ['', ...warnings] : []),
    ...(unanchored.length ? ['', 'Issues without a diff line to anchor to:', ...unanchored.map(flatItem)] : []),
    ...usage,
  ];

  // Findings ride along in the posted body so a later /ai-fix can read them back
  // off the PR via the API: no artifacts, no cross-run state. Issue text derives
  // from untrusted diff content: escaping `>` stops a model-echoed "-->" closing
  // the comment early and spilling the payload as visible text. JSON.stringify
  // leaves `>` only inside string literals, and > parses back to `>`.
  const findings = JSON.stringify({ v: 1, pr: Number(prNumber), issues: toPost }).replace(/>/g, '\\u003e');
  const marker = `<!-- ai-review:findings ${findings} -->`;
  const finalizeBody = (lines) => {
    let text = lines.join('\n');
    if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY - 100)}\n\n… (truncated to fit GitHub's comment limit)`;
    if (text.length + marker.length + 2 <= MAX_BODY) return `${text}\n\n${marker}`;
    warn(
      `[warn] findings marker omitted: it would push the review body past the ${MAX_BODY}-char ` +
        `guard (body ${text.length}, marker ${marker.length}).`
    );
    return text;
  };

  const comments = anchored.map((i) => ({
    path: i.file,
    line: issueLine(i),
    side: 'RIGHT',
    body:
      severityLabel(i) +
      `${i.agreement ? ', flagged by both models' : ''}\n\n${deMention(i.issue)}\n\n` +
      (i.suggested_fix ? `**Suggested fix:** ${deMention(i.suggested_fix)}` : ''),
  }));

  return {
    body: finalizeBody(bodyLines),
    comments,
    flatBody: () => finalizeBody(anchored.length ? [...bodyLines, '', ...anchored.map(flatItem)] : bodyLines),
    criticals,
  };
}

// The comment for a PR with nothing reviewable after filtering.
export function renderUnreviewable({ noPatch, omitted, unlisted, maxDiffTokens }) {
  const unreviewed = [
    noPatch.length && `GitHub returned no reviewable diff for ${noPatch.length} changed file(s) (diffs too large): ${list(noPatch)}`,
    omitted && `${omitted} file(s) exceeded the diff token budget (${maxDiffTokens} tokens)`,
    unlisted && `GitHub's file listing is capped and left ${unlisted} changed file(s) unlisted`,
  ].filter(Boolean);
  return unreviewed.length
    ? `AI review could not run. These changes were not reviewed:\n` + unreviewed.map((s) => `- ${s}`).join('\n')
    : 'AI review found nothing reviewable in this PR after filtering (lockfiles and generated code are skipped).';
}
