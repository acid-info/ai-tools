import { execFileSync, execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createGitHub } from '#core/github.mjs';
import { anthropicCall, openaiCall } from '#core/providers.mjs';

import { gitAuthEnv } from './git.mjs';

// Every side effect the stages need: git and files in the checkout, GitHub, and the model APIs.
export function createRuntime({ root, githubToken, commitToken, anthropicKey, openaiKey, usage, log, warn, debug }) {
  // `raw` keeps the trailing newline: file contents must round-trip byte for byte. `buffer`
  // returns the bytes untouched.
  function git(args, { quiet = false, input, env, raw = false, buffer = false } = {}) {
    // Unquoted paths, so non-ASCII names match the -z output they are compared with.
    const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root,
      encoding: buffer ? 'buffer' : 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      input,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', quiet ? 'ignore' : 'inherit'],
    });
    return raw || buffer ? out : out.replace(/\n$/, '');
  }
  const gitOk = (args) => {
    try {
      git(args, { quiet: true });
      return true;
    } catch {
      return false;
    }
  };

  const { request: gh, paginate: ghAll } = createGitHub({ token: githubToken, onRetry: warn });
  // Creates the rolling-branch commit: only the Actions token gets it signed. Null when there is
  // no separate commit token, e.g. in a local run.
  const ghCommit = commitToken ? createGitHub({ token: commitToken, onRetry: warn }).request : null;

  // Pushes from a throwaway repo that borrows the checkout's objects: setup_command can write hooks
  // and config into .git, and none of it may run next to the token. `fetch` first fetches a commit
  // that exists only on GitHub, so the push can name it.
  function pushWithToken(args, { fetch: [fetchUrl, fetchSha] = [] } = {}) {
    const objects = resolve(root, git(['rev-parse', '--git-path', 'objects']));
    const dir = mkdtempSync(join(tmpdir(), 'ai-docs-sync-push-'));
    try {
      mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
      mkdirSync(join(dir, 'refs'));
      writeFileSync(join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
      writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
      const env = { GIT_DIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitAuthEnv(githubToken) };
      if (fetchSha) git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', fetchUrl, fetchSha], { env });
      git(['push', '--quiet', ...args], { env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // `git ls-tree` entry for one path: { mode, blob } or null.
  function treeEntry(treeish, p) {
    const line = git(['ls-tree', '-z', treeish, '--', p]).replace(/\0$/, '');
    const m = line.match(/^(\d+) blob ([0-9a-f]+)\t/);
    return m ? { mode: m[1], blob: m[2] } : null;
  }

  const readCheckout = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);

  // Walks the checkout for files matching `pred`; symlinked directories are never entered.
  function walkDocs(pred, dir = '') {
    const out = [];
    for (const name of readdirSync(join(root, dir))) {
      if (name === '.git' || name === 'node_modules') continue;
      const rel = dir ? `${dir}/${name}` : name;
      const st = lstatSync(join(root, rel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) out.push(...walkDocs(pred, rel));
      else if (st.isFile() && pred(rel)) out.push(rel);
    }
    return out;
  }

  function makeFormatter(cfg) {
    if (cfg.format_check !== 'strict') return { mode: 'off' };
    log(`Running setup_command for format_check: strict`);
    execSync(cfg.setup_command, { cwd: root, stdio: 'inherit' });
    const prettier = join(root, 'node_modules', '.bin', 'prettier');
    if (!existsSync(prettier)) throw new Error('format_check: strict but node_modules/.bin/prettier is missing after setup_command');
    return {
      mode: 'strict',
      run: (content, filePath) => {
        try {
          const out = execFileSync(prettier, ['--stdin-filepath', filePath], { cwd: root, encoding: 'utf8', input: content, stdio: ['pipe', 'pipe', 'pipe'] });
          return { ok: true, content: out };
        } catch (e) {
          return { ok: false, error: (e.stderr || e.message || '').toString().trim().split('\n')[0] };
        }
      },
    };
  }

  const callModel = async (spec, label, { system, blocks, maxTokens, stream = false }) => {
    const apiKey = spec.provider === 'anthropic' ? anthropicKey : openaiKey;
    const fn = spec.provider === 'anthropic' ? anthropicCall : openaiCall;
    const r = await fn({ fetch, apiKey, model: spec.model, system, blocks, maxTokens, effort: spec.effort, stream, retry: { onRetry: (m) => warn(`${label}: ${m}`) } });
    usage.log(label, spec.model, r.usage);
    debug(`${label} raw output`, r.text);
    if (r.truncated) warn(`${label}: output cut off by the token budget (stop_reason=${r.stopReason})`);
    return r;
  };

  return { git, gitOk, gh, ghAll, ghCommit, pushWithToken, treeEntry, readCheckout, walkDocs, makeFormatter, callModel };
}
