# ai-review

AI pull-request reviewer for `logos-co`, `status-im` and `acid-info`. Comment `/ai-review` on a
pull request: Claude and Codex review the diff independently, a third model merges their
findings, and the result is posted as one PR review with inline comments.

## Adding it to a repo

Create `.github/workflows/ai-review.yml` on your **default branch**:

```yaml
# AI PR review. The reviewer lives in acid-info/ai-tools (tools/ai-review); edit it there.
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
    uses: acid-info/ai-tools/.github/workflows/ai-review.yml@ai-review/v1
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

- **`issue_comment` workflows only run from the default branch**, so you cannot test this from a
  PR branch. Merge the file first, then comment `/ai-review` on a PR. Merging it early is safe:
  nothing runs until someone types the command.
- Only comments from an `OWNER`, `MEMBER` or `COLLABORATOR` trigger a review, so a drive-by
  comment on a public repo cannot spend your API budget.
- Pass the secrets explicitly. Do **not** use `secrets: inherit`: the reviewer has no business
  seeing an `NPM_TOKEN` or a database URL.
- `ai-review/v1` is a moving tag. Pin a commit SHA instead for immutability.

### Secrets

| Secret | Required |
| --- | --- |
| `ANTHROPIC_API_KEY` | At least one of the two |
| `OPENAI_API_KEY` | At least one of the two |

With only one key set, the run is a single-model review and the posted comment says so.
`GITHUB_TOKEN` comes from Actions, bounded by your `permissions:` block.

## Configuration

Optional, at `.github/ai-review.yml` on your default branch. Three keys:

| Key | Effect |
| --- | --- |
| `extra_ignore` | Appended to the built-in ignore list. **Use this one.** |
| `ignore` | Replaces the built-in ignore list wholesale. |
| `guidelines_files` | Priority list of guideline files; the first that exists is loaded. |

```yaml
extra_ignore:
  - 'flake.lock'
  - 'packages/types/src/payload.ts'

guidelines_files:
  - AGENTS.md
  - CLAUDE.md
```

The built-in ignores cover lockfiles, `*.min.js`, `*.map`, `dist/`, `vendor/`, `__snapshots__/`
and `*.generated.*`. With `AGENTS.md` listed, the root file plus any `AGENTS.md` in a directory
the diff touches are all loaded, so a monorepo package can carry its own instructions.

Models and the severity threshold are set centrally, for every consumer. Setting them in your
config logs a warning and does nothing.

## What gets posted

- Issues of `major` severity and above, inline where they map to a diff line, with a summary.
- An **API usage** table: tokens and estimated cost per model call, plus the total.
- A note whenever the review is partial: a provider was down, synthesis failed, or files were too
  large to review.

## Security

- The job checks out your default branch, never the PR head. The diff arrives over the API as
  data, so PR-authored code and config never run.
- `@mentions` in model output are defused, so a crafted diff cannot make the bot ping anyone.
- Whoever can push the `ai-review/v1` tag runs code in your repo with its `GITHUB_TOKEN` and API
  keys. See [Security model](../../README.md#security-model) for who that is.

## Contributing

Code layout, model changes and local runs are in [AGENTS.md](AGENTS.md).

## License

MIT.
