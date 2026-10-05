import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { codeBlock, defuse, defuseRefs, inlineCode } from '../markdown.mjs';

describe('defuse', () => {
  test('mentions and closing keywords are neutralised and length is capped', () => {
    assert.equal(defuse('thanks @octocat, fixes #12 and Closes  #13'), 'thanks @\u200boctocat, fixes #\u200b12 and Closes #\u200b13');
    assert.equal(defuse('a'.repeat(500), 20).length, 20);
    assert.equal(defuse('a\n\nb  c'), 'a b c');
  });
});

describe('defusing for GitHub text', () => {
  test('every closing-keyword form and raw HTML is neutralised', () => {
    assert.equal(defuse('Fixes: #7'), 'Fixes: #​7');
    assert.equal(defuse('resolves acme/web#9'), 'resolves acme/web#​9');
    assert.equal(defuse('closed https://github.com/a/b/issues/3'), 'closed​ https://github.com/a/b/issues/3');
    assert.equal(defuse('see #12'), 'see #12', 'a plain reference is left alone');
    assert.equal(defuse('x <!-- hide --> <img src=y>'), 'x &lt;!-- hide --&gt; &lt;img src=y&gt;');
  });

  test('inline code and fenced blocks cannot be broken out of', () => {
    assert.equal(inlineCode('a`b'), '``a`b``');
    assert.equal(inlineCode('`x'), '`` `x ``');
    assert.equal(inlineCode('@octocat'), '`@​octocat`');
    const block = codeBlock('+ ```js\n+ fixes #4\n', 'diff');
    assert.ok(block.startsWith('````diff\n') && block.endsWith('\n````'));
    assert.match(block, /fixes #​4/);
    assert.equal(defuseRefs('line one\n@team'), 'line one\n@​team', 'multiline text keeps its newlines');
  });
});
