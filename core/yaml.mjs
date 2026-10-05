// Minimal YAML subset: `key: value`, `key: [a, b]`, `key:` followed by `- item` lines, `#`
// comments. Enough for the documented config and nothing more, so the tool stays dependency-free.
export function parseYamlSubset(text) {
  const out = {};
  let currentList = null;
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem) {
      if (currentList) out[currentList].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    const flow = val.match(/^\[(.*)\]$/);
    if (val === '') {
      out[key] = [];
      currentList = key;
    } else if (flow) {
      out[key] = flow[1].split(',').map(unquote).filter(Boolean);
      currentList = null;
    } else {
      const scalar = unquote(val);
      out[key] = /^\d+$/.test(scalar) ? Number(scalar) : scalar;
      currentList = null;
    }
  }
  return out;
}
