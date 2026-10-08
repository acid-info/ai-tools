// Creating the rolling-branch commit through GitHub's Git Data API, so GitHub signs it. A commit
// built with `git commit-tree` and pushed stays unsigned, and "require signed commits" rules then
// block the rolling PR.

// `git diff-tree -r -z --no-renames <a> <b>` raw output: one record per changed blob.
export function parseRawDiff(z) {
  const parts = z.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/);
    if (!m) throw new Error(`unexpected git diff-tree record: ${JSON.stringify(parts[i])}`);
    out.push({ srcMode: m[1], dstMode: m[2], srcSha: m[3], dstSha: m[4], status: m[5], path: parts[i + 1] });
  }
  return out;
}

// Tree API entries that turn the parent's tree into ours. A deletion is a null SHA; the API
// prunes a directory it leaves empty, as git does.
export function treeEntries(changes) {
  return changes.map((c) => {
    if (c.status === 'D') return { path: c.path, mode: c.srcMode, type: 'blob', sha: null };
    if (!/^1006[04][04]$/.test(c.dstMode)) throw new Error(`refusing to publish ${c.path}: tree mode ${c.dstMode} is not a regular file`);
    return { path: c.path, mode: c.dstMode, type: 'blob', sha: c.dstSha };
  });
}

// Recreates `tree` on GitHub as a child of `parent` and commits it. Git objects are
// content-addressed, so every SHA GitHub returns must equal the local one: a mismatch means the
// remote tree differs from what the gates checked, and nothing is committed.
//
// GitHub signs the commit only with the Actions token and no custom author; the author is then
// `github-actions[bot]`. Pass `author` for any other token, which cannot get a signature anyway.
export async function createApiCommit({ gh, git, repo, parent, tree, message, author }) {
  const changes = parseRawDiff(git(['diff-tree', '-r', '-z', '--no-renames', parent, tree], { raw: true }));
  for (const c of changes.filter((x) => x.status !== 'D')) {
    const blob = await gh(`/repos/${repo}/git/blobs`, { method: 'POST', body: { content: git(['cat-file', 'blob', c.dstSha], { buffer: true }).toString('base64'), encoding: 'base64' } });
    if (blob.sha !== c.dstSha) throw new Error(`GitHub stored ${c.path} as blob ${blob.sha}, expected ${c.dstSha}`);
  }
  // No changes: an open PR is refreshed with the parent's own tree, which GitHub already has.
  if (changes.length) {
    const remoteTree = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: { base_tree: git(['rev-parse', `${parent}^{tree}`]), tree: treeEntries(changes) } });
    if (remoteTree.sha !== tree) throw new Error(`GitHub built tree ${remoteTree.sha}, expected ${tree}`);
  }
  const commit = await gh(`/repos/${repo}/git/commits`, { method: 'POST', body: { message, tree, parents: [parent], ...(author ? { author } : {}) } });
  return { sha: commit.sha, verified: commit.verification?.verified === true, reason: commit.verification?.reason ?? 'unknown' };
}
