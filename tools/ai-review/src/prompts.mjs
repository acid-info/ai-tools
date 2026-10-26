import { parseJsonObject } from '#core/text.mjs';

export const REVIEWER_SYSTEM = 'You are a rigorous senior code reviewer. You output only valid JSON.';

// The text fields are posted on the PR verbatim, so the models get the writing rules too.
const WRITING_GUIDE = `How to write the text fields, which are posted on the pull request as you write them:
- "issue": lead with the problem and why it matters. Name the file, function or value involved.
- "suggested_fix": say exactly what to change. Include code when it is short.
- "overall" and "summary": lead with the main risk, or say plainly that the change looks safe.
  Do not repeat the list of issues and do not praise the pull request.
- Use plain words and no hype words (robust, seamless, powerful, comprehensive, leverage).
- No en or em dashes, and no double or spaced hyphen standing in for one. Use a comma, colon,
  full stop or parentheses instead.`;

const REVIEW_SCHEMA = `Respond with only a JSON object, no markdown fences, matching:
{
  "issues": [
    {
      "file": "path/to/file.py",
      "line": 42,                       // line number in the new version of the file
      "severity": "critical|major|minor|nit",
      "category": "bug|security|performance|correctness|maintainability",
      "issue": "one-paragraph description of the problem",
      "suggested_fix": "concrete suggestion, with code if short"
    }
  ],
  "overall": "2-3 sentence overall assessment"
}
Severity guide: critical = will break in production, data loss, security hole.
major = real bug or serious flaw likely to bite. minor = worth fixing, not urgent.
nit = style or preference; use sparingly.
If the PR looks fine, return an empty issues array. Do not invent problems.`;

export function reviewPrompt(diff, guidelines) {
  return `Review this pull request diff. Focus on problems the change introduces:
bugs, security issues, broken edge cases, races, incorrect logic, dangerous migrations.
Do not comment on the style of code the change did not touch. Do not restate the diff.

Dependency versions: your training data has a knowledge cutoff and may be behind
the latest releases. Assume a version greater than what you know is a legitimate newer
release. Do not flag a dependency version as wrong, invalid, or "does not exist", and do
not suggest downgrading, only because the version in the diff is newer than the latest
you are aware of. Only raise version issues you can justify from the diff itself:
incoherence between package.json files in the same repo (e.g. the same dependency pinned
to different versions across workspaces, or a version that contradicts a range or
constraint declared elsewhere in the change).
${guidelines ? `\nTeam guidelines to respect:\n<guidelines>\n${guidelines}\n</guidelines>\n` : ''}
<diff>
${diff}
</diff>

${REVIEW_SCHEMA}

${WRITING_GUIDE}`;
}

export function synthesisPrompt(reviewA, reviewB) {
  return `Two independent AI reviewers analyzed the same pull request.

Reviewer A (Claude):
${JSON.stringify(reviewA, null, 2)}

Reviewer B (Codex):
${JSON.stringify(reviewB, null, 2)}

Merge them:
1. Deduplicate: the same problem in the same file, reported twice, becomes one issue. Keep the clearer wording.
2. Mark "agreement": true on issues both reviewers found (strong signal), false otherwise.
3. Drop all "nit" issues entirely. Keep severities honest and do not inflate them.
4. Sort by severity: critical, major, minor.

Respond with only JSON:
{
  "issues": [{ "file", "line", "severity", "category", "issue", "suggested_fix", "agreement" }],
  "summary": "3-5 sentence synthesis for the PR author: overall assessment and the key risks"
}

${WRITING_GUIDE}`;
}

// `diag` separates a truncated answer from a refusal from malformed output.
export function parseReview(text, source, diag = {}, { warn = console.error } = {}) {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    warn(
      `[warn] ${source} returned unparseable output; treating as empty review. ` +
        `(model=${diag.model ?? '?'}, stop_reason=${diag.stopReason ?? '?'}, ` +
        `output_tokens=${diag.outputTokens ?? '?'}, text_length=${text.length})`
    );
    if (/max_tokens|max_output_tokens|length/.test(String(diag.stopReason)))
      warn(
        `[warn] the answer was cut off by the token budget -- raise MAX_RESPONSE_TOKENS ` +
          `(currently ${diag.maxTokens ?? '?'}) or lower REVIEW_EFFORT / synth_effort in tools/ai-review/src/config.mjs.`
      );
    if (diag.stopReason === 'refusal') warn(`[warn] the model declined this request; no review was produced.`);
    warn(text.trim() ? `[warn] ${source} raw output (first 300 chars): ${text.slice(0, 300)}` : `[warn] ${source} returned no text content at all.`);
    // Non-enumerable: the synthesis prompt JSON.stringify()s these objects.
    return Object.defineProperty({ issues: [], overall: `(${source} output could not be parsed)` }, 'parseFailed', { value: true });
  }
  parsed.issues = (parsed.issues ?? []).map((i) => ({ ...i, source }));
  return parsed;
}
