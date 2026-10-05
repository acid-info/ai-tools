import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectAgentsFiles, loadGuidelines } from '../guidelines.mjs';

function tmpRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ai-tools-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

test('AGENTS.md files are gathered from the root and touched directories', () => {
  const names = ['AGENTS.md', 'CLAUDE.md'];
  const root = tmpRepo({ 'AGENTS.md': 'root', 'apps/api/AGENTS.md': 'api', 'apps/web/AGENTS.md': 'web', 'CLAUDE.md': 'claude' });
  try {
    assert.deepEqual(collectAgentsFiles(root, ['apps/api/src/x.ts', '../escape']), ['AGENTS.md', 'apps/api/AGENTS.md']);
    const g = loadGuidelines(names, root, ['apps/api/src/x.ts'], (f) => `<${f}>`);
    assert.deepEqual(g.files, ['AGENTS.md', 'apps/api/AGENTS.md']);
    assert.match(g.text, /--- AGENTS\.md ---\n<AGENTS\.md>\n\n--- apps\/api\/AGENTS\.md ---/);
    rmSync(join(root, 'AGENTS.md'));
    rmSync(join(root, 'apps'), { recursive: true });
    assert.deepEqual(loadGuidelines(names, root, [], (f) => `<${f}>`).files, ['CLAUDE.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no guideline file is a warning and empty text', () => {
  const root = tmpRepo({ 'README.md': 'x' });
  const warnings = [];
  try {
    assert.deepEqual(loadGuidelines(['AGENTS.md'], root, [], () => '', { warn: (m) => warnings.push(m) }), { files: [], text: '' });
    assert.match(warnings[0], /none of the configured guideline files exist \(AGENTS\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
