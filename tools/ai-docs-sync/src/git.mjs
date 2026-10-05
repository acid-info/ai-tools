import { API } from './api.mjs';

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

// With DOCS_SYNC_TOKEN the committer is the PAT's bot account, whose address is not known here;
// any GitHub bot-account address counts as ours.
export const isBotEmail = (email) =>
  email === BOT_EMAIL || /\[bot\]@users\.noreply\.github\.com$/i.test(email ?? '');

// Committer email identifies the tool's own commits; author email survives a rebase merge and
// is what PR commits are matched on.
export const GIT_LOG_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%ce%x00%P%x00%s%x00%b%x01';

export function parseGitLog(raw) {
  return raw
    .split('\x01')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, short, author, authorEmail, email, parents, subject, body = ''] = rec.split('\x00');
      return {
        sha,
        short,
        author,
        authorEmail,
        email,
        parents: parents ? parents.split(' ') : [],
        subject: subject ?? '',
        body: body.trim(),
      };
    });
}

// Parses `git diff --name-status -z -M`: R/C records carry two paths, everything else one.
export function parseNameStatus(zOutput) {
  const parts = zOutput.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (newPath === undefined) break;
      out.push({ status: status[0], path: newPath, oldPath });
    } else {
      const p = parts[i++];
      if (p === undefined) break;
      out.push({ status: status[0], path: p });
    }
  }
  return out;
}

// Splits one `git diff` output into per-file patches keyed by the new path.
export function splitUnifiedDiff(raw) {
  const out = [];
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    if (!header) continue;
    let status = 'M';
    if (/^new file mode/m.test(chunk)) status = 'A';
    else if (/^deleted file mode/m.test(chunk)) status = 'D';
    else if (/^rename from /m.test(chunk)) status = 'R';
    out.push({ path: header[2], oldPath: header[1], status, patch: chunk.trimEnd() });
  }
  return out;
}

// "Update with rebase" makes GitHub the committer but keeps the tool as author.
export const isToolCommit = (c) => isBotEmail(c.email) || isBotEmail(c.authorEmail);

// The token reaches git only through this environment: never argv, never .git/config.
export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${API.github.gitUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    // An empty value resets the helper list, so a stored credential cannot stand in for a bad token.
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}
