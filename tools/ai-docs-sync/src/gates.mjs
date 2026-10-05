import { canonicalise } from '#core/paths.mjs';

import { isGuidelineFile } from './guidelines.mjs';
import { addedLineIndexes, lineDiff, unifiedDiff } from './linediff.mjs';
import { extractRelativeLinks, fencedLines, resolveLink } from './links.mjs';
import { dropOrphanedDependents } from './plan.mjs';

const DASH_RE = /[\u2013\u2014]/g;
const ATTRIBUTION_RE = /co-authored-by|generated (with|by)|🤖/i;
const VENDOR_RE = /\b(anthropic|openai|claude|chatgpt|gpt-?\d)\b/i;
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

export const normaliseContent = (s) =>
  (s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n*$/, '\n');

export function gateAllowlist(file, { isEditableDoc }) {
  const c = canonicalise(file.path);
  if (!c || c !== file.path || !isEditableDoc(c)) return { ok: false, reason: 'path outside the editable allowlist' };
  return { ok: true };
}

export function gateNonEmpty(file, { current }) {
  if (!file.content || !file.content.trim()) return { ok: false, reason: 'empty output' };
  if (current != null && normaliseContent(current) === normaliseContent(file.content)) return { ok: false, reason: 'no change' };
  return { ok: true };
}

// `existsInTree(path)` answers for the post-edit tree: files created this run plus the checkout.
// Only lines this run added are checked: a link that was already broken is not the edit's fault.
export function gateLinks(file, { existsInTree, current }) {
  const lines = file.content.split('\n');
  const inFence = fencedLines(lines);
  const broken = [];
  for (const i of addedLineIndexes(lineDiff(current ?? '', file.content))) {
    if (inFence.has(i)) continue;
    for (const l of extractRelativeLinks(lines[i])) {
      const resolved = resolveLink(file.path, l);
      if (resolved == null || !existsInTree(resolved)) broken.push(l);
    }
  }
  return broken.length ? { ok: false, reason: `broken relative link(s): ${[...new Set(broken)].join(', ')}` } : { ok: true };
}

// Measured against the target branch, not the carried draft, so drift cannot creep run by run.
// A create has no target, so it is bounded by its exemplar: `file.exemplar` is { path, bytes }.
export function gateSize(file, { target }) {
  if (file.action === 'create') {
    const ex = file.exemplar;
    if (!ex || ex.bytes <= 400) return { ok: true };
    const after = Buffer.byteLength(file.content);
    return after > ex.bytes * 3 ? { ok: false, reason: `grew ${(after / ex.bytes).toFixed(1)}x the size of ${ex.path} (${ex.bytes} -> ${after} bytes)` } : { ok: true };
  }
  if (target == null) return { ok: true };
  const before = Buffer.byteLength(target);
  if (before <= 400) return { ok: true };
  const after = Buffer.byteLength(file.content);
  if (after < before * 0.5) return { ok: false, reason: `shrank ${Math.round((1 - after / before) * 100)}% (${before} -> ${after} bytes)` };
  if (after > before * 3) return { ok: false, reason: `grew ${(after / before).toFixed(1)}x (${before} -> ${after} bytes)` };
  return { ok: true };
}

// Fixes dashes on lines this run added or changed, drops on attribution. Returns new content.
export function gateStyle(file, { current }) {
  const lines = file.content.split('\n');
  const added = addedLineIndexes(lineDiff(current ?? '', file.content));
  let fixed = 0;
  for (const i of added) {
    if (/[\u2013\u2014]/.test(lines[i])) {
      lines[i] = lines[i].replace(DASH_RE, '--');
      fixed++;
    }
    if (ATTRIBUTION_RE.test(lines[i])) return { ok: false, reason: `attribution string on line ${i + 1}` };
  }
  return { ok: true, content: lines.join('\n'), fixed };
}

