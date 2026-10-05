import { posix as path } from 'node:path';

const LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

// Relative link targets in a Markdown file, without fragment or query.
export function extractRelativeLinks(md) {
  const out = [];
  for (const m of md.matchAll(LINK_RE)) {
    const target = m[1] ?? m[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (clean) out.push(clean);
  }
  return out;
}

// Repo-relative path a link in `fromFile` points at, or null when it leaves the repo. A leading
// `/` is the repo root, as GitHub renders it.
export function resolveLink(fromFile, link) {
  let target = link;
  try {
    target = decodeURIComponent(link);
  } catch {
    // a literal `%` that is not an escape
  }
  const dir = path.dirname(fromFile);
  const resolved = path.normalize(target.startsWith('/') ? target.slice(1) || '.' : path.join(dir === '.' ? '' : dir, target));
  return resolved === '..' || resolved.startsWith('../') ? null : resolved;
}

// `files` is every `.md` of the post-edit tree, not only editable ones.
export function inboundLinks(files, deleted) {
  const gone = new Set(deleted);
  const out = new Map(deleted.map((p) => [p, []]));
  for (const { path: from, content } of files) {
    if (gone.has(from) || content == null) continue;
    const lines = content.split('\n');
    const inFence = fencedLines(lines);
    const hits = new Set();
    lines.forEach((line, i) => {
      if (inFence.has(i)) return;
      for (const l of extractRelativeLinks(line)) {
        const target = resolveLink(from, l);
        if (gone.has(target)) hits.add(target);
      }
    });
    for (const t of hits) out.get(t).push(from);
  }
  return out;
}

// Indexes of lines inside fenced code blocks, fence lines included.
export function fencedLines(lines) {
  const out = new Set();
  let fence = null;
  lines.forEach((line, i) => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      out.add(i);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m.index + m[0].length).trim()) fence = null;
    } else if (m) {
      out.add(i);
      fence = m[1];
    }
  });
  return out;
}
