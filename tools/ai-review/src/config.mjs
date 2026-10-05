import { parseYamlSubset } from '#core/yaml.mjs';

export const CONFIG_PATH = '.github/ai-review.yml';

// Opus 5 and later think by default, and `max_tokens` caps thinking + response
// text together, so the budget has to cover both or the JSON comes back
// truncated. Above 16k the API wants streaming; `effort` bounds thinking's share.
export const MAX_RESPONSE_TOKENS = 16_000;
export const REVIEW_EFFORT = 'medium';

// Per attempt. A reviewer can be retried once after an outage, and the job stops at 10 minutes.
export const REVIEW_TIMEOUT_MS = 360_000;
export const SYNTH_TIMEOUT_MS = 120_000;

export const DEFAULTS = {
  anthropic_model: 'claude-opus-5-5',
  openai_model: 'gpt-6-sol',
  synth_model: 'gpt-6-luna',
  synth_effort: 'low',
  max_diff_tokens: 80_000, // hard budget cap
  min_severity_to_post: 'major', // "critical" | "major" | "minor"
  ignore: [
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/poetry.lock',
    '**/Cargo.lock',
    '**/go.sum',
    '**/*.min.js',
    '**/*.map',
    '**/dist/**',
    '**/vendor/**',
    '**/__snapshots__/**',
    '**/*.generated.*',
  ],
  extra_ignore: [],
  guidelines_files: ['AGENTS.md', 'REVIEW.md', 'CONTRIBUTING.md'],
};

// Everything else is owned centrally, in DEFAULTS above: a consumer repo that could
// override the model would put the tool back in three places.
export const REPO_OVERRIDABLE = new Set(['ignore', 'extra_ignore', 'guidelines_files']);

// Only REPO_OVERRIDABLE keys are honoured; anything else is warned about and ignored. Every one
// is a list: `ignore` and `guidelines_files` REPLACE the DEFAULTS entry, so a config setting them
// must restate every default it wants to keep; `extra_ignore` is appended to the defaults instead.
export function loadConfig(text, { warn = () => {} } = {}) {
  const cfg = { ...DEFAULTS };
  for (const [key, val] of Object.entries(parseYamlSubset(text ?? ''))) {
    if (!REPO_OVERRIDABLE.has(key)) {
      warn(
        `${CONFIG_PATH}: "${key}" is owned centrally by acid-info/ai-tools and was ignored. ` +
          `Settable per repo: ${[...REPO_OVERRIDABLE].join(', ')}.`
      );
      continue;
    }
    // A bare string would later be spread into one-character globs, and "*" alone ignores every
    // root-level file.
    cfg[key] = Array.isArray(val) ? val : [String(val)];
  }
  cfg.ignore = [...cfg.ignore, ...cfg.extra_ignore];
  return cfg;
}
