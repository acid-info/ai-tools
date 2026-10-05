import { BUILT_IN_IGNORE } from '#core/paths.mjs';
import { parseYamlSubset } from '#core/yaml.mjs';

export const VERSION = '1.0.0';

// Models, effort and budgets are owned here. Change a model in DEFAULTS, then update PRICES and
// check EFFORT_MODELS in core/models.mjs: all three or the cost line and effort silently drift.
export const DEFAULTS = {
  triage_model: 'gpt-6-luna',
  writer_model: 'claude-opus-5-5',
  checker_model: 'gpt-6-sol',
  triage_effort: 'low',
  writer_effort: 'medium',
  checker_effort: 'medium',
  max_diff_tokens: 60_000,
  max_doc_tokens: 16_000,
  writer_max_tokens: 32_000,
  response_max_tokens: 16_000,
  writer_concurrency: 3,
  max_commits: 250,
  max_pr_lookups: 50,
  max_stale_diff_tokens: 20_000,
  checker_batch_tokens: 100_000,
  // Repo-overridable, see REPO_OVERRIDABLE.
  doc_paths: [],
  never_touch: [],
  extra_ignore: [],
  guidelines_files: ['AGENTS.md', 'CLAUDE.md'],
  branch: 'docs/repo/sync',
  narrative_max_tokens: 6000,
  label: 'docs-sync',
  format_check: 'off',
  setup_command: '',
};

export const REPO_OVERRIDABLE = new Set([
  'doc_paths',
  'never_touch',
  'extra_ignore',
  'guidelines_files',
  'branch',
  'narrative_max_tokens',
  'label',
  'format_check',
  'setup_command',
]);

export const REMOVED_KEYS = {
  max_docs_per_run: 'max_docs_per_run was removed; every affected doc is written',
};

// Never writable, whatever doc_paths says. `.ai-tools/` is where the workflow checks out this
// tool inside the consumer's tree.
export const DENYLIST = ['.github/**', '.git/**', '**/node_modules/**', '.ai-tools/**'];

export const CURSOR_REF = 'refs/ai-docs-sync/cursor';
export const STATUS_CONTEXT = 'docs-sync/gates';
export const PR_BODY_MAX = 60_000;
export const MARKER_RUNS = 20;
export const MARKER_MAX_CHARS = 20_000;
export const BANNER_DIFF_MAX = 8_000;

export function loadConfig(text, { warn = () => {} } = {}) {
  const cfg = { ...DEFAULTS };
  const parsed = parseYamlSubset(text ?? '');
  for (const [key, val] of Object.entries(parsed)) {
    if (Object.hasOwn(REMOVED_KEYS, key)) {
      warn(`.github/docs-sync.yml: ${REMOVED_KEYS[key]}. The key was ignored; remove it.`);
      continue;
    }
    if (!REPO_OVERRIDABLE.has(key)) {
      warn(
        `.github/docs-sync.yml: "${key}" is owned centrally by acid-info/ai-docs-sync and was ignored. ` +
          `Settable per repo: ${[...REPO_OVERRIDABLE].join(', ')}.`
      );
      continue;
    }
    cfg[key] = val;
  }
  for (const k of ['doc_paths', 'never_touch', 'extra_ignore', 'guidelines_files']) {
    if (!Array.isArray(cfg[k])) cfg[k] = cfg[k] === '' || cfg[k] == null ? [] : [String(cfg[k])];
  }
  if (!cfg.doc_paths.length) throw new Error('.github/docs-sync.yml: doc_paths is required and must list at least one glob');
  if (!['off', 'strict'].includes(cfg.format_check))
    throw new Error(`.github/docs-sync.yml: format_check must be "off" or "strict", got "${cfg.format_check}"`);
  if (cfg.format_check === 'strict' && !cfg.setup_command)
    throw new Error('.github/docs-sync.yml: format_check: strict needs setup_command');
  if (!Number.isInteger(cfg.narrative_max_tokens) || cfg.narrative_max_tokens < 1)
    throw new Error('.github/docs-sync.yml: narrative_max_tokens must be a positive integer');
  cfg.branch = String(cfg.branch);
  cfg.setup_command = String(cfg.setup_command ?? '');
  cfg.ignore = [...BUILT_IN_IGNORE, ...cfg.extra_ignore];
  return cfg;
}

export function pickModels({ anthropic, openai }, d = DEFAULTS) {
  const missing = [];
  if (!anthropic) missing.push('ANTHROPIC_API_KEY');
  if (!openai) missing.push('OPENAI_API_KEY');
  if (missing.length) throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
  return {
    triage: { provider: 'openai', model: d.triage_model, effort: d.triage_effort },
    writer: { provider: 'anthropic', model: d.writer_model, effort: d.writer_effort },
    checker: { provider: 'openai', model: d.checker_model, effort: d.checker_effort },
  };
}
