import { existsSync, readFileSync } from 'node:fs';

// Collect the repo-root AGENTS.md plus any AGENTS.md sitting in a directory the
// diff touches: in a monorepo each app/package can carry its own instructions.
function collectAgentsFiles(changedFiles) {
  const found = new Set();
  if (existsSync('AGENTS.md')) found.add('AGENTS.md');
  for (const file of changedFiles) {
    const segs = file.split('/');
    // Filenames come from untrusted PR data: never let them escape the checkout.
    if (file.startsWith('/') || segs.includes('..')) continue;
    for (let i = 1; i < segs.length; i++) {
      const candidate = `${segs.slice(0, i).join('/')}/AGENTS.md`;
      if (existsSync(candidate)) found.add(candidate);
    }
  }
  // Root first, then deeper paths, for a deterministic order.
  return [...found].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// Honour the configured priority list: the first entry that yields content wins.
// AGENTS.md is special-cased to gather every relevant file, not just the root one.
export function loadGuidelines(names, changedFiles = [], { log = console.log, warn = console.warn } = {}) {
  for (const name of names) {
    if (name === 'AGENTS.md') {
      const files = collectAgentsFiles(changedFiles);
      if (files.length) {
        log(`Guidelines loaded from: ${files.join(', ')}`);
        return files
          .map((f) => `--- ${f} ---\n${readFileSync(f, 'utf8')}`)
          .join('\n\n')
          .slice(0, 20_000);
      }
    } else if (existsSync(name)) {
      log(`Guidelines loaded from: ${name}`);
      return readFileSync(name, 'utf8').slice(0, 20_000);
    }
  }
  warn(`[warn] none of the configured guideline files exist (${names.join(', ')}) -- reviewing without guidelines.`);
  return '';
}
