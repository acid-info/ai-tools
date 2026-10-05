import { canonicalise } from '#core/paths.mjs';
import { approxTokens, mapConcurrent, parseJsonObject } from '#core/text.mjs';

import { DEFAULTS } from './config.mjs';
import { UNTRUSTED } from './prompting.mjs';

export const CHECKER_SYSTEM = `You review documentation changes that another model made in response to a code change. You
are given the change narrative, the code diff, the manifest of editable docs, and for each doc:
the reason it was selected and either the edit (a unified diff and the full new content) or,
for action="delete", the source files cited and the content being deleted.

For edits, look for exactly these failure modes, in priority order:
1. Claims not supported by the diff or the narrative (hallucinated behaviour).
2. Contradictions with the diff.
3. Content that reflects the narrative's stated intent but not what the diff actually does.
4. Content removed that the diff did not invalidate.
5. Edits outside the sections the reason justifies (restyling, reordering, "improvements").
6. Broken or renamed links.
7. Style violations: en/em dashes, attribution lines, model or vendor names.

For action="create" (a new file), also look for:
8. A scope that duplicates a doc already in the manifest (the note names that doc).
9. A create the diff does not justify: nothing new, or small enough to belong in an existing doc.
Either one is "drop" when it holds for the whole doc.

For a delete, the verdict is "ok" only when the diff shows the doc's whole subject gone from the
code. Otherwise it is "drop": the subject still exists, or only part of it was removed. Never
"revise" a delete.
${UNTRUSTED}

Respond with ONLY a JSON object, no markdown fences:
{
  "files": [
    { "path": "docs/x.md", "verdict": "ok" | "revise" | "drop",
      "issues": [ { "severity": "must" | "should", "note": "one sentence, concrete" } ] }
  ]
}
"must" = the doc would state something false or lose something true; "should" = worth fixing,
not wrong. "drop" only when the whole edit is unjustified. Do not invent problems.
Changes in <earlier_diff>, when present, support a claim exactly as the diff does.`;

export function checkerDocBlock(d) {
  if (d.action === 'delete')
    return `<doc path="${d.path}" action="delete">\n<reason>${d.reason}</reason>\n<source_files>${(d.source_files ?? []).join(', ')}</source_files>\n<current_content>\n${d.current ?? ''}\n</current_content>\n</doc>`;
  return `<doc path="${d.path}" action="${d.action}">\n<reason>${d.reason}</reason>\n<edit_diff>\n${d.editDiff || '(new file)'}\n</edit_diff>\n<new_content>\n${d.content}\n</new_content>\n</doc>`;
}

export function checkerUser({ narrative, diff, manifest = '', docs, stale = '' }) {
  return [
    `<narrative>\n${narrative}\n</narrative>`,
    `<diff>\n${diff}\n</diff>`,
    manifest ? `<manifest>\n${manifest}\n</manifest>` : '',
    stale,
    docs.map(checkerDocBlock).join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function batchByTokens(docs, budget, size) {
  const batches = [];
  let current = [];
  let used = 0;
  for (const d of docs) {
    const n = size(d);
    if (current.length && used + n > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(d);
    used += n;
  }
  if (current.length) batches.push(current);
  return batches;
}

// A failed batch (null or a throw from `check`) leaves only its own files unchecked.
export async function checkInBatches(docs, { budget = DEFAULTS.checker_batch_tokens, concurrency = DEFAULTS.writer_concurrency, check }) {
  const batches = batchByTokens(docs, budget, (d) => approxTokens(checkerDocBlock(d)));
  const results = await mapConcurrent(batches, concurrency, async (batch, i) => {
    try {
      return { batch, verdicts: await check(batch, i, batches.length) };
    } catch (error) {
      return { batch, verdicts: null, error };
    }
  });
  const verdicts = new Map();
  const failed = [];
  for (const r of results) {
    if (!r.verdicts) {
      failed.push({ paths: r.batch.map((d) => d.path), error: r.error ?? null });
      continue;
    }
    const inBatch = new Set(r.batch.map((d) => d.path));
    for (const [p, v] of r.verdicts) if (inBatch.has(p)) verdicts.set(p, v);
  }
  return { verdicts, failed, batches: batches.length };
}

export function parseChecker(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.files)) return null;
  const files = new Map();
  for (const f of parsed.files) {
    const p = canonicalise(f?.path);
    if (!p) continue;
    const verdict = ['ok', 'revise', 'drop'].includes(f.verdict) ? f.verdict : 'ok';
    const issues = (Array.isArray(f.issues) ? f.issues : [])
      .map((i) => ({ severity: i?.severity === 'must' ? 'must' : 'should', note: String(i?.note ?? '').trim() }))
      .filter((i) => i.note);
    files.set(p, { verdict, issues });
  }
  return files;
}

// The single-correction rule and its bookkeeping, as a pure decision.
export function decideAfterCheck(verdictEntry, action = 'update') {
  if (!verdictEntry) return { action: 'proceed', unchecked: true, issues: [] };
  const { verdict, issues } = verdictEntry;
  const must = verdict === 'revise' && issues.some((i) => i.severity === 'must');
  if (verdict === 'drop' || (must && action === 'delete')) return { action: 'drop', issues };
  if (must) return { action: 'correct', issues };
  return { action: 'proceed', issues };
}

