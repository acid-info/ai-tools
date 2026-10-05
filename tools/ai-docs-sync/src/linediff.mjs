// LCS line diff. Docs are a few hundred lines, so O(n*m) is fine; above the cell cap every line
// counts as changed, which only makes gate 4 fix more dashes and gate 5 flag more.
export function lineDiff(oldText, newText, { maxCells = 25_000_000 } = {}) {
  // A trailing newline is not a line.
  const toLines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = toLines(oldText);
  const b = toLines(newText);
  if (a.length * b.length > maxCells) {
    return [...a.map((line) => ({ type: 'del', line })), ...b.map((line) => ({ type: 'add', line }))];
  }
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: 'del', line: a[i++] });
    } else {
      ops.push({ type: 'add', line: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

// 0-based indexes into the new text of lines that are not in the old text.
export function addedLineIndexes(ops) {
  const out = new Set();
  let j = 0;
  for (const op of ops) {
    if (op.type === 'del') continue;
    if (op.type === 'add') out.add(j);
    j++;
  }
  return out;
}

export function unifiedDiff(oldText, newText, filePath, { context = 3 } = {}) {
  const ops = lineDiff(oldText, newText);
  if (!ops.some((o) => o.type !== 'eq')) return '';
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  // Group changes into hunks with `context` equal lines around them.
  let oldNo = 1;
  let newNo = 1;
  const positioned = ops.map((op) => {
    const p = { ...op, oldNo, newNo };
    if (op.type !== 'add') oldNo++;
    if (op.type !== 'del') newNo++;
    return p;
  });
  let idx = 0;
  while (idx < positioned.length) {
    if (positioned[idx].type === 'eq') {
      idx++;
      continue;
    }
    let start = Math.max(0, idx - context);
    let end = idx;
    while (end < positioned.length) {
      if (positioned[end].type !== 'eq') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < positioned.length && positioned[end + run].type === 'eq') run++;
      if (end + run >= positioned.length || run > context * 2) {
        end += Math.min(run, context);
        break;
      }
      end += run;
    }
    const hunk = positioned.slice(start, end);
    const oldCount = hunk.filter((h) => h.type !== 'add').length;
    const newCount = hunk.filter((h) => h.type !== 'del').length;
    const oldStart = oldCount ? hunk.find((h) => h.type !== 'add').oldNo : positioned[start].oldNo - 1;
    const newStart = newCount ? hunk.find((h) => h.type !== 'del').newNo : positioned[start].newNo - 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const h of hunk) lines.push((h.type === 'eq' ? ' ' : h.type === 'add' ? '+' : '-') + h.line);
    idx = end;
  }
  return lines.join('\n') + '\n';
}

