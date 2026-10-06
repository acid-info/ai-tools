# ai-docs-sync agent guide

Internals of ai-docs-sync. Repo-wide rules are in the [root AGENTS.md](../../AGENTS.md); the
consumer guide is [README.md](README.md).

> **Only `TRIAGE_ONLY=1` writes nothing.** Every other run writes to the real consumer repo as
> soon as it reaches a decision: `DRY_RUN=1`, and even a run that exits at the loop guard, moves
> the cursor ref; a plain run force-pushes the rolling branch and opens or updates the PR. See
> [Running locally](#running-locally).

## Code layout

| Path | Role |
| --- | --- |
| `main.mjs` | Reads the env, loads config, runs the stages in order. The only file that reads `process.env`. |
| `src/runtime.mjs` | Every side effect: git, the checkout on disk, GitHub, the model APIs. |
| `src/stages/` | The pipeline, one module per step (below). |
| `src/config.mjs` | `DEFAULTS`, `REPO_OVERRIDABLE`, `DENYLIST`, the contract constants and `.github/docs-sync.yml` parsing. |
| `src/allowlist.mjs` | Which paths are editable docs; rolling branch name validation. |
| `src/git.mjs`, `src/range.mjs` | Git log and diff parsing, range selection, diff packing. |
| `src/narrative.mjs` | PR lookup and the change narrative fed to the models. |
| `src/carry.mjs` | Carrying rolling-branch edits forward, and reviewer decisions. |
| `src/manifest.mjs`, `src/links.mjs` | The doc manifest and relative-link handling. |
| `src/plan.mjs` | Delete, create and link-fix planning after triage. |
| `src/triage.mjs`, `src/writer.mjs`, `src/checker.mjs` | Each model stage's prompt, input builder and output parser. |
| `src/gates.mjs`, `src/linediff.mjs` | The mechanical gates and the line diff they use. |
| `src/publish.mjs`, `src/pr-body.mjs` | Commit message, PR marker and PR body. |

Every module in `src/` except `runtime.mjs` and `stages/` is pure: no `process.env`, no network,
no side effects at import time.

`main.mjs` builds one context from the env, config and runtime, then runs the stages in order.
Each stage reads what it needs from the context and returns what later stages use; returning
`{ done: true }` ends the run. `main.mjs` also deletes the token and API keys from `process.env`
at startup, so child processes never inherit them.

## Pipeline

1. **pick-range**: the range runs from the cursor ref to `HEAD`; `SINCE` overrides it, and with no
   cursor yet it falls back to `PUSH_BEFORE`, then `HEAD~1`. Capped at the newest 250 commits on
   the target's first-parent line.
2. **read-changes**: changed files, ignores, and the change narrative: each commit's title and
   body, plus the title and body of any PR it came from, within `narrative_max_tokens`. A push
   that touches only docs (including merging the rolling PR) stops here, before any paid call.
3. **carry-forward**: validates the rolling branch and carries its open edits, deletes and
   reviewer decisions into this run (see [Rolling branch](#rolling-branch)).
4. **read-docs**: the manifest of editable docs and the guideline files.
5. **triage-docs**: the triage model picks docs to update, create or delete.
6. **write-docs**: the writer model rewrites or creates each doc, up to `writer_concurrency` at a
   time. A second wave links new docs from an index.
7. **check-docs**: the checker model reviews every rewrite, create and delete. It can demand at
   most one correction pass of a rewrite, or drop a create or delete.
8. **gate-docs**: the mechanical gates.
9. **report**: logs the result, and ends the run (moving the cursor) when nothing survived.
10. **publish**: renders the commit message, PR title and PR body, pushes the rolling branch,
    opens or updates the PR, sets the commit status and moves the cursor.

Every affected doc is written; there is no per-run cap.

### Creates

A new doc is created when the change adds a user- or developer-facing surface (an app, package,
service, CLI command, config area, API, workflow or integration) that no doc covers and that
would not fit in an existing one.

- **Placement**, checked before any writer call: the path must sit in a directory that already
  holds an editable doc, one new directory level under such a directory, or beside a sibling
  directory's doc of the same name (`packages/new/README.md` next to `packages/old/README.md`).
  The repo root does not count as a parent or sibling, so a new top-level directory is always
  refused.
- **Exemplar** for structure and tone: the same-named doc in a sibling directory, else the
  median-sized doc in the same directory, else one in the parent.
- **Size**: a create larger than 3x its exemplar is held back when the exemplar is over 400 bytes.
- **Index link**: the second writer wave links the new doc from the `README.md` or `index.md` in
  its directory or the parent, else the shortest-path doc that already links into that directory,
  its parent or a sibling directory. If a create is held back, so is its index update.
- The checker drops a create that duplicates an existing doc's scope or that the diff does not
  justify.

### Deletes

Triage nominates a delete only when a doc's whole subject is gone from the code, citing the diff
files that removed it. A delete whose cited files are not in the diff is listed as a suggested
deletion and not acted on: narrative text alone never deletes a doc. The checker confirms or
drops every delete. Editable docs that link to a deleted doc get their links removed or
retargeted in the same run; links from docs the tool may not edit are listed under the delete.

### Gates

Run on every change: the path allowlist, resolution of added links against the post-edit tree,
dash and attribution scans, size sanity, a banner for guideline-file edits and deletes, and
prettier when `format_check: strict`. Results go to the `docs-sync/gates` commit status, since a
PR pushed with `GITHUB_TOKEN` runs no CI.

### Failures and retries

Every GitHub and model call has a timeout and is retried once, with backoff, on a 5xx, 429 or
529. A second failure fails the run and leaves the cursor, so the next push picks the range up
again. Two exceptions:

- A checker failure leaves the edits unchecked.
- A writer failure holds back only that doc, unless no writer call succeeded and at least one
  failure was an outage (5xx, 429, 529, network error) rather than about the request (a 400, a
  timeout). Then the run fails.

## Rolling branch

- Always **the target head plus one commit** by `github-actions[bot]` holding every open edit.
  The commit is built with git plumbing in a throwaway index, so the working tree never changes,
  and pushed with `--force-with-lease` pinned to the branch state the tool inspected.
- **Ownership.** Besides the tool's commits, the branch may hold merges and other people's
  commits that only add, edit, delete or rename editable docs (a rename counts only when both
  paths are editable). Anything else, or a branch the tool never committed to, makes the run
  refuse before any paid call.
- **Carry-forward.** While a PR from the rolling branch into the target is open, its edits and
  deletes carry into the next run. If the target has since changed a carried file, the change is
  discarded and the file goes back to triage with the earlier code changes it documented; triage
  may select it again and redo it on the target's new version. If the target deleted the file,
  the carried change is dropped. A new nomination beats a carried one: an update of a carried
  delete restores the doc, a delete of a carried edit replaces the edit. After the PR is merged
  or closed nothing carries.
- **Reviewer decisions.** A reviewer's change on the branch beats the tool's while the PR stays
  open: a deleted doc stays deleted, a renamed doc keeps its new path (links retargeted), a
  deleted new doc is not created again, a restored doc is not deleted again. If the target later
  changes a doc a reviewer deleted, the delete is discarded and reported. Because every run
  rebuilds the branch and drops reviewers' commits, decisions are recorded in a
  `Reviewer decisions:` section of the tool's commit message and read back next run, rechecked
  against the branch. Forging those lines is harmless: a decision can only stop a write, never
  cause one, and each is checked against the allowlist and the branch tree before use.

## PR body

Order: deleted docs, reviewer changes, new docs, edited docs, each with the triage reason, the
checker's verdict and issues, and whether a correction pass addressed them. Then carried and
discarded changes, held-back files and their gate, new links and raw HTML, suggested deletions,
the commits and PRs in the range, and API cost. A guideline-file edit or delete is bannered at
the top with its diff, capped at 8,000 characters.

- Everything model- or narrative-derived is defused: no live `@mentions`, no closing keywords,
  no raw HTML.
- Capped at `PR_BODY_MAX` (60,000 characters). Over it, detail is shed in steps: narrative,
  checker notes, flags, per-file detail, then non-deleted file lines. Deleted paths and reviewer
  changes are never cut.
- A hidden `<!-- ai-docs-sync {...} -->` marker keeps up to `MARKER_RUNS` (20) runs within
  `MARKER_MAX_CHARS` (20,000), oldest dropped first. It is informational only and never drives
  control flow; the rolling PR is located by head and base.

## Cursor

`CURSOR_REF` (`refs/ai-docs-sync/cursor`) moves to `HEAD` whenever a run reaches a decision: a
docs-only push, no code files left after ignores, nothing affected, nothing surviving the gates,
a dry run, a published PR. A failed run leaves it. `TRIAGE_ONLY` never moves it.

## Security invariants

- Writes and deletes are limited to `.md` files in `doc_paths` minus `never_touch` minus
  `DENYLIST`, checked on the canonicalised path (no `..`, no absolute path, no symlink component)
  after every model call.
- The diff, commit messages and PR bodies are data and only ever go in user turns.
- The writer loads the target branch's guidelines, never a draft from the same run.
- No write credential is persisted in the checkout. Only the push and cursor-update child
  processes get the token, via env, from a throwaway git dir that borrows the checkout's objects,
  so no hook or config written into `.git` runs next to it. `setup_command` is not sandboxed.
- The force-push target is validated: never the target or default branch, safe charset only.

## Changing a model

Edit `DEFAULTS` in `src/config.mjs`, then check two places in `core/models.mjs`, which every tool
shares:

1. **`PRICES`**: add the new model, or the cost line reports it as unpriced and leaves it out of
   the total.
2. **`EFFORT_MODELS`** / **`REASONING_MODELS`**: regexes gating Anthropic `output_config.effort`
   and OpenAI `reasoning.effort`. A model that does not match silently loses its effort config
   rather than erroring.

Then update the models named in the README's Secrets section.

## Running locally

`cd` into a full clone of the consumer repo, fetched and checked out at its target branch, so the
config and the rolling branch's remote-tracking ref are current:

```bash
git fetch origin && git checkout --detach origin/develop
```

```bash
GITHUB_TOKEN=$(gh auth token) REPO=owner/name TARGET_BRANCH=develop SINCE=<sha> \
  ANTHROPIC_API_KEY=sk-ant-junk OPENAI_API_KEY=sk-junk TRIAGE_ONLY=1 node /path/to/ai-tools/tools/ai-docs-sync/main.mjs
```

| Env | Effect |
| --- | --- |
| `SINCE` | Start of the range; must be an ancestor of the target head. Skips the cursor read. |
| `TRIAGE_ONLY=1` | Stops after triage and never writes. With junk API keys every free step runs (range, changed files, narrative, packed diff, carry-forward, manifest, guidelines) and the run dies at a 401 having spent nothing. |
| `DRY_RUN=1` | Runs the model calls and gates (paid), prints the branch, diffs, PR title and body, and moves the cursor. Pushes no branch, touches no PR. |
| `DEBUG=1` | Logs every model's raw output and stack traces to stderr. |
| `PUSH_BEFORE`, `PUSH_FORCED` | From the push event; used only when there is no cursor ref. |
| `RUN_URL` | Linked from the PR body, the commit message and the commit status. |

`GITHUB_TOKEN` is needed even for `TRIAGE_ONLY`: the cursor ref, the default branch, the open
rolling PR and the commit-to-PR lookups are all API reads. `workflow_call` cannot be dispatched
directly, so workflow changes have to be proved on a real push in a consumer repo.

## Testing

Each pure module has a suite in `test/`. `test/helpers.mjs` provides `CFG_TEXT` and `cfg()` (a
representative consumer config) and `tmpRepo(files)`, which writes a throwaway tree to a temp
directory.

## Consumer contracts

Changing any of these changes behaviour in every consumer repo:

- `.github/docs-sync.yml` and its `REPO_OVERRIDABLE` keys, with their defaults (`branch`
  `docs/repo/sync`, `label` `docs-sync`).
- `CURSOR_REF` and `STATUS_CONTEXT` (`docs-sync/gates`).
- The `Reviewer decisions:` section of the commit message, which the next run parses.
- The commit identity (`BOT_NAME`, `BOT_EMAIL` in `src/git.mjs`): the ownership check knows the
  tool's own commits by a bot address, so a change can make every existing rolling branch refuse.
- The `<!-- ai-docs-sync {...} -->` marker shape: the next run reads it back for run history.
- The workflow inputs (`target_branch`, `since`, `dry_run`) and secret names.
