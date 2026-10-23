import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKER_SYSTEM, checkerUser } from '../src/checker.mjs';
import { DOC_STYLE, UNTRUSTED } from '../src/prompting.mjs';
import { TRIAGE_SYSTEM } from '../src/triage.mjs';
import { WRITER_SYSTEM, correctionPart } from '../src/writer.mjs';

const PROMPTS = { DOC_STYLE, UNTRUSTED, TRIAGE_SYSTEM, WRITER_SYSTEM, CHECKER_SYSTEM };

// Quoted examples ("--", " - ") and code spans may name a dash; the prose around them may not.
const prose = (text) => text.replace(/"[^"\n]*"/g, '""').replace(/`+[^`\n]*`+/g, '``');

describe('prompt text', () => {
  for (const [name, text] of Object.entries(PROMPTS)) {
    test(`${name} has no dashes in prose and no shouted words`, () => {
      assert.ok(!/[\u2013\u2014]/.test(text), 'no en or em dash anywhere');
      assert.ok(!/--/.test(prose(text)), 'no double hyphen in prose');
      assert.ok(!/\S - \S/.test(prose(text)), 'no spaced hyphen in prose');
      assert.ok(!/\b(ONLY|COMPLETE|NOT|NEVER)\b/.test(text), 'no shouted words');
    });
  }

  test('DOC_STYLE puts the guidelines first and keeps the two hard rules', () => {
    assert.match(DOC_STYLE, /<guidelines> and the voice of the doc and its neighbours win/);
    assert.match(DOC_STYLE, /No en or em dashes in prose, and no "--" or " - " standing in for one/);
    assert.match(DOC_STYLE, /No attribution/);
    assert.match(DOC_STYLE, /Never invent a reason, number, command or path/);
    assert.match(DOC_STYLE, /Bullets that start with a bold label/);
  });

  test('the writer shares DOC_STYLE, has one set of rules per case and no "--" instruction', () => {
    assert.ok(WRITER_SYSTEM.includes(DOC_STYLE));
    assert.ok(!WRITER_SYSTEM.includes('two hyphens'));
    assert.match(WRITER_SYSTEM, /Updating a doc \(Action: update\):\n- Change only what the diff invalidates/);
    assert.match(WRITER_SYSTEM, /rewrite it around its main point/);
    assert.match(WRITER_SYSTEM, /Creating a doc \(Action: create\):\n- Give the page one job/);
    assert.match(WRITER_SYSTEM, /nor its habits/);
    assert.match(WRITER_SYSTEM, /Link fix-ups and index updates[^\n]*:\n- Change only the sentence that holds the link/);
    assert.match(WRITER_SYSTEM, /opens with four\nbackticks on its own line \(````markdown\)/, 'output contract unchanged');
  });

  test('a correction applies style notes only to lines already changed', () => {
    const text = correctionPart({ draft: '# d\n', issues: [{ severity: 'should', note: 'hype word' }] });
    assert.match(text, /Apply "should" style notes only to lines you already changed\./);
  });

  test('triage asks a create to name its one job and reader, in plain words', () => {
    assert.match(TRIAGE_SYSTEM, /Its reason names the new doc's one job/);
    assert.match(TRIAGE_SYSTEM, /Reasons are posted in the pull request/);
  });

  test('the checker judges style without blocking on it, and leaves dashes to code', () => {
    assert.ok(!CHECKER_SYSTEM.includes('model or vendor names'), 'a vendor name is no longer a plain violation');
    assert.match(CHECKER_SYSTEM, /only when it appears\n?\s*as the author of the text/);
    assert.match(CHECKER_SYSTEM, /Code already checks\s+dashes and attribution/);
    assert.match(CHECKER_SYSTEM, /Style issues \(modes 7, 10 and 11\) alone never make a verdict "revise" or "drop"/);
    assert.match(CHECKER_SYSTEM, /invented\s+reason or number/);
    assert.match(CHECKER_SYSTEM, /"verdict": "ok" \| "revise" \| "drop"/, 'JSON shape unchanged');
  });

  test('checkerUser renders the guidelines first when given', () => {
    const docs = [{ path: 'docs/a.md', action: 'update', reason: 'r', editDiff: '', content: 'x' }];
    assert.ok(checkerUser({ guidelines: 'Use em dashes.', narrative: 'n', diff: 'd', docs }).startsWith('<guidelines>\nUse em dashes.\n</guidelines>\n\n<narrative>'));
    assert.ok(!checkerUser({ narrative: 'n', diff: 'd', docs }).includes('<guidelines>'));
  });
});
