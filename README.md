# ai-tools

AI workflows for GitHub pull requests and repositories, shipped as reusable workflows.

| Tool | Workflow | What it does |
| --- | --- | --- |
| [ai-review](tools/ai-review) | `.github/workflows/ai-review.yml` | Two models review a PR on `/ai-review`, a third merges their findings. |
| [ai-docs-sync](tools/ai-docs-sync) | `.github/workflows/ai-docs-sync.yml` | Keeps a repo's docs in step with its code through a rolling PR. |

Every tool runs on Node 22 with no npm dependencies and no build step.
