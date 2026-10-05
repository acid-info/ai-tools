import { posix as path } from 'node:path';

import { isGuidelineFile } from './guidelines.mjs';
import { unifiedDiff } from './linediff.mjs';
import { inboundLinks } from './links.mjs';
import { firstHeading } from './manifest.mjs';

// A delete resting on narrative text alone, with no cited file in `codePaths`, becomes a suggestion.
export function planDeletes({ deletes, codePaths, readCurrent, guidelineFiles = new Set() }) {
  const kept = [];
  const suggested = [];
  for (const d of deletes) {
    if (!d.source_files.some((f) => codePaths.has(f))) {
      suggested.push({ path: d.path, reason: d.reason, why: 'no cited source file is in the diff' });
      continue;
    }
    const current = readCurrent(d.path) ?? '';
    const flags = isGuidelineFile(d.path, guidelineFiles) ? [{ kind: 'guideline_delete', detail: unifiedDiff(current, '', d.path) }] : [];
    kept.push({ ...d, action: 'delete', current, flags });
  }
  return { deletes: kept, suggested };
}

const withFlag = (flags, kind, detail) => [...(flags ?? []).filter((f) => f.kind !== kind), ...(detail.length ? [{ kind, detail }] : [])];

// A model-written reason as a clause that can follow "because" or sit in parentheses.
const clause = (s) => String(s ?? '').trim().replace(/[.\s]+$/, '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
const sentence = (note) => `${note[0].toUpperCase()}${note.slice(1)}.`;
const addNote = (reason, note) => (reason ? `${reason} Also ${note}.` : sentence(note));

export const flagBrokenInbound = (deletes, inbound) =>
  deletes.map((d) => ({ ...d, flags: withFlag(d.flags, 'broken_inbound_links', [...(inbound.get(d.path) ?? [])].sort()) }));

// A linker that already has a task gets no `dependsOn`: it stands on its own reason. `reviewer`
// holds the deleted and renamed decisions; their fix-ups depend on nothing, since those deletes
// are never held back.
export function applyInboundLinks({ affected, deletes, inbound, isEditableDoc, reviewer = [] }) {
  const tasks = affected.map((a) => ({ ...a }));
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  const deletedPaths = new Set([...deletes, ...reviewer].map((d) => d.path));
  const unfixable = new Map();
  const reviewerFixups = new Map();
  const sources = [
    ...deletes.map((d) => ({ d, note: `remove or retarget the link(s) to ${d.path}, deleted this run because ${clause(d.reason)}` })),
    ...reviewer.map((d) => ({
      d,
      note: d.kind === 'renamed' ? `retarget the link(s) to ${d.path} to ${d.to}, renamed by a reviewer` : `remove or retarget the link(s) to ${d.path}, deleted by a reviewer`,
      byReviewer: true,
    })),
  ];
  for (const { d, note, byReviewer } of sources) {
    for (const linker of inbound.get(d.path) ?? []) {
      if (deletedPaths.has(linker)) continue;
      if (!isEditableDoc(linker)) {
        if (!byReviewer) unfixable.set(d.path, [...(unfixable.get(d.path) ?? []), linker]);
        continue;
      }
      if (byReviewer) reviewerFixups.set(d.path, [...(reviewerFixups.get(d.path) ?? []), linker]);
      const t = byPath.get(linker);
      if (t) {
        t.reason = addNote(t.reason, note);
        if (t.dependsOn && !byReviewer) t.dependsOn = [...new Set([...t.dependsOn, d.path])];
        continue;
      }
      const task = { path: linker, action: 'update', reason: sentence(note), source_files: [...(d.source_files ?? [])], ...(byReviewer ? {} : { dependsOn: [d.path] }) };
      tasks.push(task);
      byPath.set(linker, task);
    }
  }
  return { affected: tasks, deletes: flagBrokenInbound(deletes, unfixable), reviewerFixups };
}

// A link fix-up for a delete that was held back has nothing left to fix.
export function dropOrphanedDependents(tasks, alive) {
  const kept = [];
  const orphaned = [];
  for (const t of tasks) {
    const missing = (t.dependsOn ?? []).find((p) => !alive.has(p));
    if (missing) orphaned.push({ path: t.path, reason: `depends on ${missing}, which was held back` });
    else kept.push(t);
  }
  return { kept, orphaned };
}

const dirKey = (d) => (d === '.' ? '/' : `${d}/`);

// A location check, not a count: next to editable docs, one new level under them, or beside a
// sibling directory's doc of the same name. The root never counts as a parent or sibling area,
// or a root README would admit any new top-level directory.
export function createPlacement(p, manifestPaths) {
  const dir = path.dirname(p);
  const parent = path.dirname(dir);
  const dirs = new Set(manifestPaths.map((q) => path.dirname(q)));
  if (dirs.has(dir)) return { ok: true };
  if (dir !== '.' && parent !== '.') {
    if (dirs.has(parent)) return { ok: true };
    const name = path.basename(p);
    if (manifestPaths.some((q) => path.basename(q) === name && path.dirname(path.dirname(q)) === parent)) return { ok: true };
  }
  return { ok: false, reason: `no docs live near ${dirKey(dir)}` };
}

function closestToMedian(entries) {
  if (!entries.length) return null;
  const sizes = entries.map((e) => e.bytes).sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  const median = sizes.length % 2 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) / 2;
  return [...entries].sort((a, b) => Math.abs(a.bytes - median) - Math.abs(b.bytes - median) || (a.path < b.path ? -1 : 1))[0];
}

