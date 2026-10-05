export const CONFIG_PATH = '.github/ai-review.yml';

// Opus 5 and later think by default, and `max_tokens` caps thinking + response
// text together, so the budget has to cover both or the JSON comes back
// truncated. Above 16k the API wants streaming; `effort` bounds thinking's share.
export const MAX_RESPONSE_TOKENS = 16_000;
export const REVIEW_EFFORT = 'medium';

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

// Minimal YAML subset parser (key: value, and "- item" lists) to stay dep-free.
// Only REPO_OVERRIDABLE keys are honoured; anything else is warned about and
// ignored. `ignore` and `guidelines_files` fully REPLACE the DEFAULTS entry:
// a config setting them must restate every default it wants to keep. Reach for
// `extra_ignore` instead: it is appended to the defaults below.
export function loadConfig(text, { warn = () => {} } = {}) {
  const cfg = { ...DEFAULTS };
  if (text == null) return cfg;
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  let currentList = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    // YAML allows block-sequence items at column 0, directly under their key.
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentList) {
      cfg[currentList].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (!REPO_OVERRIDABLE.has(key)) {
      warn(
        `${CONFIG_PATH}: "${key}" is owned centrally by acid-info/ai-tools and was ignored. ` +
          `Settable per repo: ${[...REPO_OVERRIDABLE].join(', ')}.`
      );
      // A rejected key that opens a list would otherwise leave `currentList`
      // pointing at the previous list, silently appending its items there.
      currentList = null;
      continue;
    }
    if (val === '') {
      cfg[key] = [];
      currentList = key;
    } else {
      // Every overridable key is a list: a bare string would later be spread
      // into one-character globs, and "*" alone ignores every root-level file.
      const scalar = unquote(val);
      const flow = scalar.match(/^\[(.*)\]$/);
      cfg[key] = flow ? flow[1].split(',').map(unquote).filter(Boolean) : [scalar];
      currentList = null;
    }
  }
  cfg.ignore = [...cfg.ignore, ...(cfg.extra_ignore ?? [])];
  return cfg;
}
