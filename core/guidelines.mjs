import { existsSync } from 'node:fs';
import { posix as path } from 'node:path';

import { canonicalise } from './paths.mjs';

// The root AGENTS.md plus one in every directory above a changed file: in a monorepo each app or
// package can carry its own. Changed paths are untrusted, so only canonical ones are followed.
export function collectAgentsFiles(root, changedFiles) {
  const found = new Set();
  if (existsSync(path.join(root, 'AGENTS.md'))) found.add('AGENTS.md');
  for (const file of changedFiles) {
    const c = canonicalise(file);
    if (!c) continue;
    const segs = c.split('/');
    for (let i = 1; i < segs.length; i++) {
      const candidate = `${segs.slice(0, i).join('/')}/AGENTS.md`;
      if (existsSync(path.join(root, candidate))) found.add(candidate);
    }
  }
  return [...found].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// The first of `names` that exists wins. `readFile` must read the trusted checkout.
export function loadGuidelines(names, root, changedFiles, readFile, { log = () => {}, warn = () => {} } = {}) {
  for (const name of names) {
    if (name === 'AGENTS.md') {
      const files = collectAgentsFiles(root, changedFiles);
      if (files.length) {
        log(`Guidelines loaded from: ${files.join(', ')}`);
        return { files, text: files.map((f) => `--- ${f} ---\n${readFile(f)}`).join('\n\n').slice(0, 20_000) };
      }
    } else if (existsSync(path.join(root, name))) {
      log(`Guidelines loaded from: ${name}`);
      return { files: [name], text: readFile(name).slice(0, 20_000) };
    }
  }
  warn(`none of the configured guideline files exist (${names.join(', ')}); running without guidelines.`);
  return { files: [], text: '' };
}
