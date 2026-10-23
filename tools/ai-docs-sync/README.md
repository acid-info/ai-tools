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
the PR as that account, which also triggers CI. Requesting a team as reviewer also needs it, with
the `members: read` organization permission added.

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
| `reviewers` | Users (`@login`) and teams (`@org/team`, same org as the repo) asked to review the rolling PR each time it is opened or updated. Default none. |

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

reviewers:
  - '@acid-info/web'               # a team: needs DOCS_SYNC_TOKEN, see below
```

The file is a YAML subset: `key: value` lines, and lists as `- item` lines or inline `[a, b]`.
`#` comments are fine; nothing nested.

Models, effort and budgets are set centrally, for every consumer. Setting them in your config logs
a warning and does nothing.

A bare `@web` is a user called `web`; write a team as `@org/web`. The leading `@` is optional.
Entries are checked when the config loads: one that is not a valid login or `org/team`, or a
team from another org, fails the run. Duplicates are dropped. A failed review request is logged
as a warning and the run carries on. The Actions token cannot read org teams, so without
`DOCS_SYNC_TOKEN` a team request always fails with a 422 ("Could not resolve to a node with the
global id"). Either set `DOCS_SYNC_TOKEN` with `members: read` on the org, or list the team's
members by login.

Guideline files such as `AGENTS.md` and `CLAUDE.md` are edited like any other doc when
`doc_paths` covers them, and any edit or delete of one is bannered at the top of the PR with its
diff. List them in `never_touch` to keep them hand-maintained.

## How it writes

New docs and the text it adds or changes in existing docs follow one style: lead with what the
thing is for or with the command the reader came for, explain why when the diff gives a reason,
use active verbs and plain words, address the reader as "you" and the team as "we", and keep one
term for one thing. No hype words, no bullets that start with a bold label, no emoji, headings in
sentence case, and tables only for reference data with short cells.

Your guidelines win on voice. The first file in `guidelines_files` that exists is loaded, plus any
nested `AGENTS.md` above a changed file, and the tool writes in their voice and keeps the doc's
own terms. Two rules hold whatever they say: no en or em dashes in prose, with no `--` or spaced
hyphen standing in for one, and no attribution ("Generated with", "Co-Authored-By"). Guidelines
that ask for em dashes still lose them.

Dashes are fixed twice. A dash, or an attribution string, on a line the tool adds becomes a `must`
issue for the single correction pass, so the writer fixes it with the paragraph around it.
Whatever survives that (the correction failed, or the writer left a dash in) is replaced by
gate 4, which turns a number range into a hyphen, a pair into parentheses and a single dash into a
colon or a comma. The PR body names every line it changed, so check they read well. Attribution
that survives the correction drops the doc.

It only restyles text it has to change. A paragraph the diff invalidates is rewritten around its
main point; a paragraph the edit does not touch keeps its wording. Style notes from the checker
and the "Style to check (not blocking)" list in the PR body advise a reviewer; neither holds a doc
back.

## Reviewing the rolling PR

There is one rolling branch and one PR per repo, updated in place by every run.

- Merge it to accept the changes, or close it to drop them all; the next run that has something to
  say opens a fresh PR.
- Unmerged changes carry over to the next run. If your target branch changes a file the PR also
  changes, the tool drops its version and redoes it on top of yours if it is still needed.
- You can push to the branch: edit, add, delete or rename docs within `doc_paths`, or use
  "Update branch". Any other commit (code, other files) makes the tool refuse to run until the
  branch is renamed or deleted.
- Your changes win while the PR is open. A doc you delete stays deleted, a doc you restore stays,
  and links follow a rename. The PR body lists these under "Reviewer changes on this branch",
  with how to undo each.
- To reject a new doc, delete it and revert the index doc's link to it in the same commit. The tool
  will not create it again while the PR stays open.
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
