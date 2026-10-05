import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.mjs';

export const CFG_TEXT = `
doc_paths:
  - README.md
  - AGENTS.md
  - docs/**/*.md
  - apps/*/README.md
  - apps/*/docs/**/*.md
never_touch:
  - docs/superpowers/specs/**   # dated design records
extra_ignore:
  - flake.lock
  - 'apps/cms/src/app/(payload)/admin/importMap.js'
guidelines_files:
  - AGENTS.md
  - CLAUDE.md
`;

export const cfg = () => loadConfig(CFG_TEXT);

export function tmpRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-docs-sync-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}
