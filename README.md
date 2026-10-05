# ai-tools

AI workflows for GitHub pull requests and repositories, shipped as reusable workflows. One repo,
one shared core, one release tag per tool.

| Tool | Kind | Workflow | What it does |
| --- | --- | --- | --- |
| [ai-review](tools/ai-review) | reader | `.github/workflows/ai-review.yml` | Two models review a PR on `/ai-review`, a third merges their findings. |
| [ai-docs-sync](tools/ai-docs-sync) | writer | `.github/workflows/ai-docs-sync.yml` | Keeps a repo's docs in step with its code through a rolling PR. |

A **reader** only comments. A **writer** pushes commits or opens PRs, so it runs with
`contents: write` in every consumer repo. The difference decides who may release it (see
[Security model](#security-model)).

## Layout

```
.github/workflows/   one reusable workflow per tool (GitHub only finds them here), plus CI
core/                code shared by every tool: model calls, retries, pricing, GitHub REST,
                     YAML and glob parsing, guideline loading, Markdown escaping
tools/<tool>/
  main.mjs           entry point; the only file that reads process.env
  src/               the tool's modules, pure unless the README says otherwise
  test/              node:test suites for src/
  README.md          setup, configuration and behaviour for consumers
test/                repo-wide checks (every import resolves)
```

## How a tool runs

A consumer repo calls `acid-info/ai-tools/.github/workflows/<tool>.yml@<tool>/v1`. The reusable
workflow checks the consumer repo out, then checks this repo out at `job.workflow_sha` (the exact
commit the consumer's ref resolved to) into `.ai-tools/`, sparsely: `core/` and `tools/<tool>/`
only. It then runs `node .ai-tools/tools/<tool>/main.mjs`.

Tools import shared code as `#core/<module>.mjs`, a Node subpath import declared in the root
`package.json`. Nothing is installed and nothing is built.

## Dependencies

- **No npm dependencies, no build step.** Everything runs on Node 22 built-ins (`fetch`,
  `node:test`). `package.json` holds scripts and the `#core/*` alias only.
- **Tools depend on `core/`, never on each other.** A tool that needs another tool's code moves
  that code into `core/` first.
- **`core/` grows by the rule of two.** Code moves there when a second tool needs it, not before.
  A tool's prompts, config keys and GitHub output stay in the tool.
- Because a consumer pins one commit, a tool and the `core/` it runs with are always the same
  version. `core/` has no version of its own.

## Development

```bash
npm run check
```

```bash
npm test
```

`check` runs `node --check` on every module. `test` runs every suite, including
`test/imports.test.mjs`, which fails when a relative or `#core/` import names a missing file or
export. `node --check` alone cannot see that, and consumers run these files straight from a tag.

## Releasing

Each tool has its own moving major tag, `<tool>/v1`. After a change is merged to `master`:

```bash
git checkout master && git pull && git tag -f ai-review/v1 && git push -f origin ai-review/v1
```

Release only the tools the change is meant for. A change to `core/` reaches a tool only when that
tool's tag moves, so each tool can be rolled forward, or held back, on its own. Consumers that want
immutability pin a commit SHA instead of the tag.

## Security model

Whoever can move a tool's tag runs code in every consumer repo with that repo's `GITHUB_TOKEN` and
API keys; for a writer, that includes `contents: write`. One shared tag would let anyone trusted
to release a reader turn it into a writer everywhere, which is why every tool has its own tag.

Before production consumers switch to this repo, a repo admin sets up:

1. **Tag rulesets** (Settings, Rules, Rulesets, target "Tags"), one per pattern:
   `ai-review/*` for the reader maintainers, `ai-docs-sync/*` (and every future writer's pattern)
   for the smaller writer group. Block creation, update and deletion for everyone else.
2. **A branch ruleset on `master`** requiring a pull request with code owner review.
3. **`.github/CODEOWNERS`** with real owners: `core/` and every writer tool owned by the writer
   group, since `core/` code runs inside the writers. The file holds a commented template.

Until then anyone with push access can move any tag, which is weaker than the old two-repo split.

Per tool:

- The job never checks out PR-authored code; config and guideline files come from the consumer's
  trusted branch, and diffs arrive over the API as data.
- The caller's `permissions:` block bounds the job. Consumers pass secrets explicitly, never
  `secrets: inherit`.
- Model output is untrusted: `@mentions` and issue-closing keywords are defused before anything
  is posted.

## Adding a tool

1. `tools/<tool>/main.mjs`, `src/`, `test/` and a `README.md` written for consumers.
2. `.github/workflows/<tool>.yml`: a `workflow_call` workflow that refuses to run when
   `job.workflow_sha` is empty, checks this repo out at it with
   `sparse-checkout: core tools/<tool>`, and runs `main.mjs`. Copy the closest existing one.
3. Consumer config, if any, at `.github/<tool>.yml`, parsed with `#core/yaml.mjs`. Only the keys
   the tool lists as repo-overridable are honoured; models and budgets stay in the tool.
4. Decide reader or writer, add the tag pattern to the matching ruleset and, for a writer,
   the tool to `CODEOWNERS`.
5. Prove it end to end from a sandbox repo before tagging `<tool>/v1`.

## Migration status

`acid-info/ai-review` and `acid-info/ai-docs-sync` still serve production consumers at their `v1`
tags and are unchanged. Both tools here are verified end to end in a sandbox repo. To move a
consumer, change its `uses:` line to `acid-info/ai-tools/.github/workflows/<tool>.yml@<tool>/v1`
(ai-docs-sync consumers keep their `.github/docs-sync.yml`, cursor ref and rolling branch). Archive
the old repos once no consumer references them.
