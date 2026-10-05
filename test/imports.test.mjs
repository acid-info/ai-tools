import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `node --check` resolves no imports, so a bad path or a missing export would otherwise only fail
// inside a consumer's Actions run.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []
  );
}

const files = ['core', 'tools'].flatMap((d) => {
  try {
    return walk(join(ROOT, d));
  } catch {
    return [];
  }
});
// Entry points run on import and test files register tests, so only their import statements are checked.
const importOnly = (f) => readFileSync(f, 'utf8').startsWith('#!') || f.endsWith('.test.mjs');

for (const file of files) {
  test(`imports resolve: ${relative(ROOT, file)}`, async () => {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^import \{([^}]*)\} from '(\.[^']+)';$/gm)) {
      const mod = await import(pathToFileURL(resolve(dirname(file), m[2])).href);
      for (const name of m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean))
        assert.ok(name in mod, `${m[2]} does not export ${name}`);
    }
    if (!importOnly(file)) await import(pathToFileURL(file).href);
  });
}
