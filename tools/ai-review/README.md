# ai-review

Shared AI pull-request reviewer for `logos-co`, `status-im` and `acid-info`. Two models review
the same diff independently, a third merges their findings, and the result is posted as a single
PR review with inline comments.

Consumers call this repo as a **reusable workflow** pinned to `@v1`. Upgrading the tool or
swapping a model is one edit here, not three edits across three repos.

## How it works

1. Someone comments `/ai-review` on a pull request.
2. The job checks out the **caller's default branch** -- never the PR head -- for config and
   guideline files, and checks out this repo for `review.mjs`.
3. The PR diff is fetched over the GitHub API by number. Lockfiles and generated paths are
   filtered out, and the rest is packed smallest-first into a token budget.
4. Claude and Codex each review the diff. A cheap synthesis model deduplicates, marks issues both
   models found, drops nits and sorts by severity.
5. Findings at or above the severity threshold are posted, anchored to diff lines where possible.

If one provider is down the review degrades to a single model rather than failing. If synthesis
fails it falls back to a local merge. Partial reviews say so in the posted body.

`review.mjs` has **zero npm dependencies** and runs on Node 22's global `fetch`. Keep it that
way -- no build step, no `package.json`. That property is what makes this repo cheap to maintain.

## Adding it to a repo

Create `.github/workflows/ai-review.yml` on your **default branch**:

```yaml
# AI PR review. The reviewer lives in acid-info/ai-review -- edit it there.
# Trigger: comment "/ai-review" on any PR. This file must be on the default branch.
name: AI PR Review

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: acid-info/ai-review/.github/workflows/ai-review.yml@v1
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

**`issue_comment` workflows only run from the default branch.** You cannot test this from a PR
branch: merge the file first, then comment `/ai-review` on a PR. Merging early is inert -- the
workflow does nothing until someone types the command.

Pass the two secrets explicitly. Do **not** use `secrets: inherit`: the reviewer has no business
seeing an `NPM_TOKEN` or a database URL.

### Secrets

| Secret | Required |
| --- | --- |
| `ANTHROPIC_API_KEY` | At least one of the two |
| `OPENAI_API_KEY` | At least one of the two |

With only one key set, the run is a single-model review and says so in the posted comment. With
neither, it exits with `Missing required env var(s)`.

`GITHUB_TOKEN` is supplied by Actions. The caller's `permissions:` block bounds the job -- a
reusable workflow cannot escalate beyond what the caller granted.

### Who can trigger it

Only comments whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. A drive-by
comment on a public repo cannot spend your API budget.

## Per-repo configuration

Optional, at `.github/ai-review.yml` on the caller's default branch. **Three keys only:**

| Key | Effect |
| --- | --- |
| `extra_ignore` | Appended to the built-in ignore list. **Use this one.** |
| `ignore` | Replaces the built-in ignore list wholesale. Escape hatch. |
| `guidelines_files` | Priority list of guideline files; the first that exists wins. |

```yaml
# Generated artifacts specific to this repo, added to the shared defaults.
extra_ignore:
  - 'flake.lock'
  - 'packages/types/src/payload.ts'

guidelines_files:
  - AGENTS.md
  - CLAUDE.md
```

Models, `min_severity_to_post` and `max_diff_tokens` are **owned centrally** in `DEFAULTS` in
`review.mjs`. Setting one in a repo config logs a warning and is ignored -- a repo that could
pin its own model would put the tool back in three places.

Built-in ignores cover lockfiles, `*.min.js`, `*.map`, `dist/`, `vendor/`, `__snapshots__/` and
`*.generated.*`.

`AGENTS.md` is special-cased in `guidelines_files`: the root file plus any `AGENTS.md` in a
directory the diff touches are all loaded, so a monorepo package can carry its own instructions.

Set `SKIP_GUIDELINES=1` to review without any guideline files.

## Changing a model

Edit `DEFAULTS` in `review.mjs`, then check **two** other places in the same file:

1. **`PRICES`** -- add the new model, or the cost line reports it as unpriced and excludes it
   from the total.
2. **`EFFORT_MODELS`** -- a model-family regex gating `output_config.effort`. A model string that
   does not match **silently loses the effort config** rather than erroring. Newer Claude models
   need it; Haiku 4.5, Sonnet 4.5 and older reject it.

Then tag: `git tag -f v1 && git push -f origin v1`. All three consumers pick it up on their next
run -- no consumer edit.

## Running it locally

`DRY_RUN=1` prints the review that would be posted instead of posting it. It suppresses only the
posting: **both reviewers still run and make real, paid API calls.**

```bash
DRY_RUN=1 REPO=logos-co/logos-web PR_NUMBER=153 \
  ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... \
  GITHUB_TOKEN=$(gh auth token) node review.mjs
```

To check config handling for free, run with a junk key. `loadConfig()` and the diff fetch both
run before the first API call, so the config warnings and the `Reviewing N files ...` line print,
then the run dies at a 401 without spending anything:

```bash
ANTHROPIC_API_KEY=not-a-key REPO=logos-co/logos-web PR_NUMBER=153 \
  GITHUB_TOKEN=$(gh auth token) node review.mjs
```

The reusable workflow itself has no runnable form without a caller -- `workflow_call` cannot be
dispatched directly. End-to-end changes have to be proved on a real PR in a consumer repo.

## Security model

- The job checks out the **caller's default branch**, never the PR head. Config, guideline files
  and the reviewer program are all trusted code.
- The PR diff arrives over the GitHub API by number, as data. PR-authored code and config never
  execute in the job.
- Model output derives from untrusted diff content, so `@mentions` are defused with a zero-width
  space before posting -- a crafted diff cannot make the bot ping arbitrary users or teams.
- Inline comments are anchored only to lines that exist on the right side of a reviewed hunk;
  GitHub rejects an entire review if any anchor is out of range.

**Whoever can push the `v1` tag executes code in every consumer repo, with that repo's
`GITHUB_TOKEN` and API keys.** Restrict who can push tags here.

## Findings marker

Each posted review ends with a hidden HTML comment carrying the findings as JSON:

```
<!-- ai-review:findings {"v":1,"pr":153,"issues":[...]} -->
```

## License

MIT.
