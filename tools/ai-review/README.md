# ai-review

AI pull-request reviewer for `logos-co`, `status-im` and `acid-info`. Comment `/ai-review` on a
pull request: two models review the diff independently, a third merges their findings, and the
result is posted as one PR review with inline comments.

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

- GitHub runs `issue_comment` workflows only from the default branch, so you cannot test this
  from a PR branch. Merge the file first, then comment `/ai-review` on a PR. Merging it early is
  safe: nothing runs until someone types the command.
- Only comments from an `OWNER`, `MEMBER` or `COLLABORATOR` trigger a review, so a drive-by
  comment on a public repo cannot spend your API budget.
- Pass the secrets explicitly instead of `secrets: inherit`: the reviewer has no business seeing
  an `NPM_TOKEN` or a database URL.
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
| `extra_ignore` | Appended to the built-in ignore list. Prefer it to `ignore`. |
| `ignore` | Replaces the built-in ignore list wholesale, so restate any default you still want. |
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

One PR review headed `## AI review (<claude model> + <openai model>)`. It opens with the merged
summary of the main risks, then the number of critical and other issues shown.

Issues of `major` severity and above are posted inline where they map to a diff line, and listed
in the body where they do not. Each one opens with its severity and category, such as
`🟠 Major (bug)`, and ends with a suggested fix when there is one. An inline comment also says
"flagged by both models" when both reviewers found the issue.

The body states every way the review fell short: lines starting `Partial review:` for files that
were not reviewed, `Single-model review:` when a reviewer failed, and a note when a reviewer's
answer could not be parsed or synthesis failed. When synthesis fails, the summary shows each
reviewer's overall assessment as its own paragraph. An `API usage` table follows, with tokens and
estimated cost per model call and the total.

When nothing is left to review after filtering, the reviewer posts a plain comment instead,
starting `AI review could not run.` with the reasons, or saying it found nothing reviewable.

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
