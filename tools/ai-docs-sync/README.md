# ai-docs-sync

Keeps a repo's documentation in step with its code. On every push to the target branch it reads
the code diff, the commit messages and any linked PRs, decides which docs are affected, and
updates, creates or deletes them. A second model checks every change, mechanical gates run, and
the result lands in a single rolling pull request. Humans merge it.

## Adding it to a repo

Create `.github/workflows/ai-docs-sync.yml` on your **default branch**:

```yaml
# AI docs sync. The tool lives in acid-info/ai-tools (tools/ai-docs-sync); edit it there.
# Runs on every push to the target branch and maintains one rolling docs PR.
name: AI Docs Sync

on:
  push:
    # List every branch that could be the target. The shared workflow resolves the real one at
    # run time and exits for the others, so over-listing is harmless.
    branches: [develop, main, master]
  workflow_dispatch:
    inputs:
      since:
        description: 'Commit SHA to diff from (backfill / re-run). Defaults to the cursor.'
        required: false
      dry_run:
        description: 'Print the would-be PR instead of pushing it'
        type: boolean
        default: false

permissions:
  contents: write
  pull-requests: write
  statuses: write

jobs:
  sync:
    uses: acid-info/ai-tools/.github/workflows/ai-docs-sync.yml@ai-docs-sync/v1
    with:
      # Optional. Forces the target branch. Omitted: `develop` if it exists, else the default
      # branch. Lives here rather than in .github/docs-sync.yml because the config file is read
      # from the target branch, so it cannot also choose it.
      target_branch: ''
      since: ${{ inputs.since }}
      dry_run: ${{ inputs.dry_run == true }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      # Optional. A fine-grained PAT from a shared bot account. Only needed when the default
      # branch requires status checks on every PR; see "Secrets".
      DOCS_SYNC_TOKEN: ${{ secrets.DOCS_SYNC_TOKEN }}
```

