import { API } from './api.mjs';
import { fetchRetry } from './http.mjs';

// REST client for one token. `body` goes out as JSON; with `allow404` a 404 returns null.
export function createGitHub({ token, fetch: f = fetch, timeoutMs = 60_000, onRetry = () => {} }) {
  async function request(path, { allow404 = false, method = 'GET', body } = {}) {
    const res = await fetchRetry(
      f,
      `${API.github.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: API.github.accept,
          'X-GitHub-Api-Version': API.github.version,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { timeoutMs, onRetry: (m) => onRetry(`GitHub ${method} ${path}: ${m}`) }
    );
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(new Error(`GitHub ${method} ${path} -> ${res.status}: ${text}`), { status: res.status, text });
    }
    return res.status === 204 ? null : res.json();
  }

  async function paginate(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  return { request, paginate };
}
