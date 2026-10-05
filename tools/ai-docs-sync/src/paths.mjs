export const BUILT_IN_IGNORE = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.map',
  '**/dist/**',
  '**/vendor/**',
  '**/__snapshots__/**',
  '**/*.generated.*',
];

export function globToRegex(glob) {
  // placeholders keep the single-star pass from mangling the double-star expansions
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*') +
      '$'
  );
}

export const makeMatcher = (globs) => {
  const res = globs.map(globToRegex);
  return (p) => res.some((re) => re.test(p));
};

// Returns the canonical relative path or null. Rejects rather than normalises `.` and `..`: a
// model that emits either is not naming a file it read from the manifest.
export function canonicalise(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p.startsWith('/')) return null;
  const segs = p.split('/').filter((s) => s !== '');
  if (!segs.length) return null;
  if (segs.some((s) => s === '.' || s === '..')) return null;
  if (p.endsWith('/')) return null;
  return segs.join('/');
}
