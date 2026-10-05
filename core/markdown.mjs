const CLOSING = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const REF_AFTER_CLOSING = new RegExp(`${CLOSING}(:?\\s+|:)((?:[\\w.-]+/[\\w.-]+)?#)(?=\\d)`, 'gi');
const URL_AFTER_CLOSING = new RegExp(`${CLOSING}(?=:?\\s+https?://)`, 'gi');

// Zero-width spaces break @mentions and every closing-keyword form (#N, owner/repo#N, issue URL)
// without changing what a reader sees.
export const defuseRefs = (s) =>
  String(s ?? '')
    .replace(/@(?=[A-Za-z\d_/-])/g, '@​')
    .replace(REF_AFTER_CLOSING, '$1$2$3​')
    .replace(URL_AFTER_CLOSING, '$1​');

const squash = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

// Anything model- or narrative-derived that reaches GitHub text: no live @mentions, no closing
// keywords that would close an issue when the docs PR merges, no raw HTML (a stray `<!--` would
// hide the rest of the body), bounded length.
export function defuse(s, max = 300) {
  return defuseRefs(squash(s, max)).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const longestRun = (s, ch) => Math.max(0, ...[...String(s).matchAll(new RegExp(`\\${ch}+`, 'g'))].map((m) => m[0].length));

export function inlineCode(s, max = 300) {
  const t = defuseRefs(squash(s, max));
  const ticks = '`'.repeat(longestRun(t, '`') + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${t}${pad}${ticks}`;
}

// A fenced block that no line of `text` can close.
export function codeBlock(text, lang = '') {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${lang}\n${defuseRefs(text).replace(/\n$/, '')}\n${fence}`;
}

