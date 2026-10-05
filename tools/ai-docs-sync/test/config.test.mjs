import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseYamlSubset } from '#core/yaml.mjs';

import { hasSymlinkComponent, makeIsEditableDoc, makeIsEditableDocPath, validateRollingBranch } from '../src/allowlist.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import { CFG_TEXT, cfg, tmpRepo } from './helpers.mjs';

describe('config', () => {
  test('inline flow lists parse like block lists', () => {
    const parsed = parseYamlSubset(`doc_paths: [docs/**/*.md, 'README.md', "apps/*/README.md"]  # inline\nnever_touch: []\n`);
    assert.deepEqual(parsed.doc_paths, ['docs/**/*.md', 'README.md', 'apps/*/README.md']);
    assert.deepEqual(parsed.never_touch, []);
    const isDoc = makeIsEditableDocPath(loadConfig('doc_paths: [docs/**/*.md, README.md]\n'));
    assert.ok(isDoc('docs/a/b.md'));
    assert.ok(isDoc('README.md'));
  });

  test('applies defaults and appends extra_ignore to the built-in list', () => {
    const c = cfg();
    assert.equal(c.branch, 'docs/repo/sync');
    assert.equal('max_docs_per_run' in c, false);
    assert.equal(c.format_check, 'off');
    assert.ok(c.ignore.includes('**/pnpm-lock.yaml'));
    assert.ok(c.ignore.includes('flake.lock'));
  });

  test('warns on and ignores centrally owned keys, and does not leak their list items', () => {
    const warnings = [];
    const c = loadConfig(`${CFG_TEXT}\nanthropic_writer_model: claude-haiku-4-5\nignore:\n  - '**/*.ts'\n`, { warn: (m) => warnings.push(m) });
    assert.equal(c.anthropic_writer_model, DEFAULTS.anthropic_writer_model);
    assert.equal(warnings.length, 2);
    assert.ok(!c.guidelines_files.includes('**/*.ts'));
    assert.ok(!c.ignore.includes('**/*.ts'));
  });

  test('max_docs_per_run gets the removed-key warning, not the centrally-owned one, and is ignored', () => {
    const warnings = [];
    const c = loadConfig(`${CFG_TEXT}\nmax_docs_per_run: 3\n`, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /max_docs_per_run was removed; every affected doc is written/);
    assert.ok(!/owned centrally/.test(warnings[0]));
    assert.equal('max_docs_per_run' in c, false);
    assert.ok(!('max_docs_per_run' in DEFAULTS));
  });

  test('doc_paths is required', () => {
    assert.throws(() => loadConfig('label: x\n'), /doc_paths is required/);
    assert.throws(() => loadConfig('doc_paths:\n'), /doc_paths is required/);
  });

  test('format_check is validated and strict needs setup_command', () => {
    assert.throws(() => loadConfig(`${CFG_TEXT}\nformat_check: warn\n`), /format_check/);
    assert.throws(() => loadConfig(`${CFG_TEXT}\nformat_check: strict\n`), /setup_command/);
    const c = loadConfig(`${CFG_TEXT}\nformat_check: strict\nsetup_command: 'pnpm install'\n`);
    assert.equal(c.format_check, 'strict');
  });
});

describe('allowlist predicate', () => {
  test('doc_paths, never_touch precedence, .md-only rule and the denylist', () => {
    const ok = makeIsEditableDocPath(cfg());
    assert.equal(ok('README.md'), true);
    assert.equal(ok('docs/api/architecture.md'), true);
    assert.equal(ok('apps/api/README.md'), true);
    assert.equal(ok('apps/api/src/README.md'), false, 'one level deep on purpose');
    assert.equal(ok('docs/superpowers/specs/2026-01-01-x.md'), false, 'never_touch wins');
    assert.equal(ok('docs/api/diagram.png'), false, '.md only');
    assert.equal(ok('docs/api/notes.mdx'), false);
    assert.equal(ok('.github/docs-sync.md'), false, 'denylist');
    assert.equal(ok('docs/node_modules/x/README.md'), false, 'denylist');
    assert.equal(ok('content/blog/post.md'), false, 'outside doc_paths');
    assert.equal(ok('docs/../../x.md'), false);
    assert.equal(ok('docs/./x.md'), false);
    const broad = makeIsEditableDocPath(loadConfig('doc_paths:\n  - "**/*.md"\n'));
    assert.equal(broad('.ai-tools/README.md'), false, "the tool's own checkout in the consumer tree");
    assert.equal(broad('docs/x.md'), true);
  });

  test('a symlinked file or directory component is rejected on disk', () => {
    const root = tmpRepo({ 'docs/real.md': '# real\n', 'secret/x.md': '# s\n' });
    symlinkSync(join(root, 'secret'), join(root, 'docs', 'link'));
    symlinkSync(join(root, 'secret', 'x.md'), join(root, 'docs', 'file.md'));
    try {
      assert.equal(hasSymlinkComponent(root, 'docs/real.md'), false);
      assert.equal(hasSymlinkComponent(root, 'docs/link/x.md'), true);
      assert.equal(hasSymlinkComponent(root, 'docs/file.md'), true);
      assert.equal(hasSymlinkComponent(root, 'docs/new.md'), false, 'a file to be created is fine');
      const ok = makeIsEditableDoc(cfg(), root);
      assert.equal(ok('docs/real.md'), true);
      assert.equal(ok('docs/link/x.md'), false);
      assert.equal(ok('docs/file.md'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rolling branch name validation', () => {
    const ctx = { targetBranch: 'develop', defaultBranch: 'main' };
    validateRollingBranch('docs/repo/sync', ctx);
    assert.throws(() => validateRollingBranch('develop', ctx), /target branch/);
    assert.throws(() => validateRollingBranch('main', ctx), /default branch/);
    assert.throws(() => validateRollingBranch('docs/$(rm)', ctx), /Refusing/);
    assert.throws(() => validateRollingBranch('-x', ctx), /Refusing/);
  });
});
