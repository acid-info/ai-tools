const API = {
  baseUrl: 'https://api.github.com',
  version: '2026-03-10',
  accept: 'application/vnd.github+json',
};

export function createGitHub(token) {
  return async function gh(path, opts = {}) {
    const res = await fetch(`${API.baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: API.accept,
        'X-GitHub-Api-Version': API.version,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}
