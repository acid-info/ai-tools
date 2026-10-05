import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGitHub } from '../github.mjs';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });

test('requests send the token and JSON, and a 404 is null only when allowed', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return url.endsWith('/missing') ? json(404, { message: 'Not Found' }) : json(200, { ok: 1 });
  };
  const { request } = createGitHub({ token: 't', fetch });
  assert.deepEqual(await request('/x', { method: 'POST', body: { a: 1 } }), { ok: 1 });
  assert.equal(seen[0].init.headers.Authorization, 'Bearer t');
  assert.equal(seen[0].init.body, '{"a":1}');
  assert.equal(await request('/missing', { allow404: true }), null);
  await assert.rejects(request('/missing'), (e) => e.status === 404 && /GET \/missing -> 404/.test(e.message));
});

test('pagination follows full pages and stops at a short one', async () => {
  const fetch = async (url) => json(200, Array.from({ length: /[?&]page=1$/.test(url) ? 100 : 3 }, (_, i) => i));
  const { paginate } = createGitHub({ token: 't', fetch });
  assert.equal((await paginate('/repos/o/r/pulls/1/files')).length, 103);
});
