import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { API } from '#core/api.mjs';

import { extractRelativeLinks, resolveLink } from '../src/links.mjs';
import { buildManifest, renderManifest } from '../src/manifest.mjs';

describe('manifest', () => {
  test('extracts relative links only', () => {
    const md = '[a](../api/architecture.md#flow) ![i](./img/x.png) [u](https://x.y/z) [m](mailto:a@b) [h](#top) [t](<docs/spaced file.md> "title")';
    assert.deepEqual(extractRelativeLinks(md), ['../api/architecture.md', './img/x.png', 'docs/spaced file.md']);
  });
  test('resolves links relative to the file, from the repo root for a leading slash, decoded', () => {
    assert.equal(resolveLink('docs/api/a.md', '../b.md'), 'docs/b.md');
    assert.equal(resolveLink('docs/api/a.md', '/docs/setup.md'), 'docs/setup.md');
    assert.equal(resolveLink('README.md', 'my%20file.md'), 'my file.md');
    assert.equal(resolveLink('README.md', '100%.md'), '100%.md');
    assert.equal(resolveLink('docs/a.md', '../../x.md'), null);
    assert.equal(resolveLink('README.md', '/'), '.');
  });

  test('builds and renders entries with heading, size and link directories', () => {
    const m = buildManifest([
      { path: 'docs/api/architecture.md', content: '# API architecture\n\nSee [crm](../civi-crm/architecture.md) and [root](../../README.md).\n' },
      { path: 'README.md', content: 'no heading\n' },
    ]);
    assert.equal(m[0].path, 'README.md');
    assert.equal(m[1].heading, 'API architecture');
    assert.deepEqual(m[1].linkDirs, ['/', 'docs/civi-crm/']);
    assert.match(renderManifest(m), /- docs\/api\/architecture\.md \(\d+ bytes\) "API architecture" links: \/ docs\/civi-crm\//);
  });
});
