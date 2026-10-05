# Agent guidelines

- No npm dependencies and no build step. Node 22 built-ins only.
- Tools import shared code as `#core/<module>.mjs` and never import from another tool.
- Move code into `core/` only when a second tool needs it.
- `main.mjs` is the only file in a tool that reads `process.env`. Modules in `src/` take git,
  fetch and the filesystem as arguments, except where the tool README says otherwise.
- Every change runs `npm run check && npm test`. New behaviour comes with a test in the tool's
  `test/` or in `core/test/`.
- Text the tools post on GitHub (review bodies, PR bodies, commit messages, markers) and their
  stored state (cursor refs, status contexts, config file names) are consumer contracts: change
  them on purpose, never as a side effect of a refactor.
- Releases are per tool (`<tool>/v1`); see README.md.
