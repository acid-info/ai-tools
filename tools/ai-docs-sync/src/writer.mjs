import { approxTokens } from '#core/text.mjs';

import { DEFAULTS } from './config.mjs';
import { HOUSE_STYLE, UNTRUSTED } from './prompting.mjs';
import { triageUser } from './triage.mjs';

export const WRITER_SYSTEM = `You keep documentation in step with code. You are given the repository guidelines, the change
narrative (why the code changed), the code diff (what changed), the manifest of editable docs,
and then one doc to bring up to date with the reason it was selected.

Rules:
- Change only what the diff invalidates. Do not restyle, reorder or "improve" untouched sections.
- When the narrative and the diff disagree, the diff wins. Mention the disagreement in the doc
  only if it describes current behaviour.
- When the diff makes a statement unknowable (a value now comes from the environment, say), say
  so rather than guessing.
- Keep every relative link that still resolves. Use the manifest for cross-references.
- For a new file, follow the structure, heading depth and tone of the doc in <exemplar> when one
  is given, else of comparable docs in the manifest. Do not copy the exemplar's content. Document
  only what the diff and the narrative support.
- <earlier_diff>, when present, is code already on the target branch that a discarded edit of
  this doc documented. It is as much ground truth as the diff.
- Never link to a doc listed in <deleted_this_run>. When the task says to remove a link to one,
  remove the link or retarget it to a surviving doc from the manifest, and adjust the sentence
  around it so it still reads.
- <reviewer_decisions>, when present, are a human reviewer's calls on this pull request. Never
  link to a doc a reviewer declined, and keep every existing link to a doc whose delete a
  reviewer reverted: the reviewer wants that doc kept and reachable.
${HOUSE_STYLE}
${UNTRUSTED}

Output the COMPLETE new file content, nothing else, inside one fenced block that opens with four
backticks on its own line (\`\`\`\`markdown) and closes with four backticks on its own line. No
explanation before or after the fence. Not a patch.`;

export function renderDeletedBlock(deleted = []) {
  if (!deleted.length) return '';
  return `<deleted_this_run>\n${deleted.map((d) => `- ${d.path}: ${d.reason}`).join('\n')}\n</deleted_this_run>`;
}

// Byte-identical across every writer call of a run; the cache breakpoint sits after it.
export function writerPrefix({ guidelines, narrative, diff, manifest, stale = '', reviewer = '', deleted = [] }) {
  return [triageUser({ guidelines, narrative, diff, manifest, stale, reviewer }), renderDeletedBlock(deleted)].filter(Boolean).join('\n\n');
}

function truncateTokens(text, tokens) {
  if (approxTokens(text) <= tokens) return text;
  const cut = text.slice(0, tokens * 4);
  return `${cut.slice(0, cut.lastIndexOf('\n') + 1)}[truncated]\n`;
}

export function writerDocPart({ path: p, action, reason, sourcePatches, current, exemplar = null, exemplarTokens = DEFAULTS.max_doc_tokens / 2 }) {
  const parts = [`<task>\nFile: ${p}\nAction: ${action}\nReason selected: ${reason}\n</task>`];
  if (sourcePatches) parts.push(`<source_patches>\n${sourcePatches}\n</source_patches>`);
  parts.push(action === 'create' ? '<current>\n(file does not exist yet)\n</current>' : `<current path="${p}">\n${current}\n</current>`);
  if (action === 'create' && exemplar?.content != null)
    parts.push(`<exemplar path="${exemplar.path}">\n${truncateTokens(exemplar.content, exemplarTokens).replace(/\n$/, '')}\n</exemplar>`);
  return parts.join('\n\n');
}

export function correctionPart({ draft, issues }) {
  const list = issues.map((i) => `- [${i.severity}] ${i.note}`).join('\n');
  return `<draft>\n${draft}\n</draft>\n\n<checker_issues>\n${list}\n</checker_issues>\n\nRevise your draft to address every "must" issue and any "should" issue you agree with. Output the complete corrected file as before.`;
}

// Takes the first opening fence and the last closing fence of the same kind and at least the
// same length, so fences inside the doc do not end the block early.
export function parseWriterOutput(text) {
  const src = (text ?? '').replace(/\r\n/g, '\n');
  const open = src.match(/^(`{3,}|~{3,})[^\n]*\n/m);
  if (!open) return null;
  const fenceChar = open[1][0];
  const minLen = open[1].length;
  const bodyStart = open.index + open[0].length;
  const closeRe = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${minLen},}[ \\t]*$`, 'gm');
  let last = null;
  for (const m of src.slice(bodyStart).matchAll(closeRe)) last = m;
  if (!last) return null;
  const content = src.slice(bodyStart, bodyStart + last.index);
  return content.replace(/\n?$/, '\n');
}