Then add a [configuration](#configuration) file on the target branch.

- `push` workflows run from the workflow file at the pushed commit, so you can try the tool end to
  end by temporarily listing a feature branch under `branches:`.
- Pass the secrets explicitly. Do **not** use `secrets: inherit`: the tool has no business seeing
  an `NPM_TOKEN` or a database URL.
- `ai-docs-sync/v1` is a moving tag. Pin a commit SHA instead for immutability.

### Secrets

| Secret | Required |
| --- | --- |
| `ANTHROPIC_API_KEY` | Yes. The writer calls Claude Opus 5.5. |
| `OPENAI_API_KEY` | Yes. Triage calls GPT-6 Luna; the checker calls GPT-6 Sol. |
| `DOCS_SYNC_TOKEN` | No. Escape hatch, see below. |

`GITHUB_TOKEN` is enough with **one repo setting**: an admin enables "Allow GitHub Actions to
create and approve pull requests" (Settings, Actions, General, Workflow permissions). While it is
off, opening the PR fails with a 403 and the tool says so.

A PR opened with `GITHUB_TOKEN` triggers no other workflows, so the rolling PR gets no CI. It
only touches Markdown, and the tool reports its own checks as a `docs-sync/gates` commit status.

If that setting is locked by your org, or the default branch requires a status check on every
PR, set `DOCS_SYNC_TOKEN` to a fine-grained PAT from a shared bot account with `contents: write`,
`pull-requests: write` and `statuses: write` on that repo only. The tool then pushes and opens
the PR as that account, which also triggers CI.

Either way, the rolling commit is created with the workflow's own token and signed by GitHub, so
it passes "require signed commits" rules.

## Configuration

At `.github/docs-sync.yml`, read from the **target branch**. Only `doc_paths` is required.

| Key | Effect |
| --- | --- |
| `doc_paths` | Globs the tool may create, edit or delete. Markdown only. |
| `never_touch` | Subtracted from `doc_paths`. Everything under `.github/` is always excluded. |
| `extra_ignore` | Code paths to ignore in the diff, added to the built-in list. |
| `guidelines_files` | Priority list of guideline files; the first that exists is loaded. `AGENTS.md` also loads any nested `AGENTS.md` above a changed file. |
| `branch` | Rolling branch name. Default `docs/repo/sync`. Must not be the target or default branch. |
| `narrative_max_tokens` | Budget for commit and PR messages fed to the models. Default `6000`. |
| `label` | Label on the rolling PR. Default `docs-sync`. |
| `format_check` | `off` (default) or `strict`, which runs your prettier and needs `setup_command`. |
| `setup_command` | Shell run before prettier, e.g. `corepack enable && pnpm install --frozen-lockfile`. |

```yaml
doc_paths:
  - README.md
  - AGENTS.md
  - docs/**/*.md
  - apps/*/README.md
  - packages/*/README.md

never_touch:
  - docs/superpowers/specs/**      # dated design records, not maintained docs

extra_ignore:
  - flake.lock

guidelines_files:
  - AGENTS.md
  - CLAUDE.md
```

The file is a YAML subset: `key: value` lines, and lists as `- item` lines or inline `[a, b]`.
`#` comments are fine; nothing nested.

Models, effort and budgets are set centrally, for every consumer. Setting them in your config logs
a warning and does nothing.

Guideline files such as `AGENTS.md` and `CLAUDE.md` are edited like any other doc when
`doc_paths` covers them, and any edit or delete of one is bannered at the top of the PR with its
diff. List them in `never_touch` to keep them hand-maintained.

## Reviewing the rolling PR

There is one rolling branch and one PR per repo, updated in place by every run.

- **Merge** it to accept the changes. **Close** it to drop them all; the next run that has
  something to say opens a fresh PR.
- Unmerged changes carry over to the next run. If your target branch changes a file the PR also
  changes, the tool drops its version and redoes it on top of yours if it is still needed.
- You can push to the branch: edit, add, delete or rename docs within `doc_paths`, or use
  "Update branch". Any other commit (code, other files) makes the tool refuse to run until the
  branch is renamed or deleted.
- **Your changes win** while the PR is open. A doc you delete stays deleted, a doc you restore
  stays, and links follow a rename. The PR body lists these under "Reviewer changes on this
  branch", with how to undo each.
- **To reject a new doc**, delete it and revert the index doc's link to it in the same commit.
  The tool will not create it again while the PR stays open.
- The PR body explains every change: why the doc was picked, what the checker said, and which
  commits and PRs it came from.

## The cursor

`refs/ai-docs-sync/cursor` in your repo marks the last target-branch commit the tool processed.
Each run covers `cursor..HEAD` and moves the cursor when it finishes; a failed run leaves it, so
the next push retries the range. Read or move it by hand:

```bash
git ls-remote origin refs/ai-docs-sync/cursor
```

```bash
git push -f origin <sha>:refs/ai-docs-sync/cursor
```

To reprocess a range without moving the cursor, run the workflow by hand with `since=<sha>`, an
ancestor of the target head. A run covers at most the newest 250 commits, so backfill a long
history in slices.

## Security

- The job checks out your target branch, never a PR head. The diff, commit messages and PR
  bodies are only ever data for the models.
- The tool can only write or delete `.md` files inside `doc_paths` minus `never_touch` and a
  built-in denylist. At worst, a prompt-injected diff produces a bad doc change in a PR a human
  reviews.
- No write credential is left in the checkout, and the token and API keys are hidden from
  `setup_command` and prettier. `setup_command` is not sandboxed, though: if you do not trust
  your install scripts, keep `format_check: off`.
- Whoever can push the `ai-docs-sync/v1` tag runs code with `contents: write` in your repo. See
  [Security model](../../README.md#security-model) for who that is.

## Contributing

Internals, local runs and model changes are in [AGENTS.md](AGENTS.md).

## License

MIT.
