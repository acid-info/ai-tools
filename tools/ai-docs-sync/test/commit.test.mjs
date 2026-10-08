import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiCommit, parseRawDiff, treeEntries } from '../src/commit.mjs';
import { BOT_EMAIL, BOT_NAME } from '../src/git.mjs';

const sha = (c) => c.repeat(40);
const Z = '0'.repeat(40);
const RAW =
  `:100644 100644 ${sha('1')} ${sha('2')} M\0docs/a.md\0` +
  `:000000 100644 ${Z} ${sha('3')} A\0docs/new dir/ü.md\0` +
  `:100755 000000 ${sha('4')} ${Z} D\0docs/gone.md\0`;

describe('API commit', () => {
  test('parses raw diff-tree records, including spaces and non-ASCII paths', () => {
    assert.deepEqual(parseRawDiff(RAW), [
      { srcMode: '100644', dstMode: '100644', srcSha: sha('1'), dstSha: sha('2'), status: 'M', path: 'docs/a.md' },
      { srcMode: '000000', dstMode: '100644', srcSha: Z, dstSha: sha('3'), status: 'A', path: 'docs/new dir/ü.md' },
      { srcMode: '100755', dstMode: '000000', srcSha: sha('4'), dstSha: Z, status: 'D', path: 'docs/gone.md' },
    ]);
    assert.deepEqual(parseRawDiff(''), []);
    assert.throws(() => parseRawDiff('garbage\0x\0'), /unexpected git diff-tree record/);
  });

  test('tree entries: blobs by SHA, deletes as a null SHA, never a symlink or submodule', () => {
    assert.deepEqual(treeEntries(parseRawDiff(RAW)), [
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: sha('2') },
      { path: 'docs/new dir/ü.md', mode: '100644', type: 'blob', sha: sha('3') },
      { path: 'docs/gone.md', mode: '100755', type: 'blob', sha: null },
    ]);
    assert.throws(() => treeEntries([{ status: 'M', dstMode: '120000', dstSha: sha('5'), path: 'docs/l.md' }]), /not a regular file/);
  });

  // A fake GitHub that echoes the SHAs a real one would compute, unless told otherwise.
  const setup = ({ raw = RAW, blobSha, treeSha = sha('t') } = {}) => {
    const calls = [];
    const blobs = { [sha('2')]: Buffer.from('edited\n'), [sha('3')]: Buffer.from([0xc3, 0xbc, 0x0a]) };
    const git = (args, opts = {}) => {
      if (args[0] === 'diff-tree') return raw;
      if (args[0] === 'cat-file') {
        assert.equal(opts.buffer, true, 'blobs are read as bytes');
        return blobs[args[2]];
      }
      if (args[0] === 'rev-parse') return sha('p');
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const gh = async (path, { method, body }) => {
      calls.push({ path, method, body });
      if (path.endsWith('/git/blobs')) {
        const hit = Object.entries(blobs).find(([, b]) => b.toString('base64') === body.content);
        return { sha: blobSha ?? hit[0] };
      }
      if (path.endsWith('/git/trees')) return { sha: treeSha };
      if (path.endsWith('/git/commits')) return { sha: sha('c'), verification: { verified: !body.author, reason: body.author ? 'unsigned' : 'valid' } };
      throw new Error(`unexpected ${method} ${path}`);
    };
    return { calls, git, gh };
  };

  test('uploads the changed blobs, rebuilds the tree on the parent and commits it with no author', async () => {
    const { calls, git, gh } = setup();
    const out = await createApiCommit({ gh, git, repo: 'o/r', parent: sha('h'), tree: sha('t'), message: 'docs(x): sync\n' });
    assert.deepEqual(out, { sha: sha('c'), verified: true, reason: 'valid' });
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/repos/o/r/git/blobs', '/repos/o/r/git/blobs', '/repos/o/r/git/trees', '/repos/o/r/git/commits']
    );
    assert.deepEqual(calls[0].body, { content: Buffer.from('edited\n').toString('base64'), encoding: 'base64' });
    assert.equal(calls[2].body.base_tree, sha('p'));
    assert.deepEqual(calls[2].body.tree.map((e) => [e.path, e.sha]), [['docs/a.md', sha('2')], ['docs/new dir/ü.md', sha('3')], ['docs/gone.md', null]]);
    assert.deepEqual(calls[3].body, { message: 'docs(x): sync\n', tree: sha('t'), parents: [sha('h')] }, 'no author, or GitHub will not sign it');
  });

  test('an explicit author is passed through for tokens GitHub will not sign for', async () => {
    const { calls, git, gh } = setup();
    const author = { name: BOT_NAME, email: BOT_EMAIL };
    const out = await createApiCommit({ gh, git, repo: 'o/r', parent: sha('h'), tree: sha('t'), message: 'm', author });
    assert.deepEqual(calls.at(-1).body.author, author);
    assert.equal(out.verified, false);
  });

  test('nothing is committed when GitHub stores different bytes or builds a different tree', async () => {
    for (const [opts, re] of [
      [{ blobSha: sha('9') }, /stored docs\/a\.md as blob 9{40}, expected 2{40}/],
      [{ treeSha: sha('8') }, /built tree 8{40}, expected t{40}/],
    ]) {
      const { calls, git, gh } = setup(opts);
      await assert.rejects(createApiCommit({ gh, git, repo: 'o/r', parent: sha('h'), tree: sha('t'), message: 'm' }), re);
      assert.ok(!calls.some((c) => c.path.endsWith('/git/commits')));
    }
  });

  test('an unchanged tree commits the parent tree without a tree call', async () => {
    const { calls, git, gh } = setup({ raw: '' });
    await createApiCommit({ gh, git, repo: 'o/r', parent: sha('h'), tree: sha('p'), message: 'm' });
    assert.deepEqual(calls.map((c) => c.path), ['/repos/o/r/git/commits']);
  });
});
