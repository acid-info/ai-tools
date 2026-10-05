#!/usr/bin/env node
// The only file that reads process.env. Side effects live in src/runtime.mjs, the pipeline in
// src/stages/, and everything else in src/ is pure.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeMatcher } from '#core/paths.mjs';
import { makeUsageLog } from '#core/usage.mjs';

import { makeIsEditableDoc, makeIsEditableDocPath, validateRollingBranch } from './src/allowlist.mjs';
import { VERSION, loadConfig, pickModels } from './src/config.mjs';
import { createRuntime } from './src/runtime.mjs';
import { carryForward } from './src/stages/carry-forward.mjs';
import { checkDocs } from './src/stages/check-docs.mjs';
import { gateDocs } from './src/stages/gate-docs.mjs';
import { pickRange } from './src/stages/pick-range.mjs';
import { publish } from './src/stages/publish.mjs';
import { readChanges } from './src/stages/read-changes.mjs';
import { readDocs } from './src/stages/read-docs.mjs';
import { report } from './src/stages/report.mjs';
import { triageDocs } from './src/stages/triage-docs.mjs';
import { writeDocs } from './src/stages/write-docs.mjs';

const {
  GITHUB_TOKEN,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
  REPO,
  TARGET_BRANCH,
  PUSH_BEFORE,
  PUSH_FORCED,
  SINCE,
  RUN_URL,
} = process.env;
// Children (setup_command, prettier, git) inherit process.env; only the push gets a token back.
for (const k of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
const truthy = (v) => /^(1|true|yes)$/i.test(v ?? '');
const DRY_RUN = truthy(process.env.DRY_RUN);
const TRIAGE_ONLY = truthy(process.env.TRIAGE_ONLY);
const DEBUG = truthy(process.env.DEBUG);
const ROOT = process.cwd();

const log = (m) => console.log(m);
const warn = (m) => console.warn(`[warn] ${m}`);
const debug = (label, text) => {
  if (DEBUG) console.error(`[debug] ${label}:\n${text}\n[debug] end ${label}`);
};

// In order. Each stage reads what it needs from the context and returns what later stages use;
// `{ done: true }` ends the run.
const STAGES = [pickRange, readChanges, carryForward, readDocs, triageDocs, writeDocs, checkDocs, gateDocs, report, publish];

async function main() {
  const missing = [
    ['GITHUB_TOKEN', GITHUB_TOKEN],
    ['REPO', REPO],
    ['TARGET_BRANCH', TARGET_BRANCH],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length) throw new Error(`Missing required env var(s): ${missing.join(', ')}`);

  const models = pickModels({ anthropic: ANTHROPIC_API_KEY, openai: OPENAI_API_KEY });
  const usage = makeUsageLog(log, warn);
  const rt = createRuntime({ root: ROOT, githubToken: GITHUB_TOKEN, anthropicKey: ANTHROPIC_API_KEY, openaiKey: OPENAI_API_KEY, usage, log, warn, debug });
  const { git, gh } = rt;

  // 5.1 config, allowlist, guidelines
  const cfgPath = join(ROOT, '.github', 'docs-sync.yml');
  if (!existsSync(cfgPath)) throw new Error('.github/docs-sync.yml not found on the target branch');
  const cfg = loadConfig(readFileSync(cfgPath, 'utf8'), { warn });
  const isEditableDocPath = makeIsEditableDocPath(cfg);
  const isEditableDoc = makeIsEditableDoc(cfg, ROOT);
  const isIgnored = makeMatcher(cfg.ignore);

  let defaultBranch = '';
  try {
    defaultBranch = (await gh(`/repos/${REPO}`)).default_branch ?? '';
  } catch (e) {
    warn(`could not read the default branch (${e.message}); rolling branch checked against the target only`);
  }
  validateRollingBranch(cfg.branch, { targetBranch: TARGET_BRANCH, defaultBranch });

  const head = git(['rev-parse', 'HEAD']);
  log(`ai-docs-sync ${VERSION}: ${REPO} target ${TARGET_BRANCH} at ${head.slice(0, 7)}` + (DRY_RUN ? ' (dry run)' : '') + (TRIAGE_ONLY ? ' (triage only)' : ''));

  const ctx = {
    ...rt,
    log,
    warn,
    REPO,
    TARGET_BRANCH,
    PUSH_BEFORE,
    PUSH_FORCED,
    SINCE,
    RUN_URL,
    DRY_RUN,
    TRIAGE_ONLY,
    ROOT,
    models,
    usage,
    cfg,
    isEditableDocPath,
    isEditableDoc,
    isIgnored,
    head,
  };
  for (const stage of STAGES) {
    const out = await stage(ctx);
    if (out?.done) return;
    Object.assign(ctx, out);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (DEBUG && err?.stack) console.error(err.stack);
  process.exit(1);
});