// The manifest entry a new doc should take its shape from, or null.
export function pickExemplar(p, manifest) {
  const dir = path.dirname(p);
  const parent = path.dirname(dir);
  const name = path.basename(p);
  const others = manifest.filter((m) => m.path !== p);
  const tiers = [
    dir === '.' || parent === '.' ? [] : others.filter((m) => path.basename(m.path) === name && path.dirname(m.path) !== dir && path.dirname(path.dirname(m.path)) === parent),
    others.filter((m) => path.dirname(m.path) === dir),
    dir === '.' ? [] : others.filter((m) => path.dirname(m.path) === parent),
  ];
  for (const t of tiers) if (t.length) return closestToMedian(t);
  return null;
}

// The existing doc that should link to a new one, or null. Guideline files rank last in the
// link-directory rule, so a plain link edit does not banner the PR.
export function findIndexDoc(newPath, manifest, { deleted = new Set(), isEditable = () => true, guidelineFiles = new Set() } = {}) {
  const pool = manifest.filter((m) => m.path !== newPath && !deleted.has(m.path) && isEditable(m.path));
  const has = new Set(pool.map((m) => m.path));
  const dir = path.dirname(newPath);
  const parent = path.dirname(dir);
  const indexIn = (d) => ['README.md', 'index.md'].map((n) => (d === '.' ? n : `${d}/${n}`)).find((q) => has.has(q));
  const byName = indexIn(dir) ?? (dir === '.' ? undefined : indexIn(parent));
  if (byName) return byName;
  const wanted = new Set([dirKey(dir), ...(parent === '.' ? [] : [dirKey(parent)])]);
  // A list of `packages/a/`, `packages/b/` records only those directories, never `packages/`.
  const isSibling = (ld) => parent !== '.' && ld !== '/' && path.dirname(ld.slice(0, -1)) === parent;
  const matches = pool.filter((m) => (m.linkDirs ?? []).some((ld) => wanted.has(ld) || isSibling(ld)));
  const rank = (m) => (isGuidelineFile(m.path, guidelineFiles) ? 1 : 0);
  matches.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return matches[0]?.path ?? null;
}

// Runs before any writer call. A create the placement check refuses is held back here and never
// written. Index updates that are not already tasks come back separately, for the second wave.
export function planCreates({ affected, manifest, deleted = new Set(), isEditable = () => true, guidelineFiles = new Set() }) {
  const pool = manifest.filter((m) => !deleted.has(m.path));
  const poolPaths = pool.map((m) => m.path);
  const tasks = [];
  const refused = [];
  for (const a of affected) {
    if (a.action !== 'create') {
      tasks.push({ ...a });
      continue;
    }
    const placement = createPlacement(a.path, poolPaths);
    if (!placement.ok) {
      refused.push({ path: a.path, reason: `placement: ${placement.reason}` });
      continue;
    }
    const ex = pickExemplar(a.path, pool);
    tasks.push({ ...a, exemplar: ex ? { path: ex.path, bytes: ex.bytes } : null, index: findIndexDoc(a.path, pool, { isEditable, guidelineFiles }) });
  }
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  const indexTasks = new Map();
  for (const c of tasks) {
    if (c.action !== 'create' || !c.index) continue;
    const why = clause(c.reason);
    const existing = byPath.get(c.index);
    if (existing) {
      existing.reason = addNote(existing.reason, `link the new doc ${c.path}${why ? ` (${why})` : ''}`);
      continue;
    }
    const t = indexTasks.get(c.index) ?? { path: c.index, action: 'update', reason: '', source_files: [], dependsOn: [], links: [] };
    t.dependsOn.push(c.path);
    t.links.push({ path: c.path, why });
    t.source_files = [...new Set([...t.source_files, ...c.source_files])];
    indexTasks.set(c.index, t);
  }
  return { affected: tasks, refused, indexTasks: [...indexTasks.values()] };
}

// Wave 2: index updates learn each new doc's drafted title; one whose creates all failed in
// wave 1 is held back before a call is spent on it. `drafts` maps a created path to its content.
export function finaliseIndexTasks(indexTasks, drafts) {
  const tasks = [];
  const orphaned = [];
  for (const t of indexTasks) {
    const links = t.links.filter((l) => drafts.has(l.path));
    if (!links.length) {
      orphaned.push({ path: t.path, reason: `depends on ${t.links[0].path}, which was held back` });
      continue;
    }
    const notes = links.map((l) => {
      const title = firstHeading(drafts.get(l.path));
      return sentence(`link the new doc ${l.path}${title ? `, titled "${title}"` : ''}${l.why ? ` (${l.why})` : ''}`);
    });
    tasks.push({ path: t.path, action: 'update', reason: notes.join(' '), source_files: t.source_files, dependsOn: links.map((l) => l.path) });
  }
  return { tasks, orphaned };
}

// Judged on final content, since an index update can be held back or written without the link.
// `others` are the unchanged docs of the post-edit tree.
export function markNewDocLinks(kept, others = []) {
  const files = [...kept.filter((k) => k.action !== 'delete'), ...others];
  return kept.map((k) => {
    if (k.action !== 'create') return k;
    const linkedFrom = inboundLinks(files.filter((f) => f.path !== k.path), [k.path]).get(k.path).sort();
    const why = k.index ? `the planned link from ${k.index} was not kept` : 'no doc found to link it from';
    return { ...k, linkedFrom, flags: withFlag(k.flags, 'unlinked_new_doc', linkedFrom.length ? [] : [why]) };
  });
}

