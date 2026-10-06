# ai-tools

AI workflows for GitHub pull requests and repositories, shipped as reusable workflows. One repo,
one shared core, one release tag per tool.

| Tool | Kind | What it does |
| --- | --- | --- |
| [ai-review](tools/ai-review) | reader | Two models review a PR on `/ai-review`, a third merges their findings. |
| [ai-docs-sync](tools/ai-docs-sync) | writer | Keeps a repo's docs in step with its code through a rolling PR. |

A **reader** only comments. A **writer** pushes commits or opens PRs, so it runs with
`contents: write` in every consumer repo.

## Using a tool

Each tool's README has the workflow file to add, the secrets it needs and its configuration. A
consumer calls the tool's reusable workflow at its release tag:

```yaml
uses: acid-info/ai-tools/.github/workflows/<tool>.yml@<tool>/v1
```

The tag moves with each release. Pin a commit SHA instead for immutability.

## Development

Node 24, no dependencies, no build step.

```bash
npm run check && npm test
```

Layout, conventions and how to add a tool are in [AGENTS.md](AGENTS.md).

## Releasing

Each tool has its own moving major tag, `<tool>/v1`, and only repo admins can move it. After a
change is merged to `master`, move the tag of each tool the change is meant for:

```bash
git checkout master && git pull && git tag -f ai-review/v1 && git push -f origin ai-review/v1
```

A change to `core/` reaches a tool only when that tool's tag moves, so each tool rolls forward,
or holds back, on its own.

## Security model

Whoever can move a tool's tag runs code in every consumer repo with that repo's `GITHUB_TOKEN`
and API keys. That is why each tool has its own tag: a shared one would let anyone trusted to
release a reader turn it into a writer everywhere.

Two repository rulesets enforce this, and repo admins can bypass both:

- **Protect master and develop**: changes land only through a pull request, and neither branch
  can be deleted.
- **Only admins push tags**: creating, moving or deleting any tag is admin-only, so only admins
  can release a tool.

In every tool, the job never runs PR-authored code, the caller's `permissions:` block bounds what
it can do, and model output is defused before it is posted. Consumers pass secrets explicitly,
never with `secrets: inherit`.

## License

[MIT](LICENSE).
