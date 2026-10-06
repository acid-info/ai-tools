# ai-review agent guide

Internals of ai-review. Repo-wide rules are in the [root AGENTS.md](../../AGENTS.md); the
consumer guide is [README.md](README.md).

> **Local runs spend money.** `DRY_RUN=1` suppresses only the posting: both reviewers and the
> synthesizer still make real, paid API calls. See [Running locally](#running-locally) for the
> free config check.

## Pipeline

1. `main.mjs` reads the env and loads `.github/ai-review.yml` from the working directory, which in
   Actions is the caller's default branch, never the PR head.
2. `src/diff.mjs` lists the PR files over the API, drops ignored paths and packs the rest
   smallest-first into `max_diff_tokens`. With nothing left, `renderUnreviewable` posts a plain
   comment and the run ends.
3. Guidelines load through `core/guidelines.mjs`: the first of `guidelines_files` that exists,
   except `AGENTS.md`, which loads the root file plus one in every directory above a changed file.
4. `src/review.mjs` runs both reviewers in parallel, then the synthesizer:
   - one reviewer fails: single-model review;
   - both fail: the run fails;
   - `synth_model`'s provider is down: synthesis uses the surviving reviewer's model;
   - synthesis fails or returns unusable JSON: `localMerge` instead.

   The posted body states every degraded path and every file left unreviewed.
5. `src/post.mjs` renders the review. Findings below `min_severity_to_post` are dropped. Inline
   comments anchor only to lines on the right side of a reviewed hunk, because GitHub rejects the
   whole review if any anchor is out of range. If the inline POST still fails, `main.mjs` posts
   `flatBody()` as a plain comment.
6. `main.mjs` writes `critical-issues.json` and `criticals=<n>` to `GITHUB_OUTPUT`.

## Code layout

| File | Role |
| --- | --- |
| `main.mjs` | Reads the env, fetches the PR, runs the pipeline, posts the review. The only file that writes to GitHub. |
| `src/config.mjs` | `DEFAULTS`, `REPO_OVERRIDABLE`, timeouts and `.github/ai-review.yml` parsing. |
| `src/diff.mjs` | PR file listing, ignore filtering, smallest-first packing, right-side line sets for anchoring. |
| `src/prompts.mjs` | Reviewer and synthesis prompts, and the tolerant JSON parser for their answers. |
| `src/review.mjs` | Both reviewers in parallel, synthesis and its fallbacks, severity `RANK`. |
| `src/post.mjs` | Review body, inline comments, `@mention` defusing and the findings marker. |

Model calls, retries, pricing, GitHub access and guideline loading come from `core/`.

## Configuration

`DEFAULTS` in `src/config.mjs` owns models, `synth_effort`, `min_severity_to_post`,
`max_diff_tokens` and the built-in ignore list. Only `REPO_OVERRIDABLE` keys (`ignore`,
`extra_ignore`, `guidelines_files`) are read from a consumer config; any other key logs a warning
and is ignored. `ignore` and `guidelines_files` replace the default, `extra_ignore` appends to it.

## Changing a model

Edit `DEFAULTS` in `src/config.mjs`, then check two places in `core/models.mjs`, which every tool
shares:

1. **`PRICES`**: add the new model, or the API usage table reports it as unpriced and leaves it
   out of the total. Cache reads cost a tenth of input unless `cacheRead` says otherwise.
2. **`EFFORT_MODELS`** / **`REASONING_MODELS`**: regexes gating `output_config.effort` (Claude)
   and `reasoning.effort` (OpenAI). A model that does not match **silently loses its effort
   config** rather than erroring. Haiku 4.5, Sonnet 4.5 and older Claude models reject effort, as
   do non-reasoning OpenAI models.

`synth_model` picks its provider from its name: `claude-*` goes to Anthropic, anything else to
OpenAI. Keep `synth_effort` to a level both providers accept (`low`, `medium`, `high`): when
`synth_model`'s provider is down, the same effort goes to the other provider's reviewer model.

## Running locally

Run from a checkout of the consumer repo: config and guideline files are read from the working
directory.

```bash
DRY_RUN=1 REPO=logos-co/logos-web PR_NUMBER=153 \
  ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... \
  GITHUB_TOKEN=$(gh auth token) node /path/to/ai-tools/tools/ai-review/main.mjs
```

To check config handling for free, pass a junk key. Config loading and the diff fetch run before
the first model call, so the config warnings and the `Reviewing N files ...` line print, then the
run dies at a 401 having spent nothing:

```bash
ANTHROPIC_API_KEY=not-a-key REPO=logos-co/logos-web PR_NUMBER=153 \
  GITHUB_TOKEN=$(gh auth token) node /path/to/ai-tools/tools/ai-review/main.mjs
```

| Env | Effect |
| --- | --- |
| `DRY_RUN=1` | Prints the review instead of posting it. Model calls still run. |
| `SKIP_GUIDELINES=1` | Reviews without any guideline files. |

`workflow_call` cannot be dispatched directly, so workflow changes have to be proved on a real PR
in a consumer repo.

## Testing

Each `src/` module has a suite in `test/`. `runReviewers` and `synthesize` take a `call(label,
model, opts)` function, so tests pass a fake that returns canned answers or throws to simulate an
outage. Labels are `reviewer-claude`, `reviewer-codex` and `synthesizer`.

## Consumer contracts

Changing any of these changes behaviour in every consumer repo:

- The `/ai-review` trigger and the `OWNER`, `MEMBER`, `COLLABORATOR` author guard in the workflow.
- `.github/ai-review.yml` and its three keys.
- The secret names `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- The findings marker that ends each review, read back off the PR by later tooling:

  ```
  <!-- ai-review:findings {"v":1,"pr":153,"issues":[...]} -->
  ```

  `>` inside it is escaped as a JSON unicode escape so model text cannot close the comment early.
