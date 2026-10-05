import { posix as path } from 'node:path';

import { extractRelativeLinks, resolveLink } from './links.mjs';

export function firstHeading(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : '';
}

export function buildManifest(files) {
  return files
    .map(({ path: p, content }) => {
      const dirs = new Set();
      for (const l of extractRelativeLinks(content)) {
        const resolved = resolveLink(p, l);
        if (resolved == null) continue;
        const d = path.dirname(resolved);
        dirs.add(d === '.' ? '/' : d + '/');
      }
      return { path: p, heading: firstHeading(content), bytes: Buffer.byteLength(content), linkDirs: [...dirs].sort() };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function renderManifest(manifest) {
  if (!manifest.length) return '(no editable docs found)';
  return manifest
    .map((m) => `- ${m.path} (${m.bytes} bytes)${m.heading ? ` "${m.heading}"` : ''}${m.linkDirs.length ? ` links: ${m.linkDirs.join(' ')}` : ''}`)
    .join('\n');
}

