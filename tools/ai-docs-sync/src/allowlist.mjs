import { lstatSync } from 'node:fs';
import { posix as path } from 'node:path';

import { DENYLIST } from './config.mjs';
import { canonicalise, makeMatcher } from './paths.mjs';

export function makeIsEditableDocPath(cfg) {
  const inDocs = makeMatcher(cfg.doc_paths);
  const inNever = makeMatcher(cfg.never_touch);
  const denied = makeMatcher(DENYLIST);
  return (p) => {
    const c = canonicalise(p);
    if (!c || !c.endsWith('.md')) return false;
    return inDocs(c) && !inNever(c) && !denied(c);
  };
}

// True when the file or any directory on the way to it is a symlink. Missing components end the
// walk: a file to be created is fine as long as its existing parents are real directories.
export function hasSymlinkComponent(root, canonical) {
  const segs = canonical.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const st = lstatSync(path.join(root, ...segs.slice(0, i)), { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

export function makeIsEditableDoc(cfg, root) {
  const pure = makeIsEditableDocPath(cfg);
  return (p) => pure(p) && !hasSymlinkComponent(root, canonicalise(p));
}

export const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export function validateRollingBranch(branch, { targetBranch, defaultBranch }) {
  if (!BRANCH_NAME_RE.test(branch) || branch.startsWith('-') || branch.includes('..'))
    throw new Error(`Refusing rolling branch name "${branch}": only [A-Za-z0-9._/-] is allowed`);
  if (branch === targetBranch) throw new Error(`Refusing rolling branch "${branch}": it is the target branch`);
  if (defaultBranch && branch === defaultBranch)
    throw new Error(`Refusing rolling branch "${branch}": it is the default branch`);
}

