import { DEFAULTS } from './config.mjs';
import { approxTokens } from './text.mjs';

// `isAncestor(sha)` must also be false when the object is not present locally.
export function selectRange({ since, cursor, pushBefore, pushForced }, isAncestor) {
  if (since) {
    if (!isAncestor(since)) throw new Error(`since=${since} is not an ancestor of the target branch head`);
    return { from: since, source: 'since' };
  }
  if (cursor && isAncestor(cursor)) return { from: cursor, source: 'cursor' };
  const forced = /^(1|true)$/i.test(String(pushForced ?? ''));
  if (pushBefore && !/^0+$/.test(pushBefore) && !forced && isAncestor(pushBefore))
    return { from: pushBefore, source: 'push_before' };
  return { from: 'HEAD~1', source: 'head~1' };
}

// The loop guard and the "no code files" exit. `isEditableDoc` should be the full predicate.
export function classifyChanges(changes, { isEditableDoc, isIgnored }) {
  const docs = [];
  const code = [];
  const ignored = [];
  for (const c of changes) {
    if (isEditableDoc(c.path)) docs.push(c);
    else if (isIgnored(c.path)) ignored.push(c);
    else code.push(c);
  }
  let skipReason = null;
  if (!changes.length) skipReason = 'no files changed in range';
  else if (docs.length === changes.length) skipReason = 'every changed file is an editable doc (loop guard)';
  else if (!code.length) skipReason = 'no code files changed after ignores';
  return { docs, code, ignored, skipReason };
}

export function packDiff(patches, budget = DEFAULTS.max_diff_tokens) {
  const sorted = [...patches].sort((x, y) => x.patch.length - y.patch.length || x.path.localeCompare(y.path));
  const chunks = [];
  const included = [];
  const omitted = [];
  let left = budget;
  for (const f of sorted) {
    const label = f.status === 'R' && f.oldPath ? `${f.oldPath} -> ${f.path} (rename)` : `${f.path} (${f.status})`;
    const chunk = `--- FILE: ${label} ---\n${f.patch}\n`;
    const cost = approxTokens(chunk);
    if (cost > left) {
      omitted.push(f.path);
      continue;
    }
    left -= cost;
    chunks.push(chunk);
    included.push(f.path);
  }
  let diff = chunks.join('\n');
  if (omitted.length) diff += `\n--- NOT INCLUDED (over budget): ${omitted.join(', ')} ---\n`;
  return { diff, included, omitted };
}