// Reviewer attention flags: never blocking.
export function gateFlags(file, { current, isGuideline }) {
  const flags = [];
  const before = current ?? '';
  const ops = lineDiff(before, file.content);
  const added = addedLineIndexes(ops);
  const lines = file.content.split('\n');
  const oldUrls = new Set(before.match(URL_RE) ?? []);
  const newUrls = new Set();
  const newTags = new Set();
  const vendors = new Set();
  const inFence = fencedLines(lines);
  for (const i of added) {
    const line = lines[i];
    for (const u of line.match(URL_RE) ?? []) if (!oldUrls.has(u)) newUrls.add(u);
    // Markdown renders tags inside code as text, so only prose is scanned; URLs are flagged anywhere.
    if (inFence.has(i)) continue;
    const prose = line.replace(/<!--[\s\S]*?-->/g, '').replace(/(`+)[\s\S]*?\1/g, '');
    for (const t of prose.match(HTML_TAG_RE) ?? []) {
      if (/^<a\s+(name|id)=/i.test(t) || /^<\/a>$/i.test(t)) continue;
      newTags.add(t);
    }
    const v = line.match(VENDOR_RE);
    if (v) vendors.add(v[0]);
  }
  if (newUrls.size) flags.push({ kind: 'new_urls', detail: [...newUrls] });
  if (newTags.size) flags.push({ kind: 'raw_html', detail: [...newTags] });
  if (vendors.size) flags.push({ kind: 'vendor_names', detail: [...vendors] });
  if (isGuideline) flags.push({ kind: 'guideline_edit', detail: unifiedDiff(before, file.content, file.path) });
  return { ok: true, flags };
}

// `format.run(content, path)` returns { ok, content } or { ok: false, error }.
export function gateFormat(file, { format }) {
  if (!format || format.mode !== 'strict') return { ok: true, content: file.content };
  const r = format.run(file.content, file.path);
  if (!r.ok) return { ok: false, reason: `prettier failed: ${r.error}` };
  return { ok: true, content: r.content };
}

// Runs gates 0-6 in order. `carriedDeletes` are still in the checkout, so they must be named.
export function runGates(files, ctx) {
  const { isEditableDoc, readCurrent, readTarget, existsInCheckout, guidelineFiles, format, carriedDeletes = new Set() } = ctx;
  const guidelines = guidelineFiles ?? new Set();
  const dropped = [];
  const orphaned = [];
  const drop = (f, gate, reason) => dropped.push({ path: f.path, gate, reason });

  const stage1 = [];
  for (const f of files) {
    let r = gateAllowlist(f, { isEditableDoc });
    if (!r.ok) {
      drop(f, 0, r.reason);
      continue;
    }
    const current = readCurrent(f.path);
    if (f.action === 'delete') {
      if (current == null) drop(f, 1, 'nothing to delete');
      else stage1.push({ ...f, current });
      continue;
    }
    r = gateNonEmpty(f, { current });
    if (!r.ok) {
      drop(f, 1, r.reason);
      continue;
    }
    stage1.push({ ...f, current });
  }

  const treeOf = (alive) => {
    const edited = new Set(alive.filter((f) => f.action !== 'delete').map((f) => f.path));
    const deleted = new Set(alive.filter((f) => f.action === 'delete').map((f) => f.path));
    return (p) => edited.has(p) || (!deleted.has(p) && !carriedDeletes.has(p) && existsInCheckout(p));
  };
  const pruneOrphans = (alive) => {
    const r = dropOrphanedDependents(alive, new Set(alive.map((f) => f.path)));
    orphaned.push(...r.orphaned);
    return r.kept;
  };

  const alive = pruneOrphans(stage1);
  const existsInTree = treeOf(alive);
  const next = [];
  for (const f of alive) {
    if (f.action === 'delete') {
      const isGuideline = isGuidelineFile(f.path, guidelines);
      const flags = (f.flags ?? []).filter((x) => x.kind !== 'guideline_delete');
      if (isGuideline) flags.push({ kind: 'guideline_delete', detail: unifiedDiff(f.current, '', f.path) });
      next.push({ ...f, flags });
      continue;
    }
    // Against the target, like gate 3, so links carried from earlier runs are re-checked.
    let r = gateLinks(f, { existsInTree, current: readTarget(f.path) });
    if (!r.ok) {
      drop(f, 2, r.reason);
      continue;
    }
    r = gateSize(f, { target: readTarget(f.path) });
    if (!r.ok) {
      drop(f, 3, r.reason);
      continue;
    }
    r = gateStyle(f, { current: f.current });
    if (!r.ok) {
      drop(f, 4, r.reason);
      continue;
    }
    const styled = { ...f, content: r.content, dashesFixed: r.fixed };
    const flags = gateFlags(styled, { current: f.current, isGuideline: isGuidelineFile(f.path, guidelines) }).flags;
    r = gateFormat(styled, { format });
    if (!r.ok) {
      drop(f, 6, r.reason);
      continue;
    }
    next.push({ ...styled, content: r.content, flags });
  }

  // A create or delete held back changes the tree, so gate 2 reruns until nothing more drops.
  let kept = next;
  for (;;) {
    const pruned = pruneOrphans(kept);
    const inTree = treeOf(pruned);
    const survivors = pruned.filter((f) => {
      if (f.action === 'delete') return true;
      const r = gateLinks(f, { existsInTree: inTree, current: readTarget(f.path) });
      if (!r.ok) drop(f, 2, r.reason);
      return r.ok;
    });
    if (survivors.length === kept.length) return { kept: survivors, dropped, orphaned };
    kept = survivors;
  }
}

