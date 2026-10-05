import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, loadConfig } from '../src/config.mjs';

describe('config', () => {
  test('no file means the defaults', () => {
    assert.deepEqual(loadConfig(null), DEFAULTS);
  });

  test('extra_ignore is appended; ignore and guidelines_files replace the defaults', () => {
    const cfg = loadConfig('extra_ignore:\n  - flake.lock\nguidelines_files: [REVIEW.md]\n');
    assert.deepEqual(cfg.ignore, [...DEFAULTS.ignore, 'flake.lock']);
    assert.deepEqual(cfg.guidelines_files, ['REVIEW.md']);
    assert.deepEqual(loadConfig('ignore:\n- "*.snap"\n').ignore, ['*.snap']);
  });

  test('a bare scalar is a one-item list, never a string spread into characters', () => {
    assert.deepEqual(loadConfig("extra_ignore: '*.lock'\n").extra_ignore, ['*.lock']);
  });

  test('centrally owned keys are warned about and their list items do not leak', () => {
    const warnings = [];
    const cfg = loadConfig('extra_ignore:\n  - a\nanthropic_model: claude-x\nignore_me:\n  - b\n', { warn: (m) => warnings.push(m) });
    assert.equal(cfg.anthropic_model, DEFAULTS.anthropic_model);
    assert.deepEqual(cfg.extra_ignore, ['a']);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /"anthropic_model" is owned centrally/);
  });
});
