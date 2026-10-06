# Agent guide

How this repo is built and the rules for changing it. When working on a tool, also read
`tools/<tool>/AGENTS.md`. `README.md` files are written for people: consumers and maintainers.

## Rules

- No npm dependencies and no build step. Node 24 built-ins only.
- Tools import shared code as `#core/<module>.mjs` and never import from another tool.
- Move code into `core/` only when a second tool needs it.
- `main.mjs` is the only file in a tool that reads `process.env`. Modules in `src/` take git,
  fetch and the filesystem as arguments, except where the tool's AGENTS.md says otherwise.
- Every change runs `npm run check && npm test`. New behaviour comes with a test in the tool's
  `test/` or in `core/test/`.
- Text the tools post on GitHub (review bodies, PR bodies, commit messages, markers) and their
  stored state (cursor refs, status contexts, config file names) are consumer contracts: change
  them on purpose, never as a side effect of a refactor.
- Releases are per tool (`<tool>/v1`) and admin-only. Never create, move or push a tag.
- Keep docs in their lane: setup, configuration and behaviour a consumer sees go in the tool's
  README; layout, internals and conventions go in AGENTS.md.

## Layout

```
.github/
  workflows/         one reusable workflow per tool (GitHub only finds them here), CI, and a
                     <tool>-caller.yml per tool that runs its release on this repo
  docs-sync.yml      ai-docs-sync config for this repo
core/                code shared by every tool
tools/<tool>/
  main.mjs           entry point; the only file that reads process.env
  src/               the tool's modules
  test/              node:test suites for src/
  README.md          consumer guide
  AGENTS.md          internals and conventions
test/                repo-wide checks (every import resolves)
```

## How a tool runs

A consumer repo calls `acid-info/ai-tools/.github/workflows/<tool>.yml@<tool>/v1`. The reusable
workflow:

1. checks the consumer repo out on a trusted branch (never a PR head);
2. refuses to run when `job.workflow_sha` is empty, since `actions/checkout` would otherwise fall
   back to this repo's default branch and run code the consumer never pinned;
3. checks this repo out at `job.workflow_sha` into `.ai-tools/`, sparsely: `core/` and
   `tools/<tool>/` only;
4. runs `node .ai-tools/tools/<tool>/main.mjs` on Node 24 with the env it needs.

`#core/*` is a Node subpath import declared in the root `package.json`. Nothing is installed and
nothing is built. Because a consumer pins one commit, a tool and the `core/` it runs with are
always the same version; `core/` has no version of its own.

## core/

| Module | Role |
| --- | --- |
| `api.mjs` | Base URLs and API versions for GitHub, Anthropic and OpenAI. |
| `http.mjs` | `fetchRetry`: per-attempt timeout, one retry with backoff on a 5xx, 429, 529 or network error; a timeout is not retried. SSE parsing. |
| `github.mjs` | REST client for one token, with pagination. |
| `providers.mjs` | `anthropicCall` and `openaiCall`: one request shape for both providers. |
| `models.mjs` | `PRICES`, `EFFORT_MODELS` and `REASONING_MODELS` (effort gating), `costOf`. |
| `usage.mjs` | Per-call usage log and the API usage table both tools render. |
| `guidelines.mjs` | Guideline loading. `AGENTS.md` loads the root file plus one in every directory above a changed file. |
| `paths.mjs` | Built-in ignores, glob matching, path canonicalisation. |
| `yaml.mjs` | The YAML subset consumer config files may use. |
| `markdown.mjs` | Defusing `@mentions` and issue-closing keywords; inline code and code blocks. |
| `text.mjs` | Token estimates, bounded concurrency, JSON extraction from model answers. |

A tool's prompts, config keys and GitHub output stay in the tool, even when they look shareable.

## Testing

- `npm run check` runs `node --check` on every tracked `.mjs`.
- `npm test` runs every `node:test` suite. `test/imports.test.mjs` fails when a relative or
  `#core/` import names a missing file or export, which `node --check` cannot see and which
  would otherwise only fail inside a consumer's Actions run.
- Tests never touch the network: pass fakes for `fetch`, git, model calls and the filesystem.
- CI runs both on Node 24 on every push and pull request.

## Security invariants

Code and workflow changes must keep all of these:

- No job checks out or executes PR-authored code. Config and guideline files come from the
  consumer's trusted branch; diffs arrive over the API as data.
- Nothing from an event payload is interpolated into `run:` script text; pass it through `env`.
- Model output is untrusted: defuse `@mentions` and closing keywords before posting.
- A consumer config only sets the keys in the tool's `REPO_OVERRIDABLE`. Models, effort and
  budgets stay in the tool's `DEFAULTS`; any other key logs a warning and is ignored.
- Whoever moves a tool's tag runs code in every consumer repo. A **reader** only comments; a
  **writer** pushes commits or opens PRs with `contents: write`. A change that turns a reader
  into a writer is a security change, not a refactor.

## Adding a tool

1. `tools/<tool>/main.mjs`, `src/`, `test/`, a consumer `README.md` and an `AGENTS.md`.
2. `.github/workflows/<tool>.yml`: a `workflow_call` workflow that refuses to run when
   `job.workflow_sha` is empty, checks this repo out at it with
   `sparse-checkout: core tools/<tool>`, and runs `main.mjs`. Copy the closest existing one.
3. Consumer config, if any, at `.github/<tool>.yml`, parsed with `#core/yaml.mjs`.
4. Decide reader or writer and add the tool to the table in the root README.
5. Prove it end to end from a sandbox repo before anyone tags `<tool>/v1`.

## Commits

Conventional commits, lowercase, present tense: `type(scope): subject`. The scope is the tool
name or `core`; repo-wide changes have none. Add a short body only when the subject does not say
what changed and why.
