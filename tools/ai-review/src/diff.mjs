const approxTokens = (s) => Math.ceil(s.length / 4);

// New-file line numbers a review comment can anchor to (context + added lines).
export function patchRightLines(patch) {
  const lines = new Set();
  let n = 0;
  for (const l of patch.split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    lines.add(n++);
  }
  return lines;
}

// GitHub caps the files listing (3,000 files), so `changedFiles` (the PR's own count) is what
// reveals a silently truncated listing.
export function packFiles(files, { changedFiles, isIgnored, budget }) {
  const unlisted = Math.max(0, (changedFiles ?? files.length) - files.length);
  const considered = files.filter((f) => !isIgnored(f.filename));
  const skipped = files.length - considered.length;
  // GitHub omits `patch` for very large textual diffs; those files cannot be
  // reviewed, so they must be surfaced as a partial review, not dropped.
  const noPatch = considered.filter((f) => !f.patch).map((f) => f.filename);
  const kept = considered.filter((f) => f.patch);

  // Pack smallest-first: deterministic and fits the most files into the budget.
  kept.sort((x, y) => x.patch.length - y.patch.length || x.filename.localeCompare(y.filename));
  let left = budget;
  const chunks = [];
  const included = [];
  const validLines = new Map();
  let omitted = 0;
  for (const f of kept) {
    const chunk = `--- FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${f.patch}\n`;
    const cost = approxTokens(chunk);
    if (cost > left) {
      omitted++;
      continue;
    }
    left -= cost;
    chunks.push(chunk);
    included.push(f.filename);
    validLines.set(f.filename, patchRightLines(f.patch));
  }
  return {
    diff: chunks.join('\n'),
    files: included,
    fileCount: included.length,
    skipped,
    noPatch,
    omitted,
    unlisted,
    validLines,
  };
}

// The PR and every changed file from the listing API.
export async function fetchPrFiles(gh, repo, prNumber) {
  const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return { pr, files };
}
