import { canonicalise } from '#core/paths.mjs';

import { isGuidelineFile } from './guidelines.mjs';
import { addedLineIndexes, lineDiff, unifiedDiff } from './linediff.mjs';
import { extractRelativeLinks, fencedLines, resolveLink } from './links.mjs';
import { dropOrphanedDependents } from './plan.mjs';

const ATTRIBUTION_RE = /co-authored-by|generated (with|by)|🤖/i;
const VENDOR_RE = /\b(anthropic|openai|claude|chatgpt|gpt-?\d)\b/i;
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

export const normaliseContent = (s) =>
  (s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n*$/, '\n');

export function gateAllowlist(file, { isEditableDoc }) {
  const c = canonicalise(file.path);
  if (!c || c !== file.path || !isEditableDoc(c)) return { ok: false, reason: 'path outside the editable allowlist' };
  return { ok: true };
}

export function gateNonEmpty(file, { current }) {
  if (!file.content || !file.content.trim()) return { ok: false, reason: 'empty output' };
  if (current != null && normaliseContent(current) === normaliseContent(file.content)) return { ok: false, reason: 'no change' };
  return { ok: true };
}

// `existsInTree(path)` answers for the post-edit tree: files created this run plus the checkout.
// Only lines this run added are checked: a link that was already broken is not the edit's fault.
export function gateLinks(file, { existsInTree, current }) {
  const lines = file.content.split('\n');
  const inFence = fencedLines(lines);
  const broken = [];
  for (const i of addedLineIndexes(lineDiff(current ?? '', file.content))) {
    if (inFence.has(i)) continue;
    for (const l of extractRelativeLinks(lines[i])) {
      const resolved = resolveLink(file.path, l);
      if (resolved == null || !existsInTree(resolved)) broken.push(l);
    }
  }
  return broken.length ? { ok: false, reason: `broken relative link(s): ${[...new Set(broken)].join(', ')}` } : { ok: true };
}

// Measured against the target branch, not the carried draft, so drift cannot creep run by run.
// A create has no target, so it is bounded by its exemplar: `file.exemplar` is { path, bytes }.
export function gateSize(file, { target }) {
  if (file.action === 'create') {
    const ex = file.exemplar;
    if (!ex || ex.bytes <= 400) return { ok: true };
    const after = Buffer.byteLength(file.content);
    return after > ex.bytes * 3 ? { ok: false, reason: `grew ${(after / ex.bytes).toFixed(1)}x the size of ${ex.path} (${ex.bytes} -> ${after} bytes)` } : { ok: true };
  }
  if (target == null) return { ok: true };
  const before = Buffer.byteLength(target);
  if (before <= 400) return { ok: true };
  const after = Buffer.byteLength(file.content);
  if (after < before * 0.5) return { ok: false, reason: `shrank ${Math.round((1 - after / before) * 100)}% (${before} -> ${after} bytes)` };
  if (after > before * 3) return { ok: false, reason: `grew ${(after / before).toFixed(1)}x (${before} -> ${after} bytes)` };
  return { ok: true };
}

// Prose scanning for dashes. Code spans, HTML comments and tags, link targets and URLs are swapped
// for placeholders, so the dash rules never see or change them; `restore` puts them back.
const HOLE_RE = /\uE000(\d+)\uE001/g;
// A dash standing in for punctuation: an en or em dash, or a double hyphen with a space or the
// line edge on both sides. Surrounding spaces are part of the match.
const DASH_SRC = String.raw`[ \t]*[\u2013\u2014][ \t]*|[ \t]*(?<=^|[ \t])--(?=[ \t]|$)[ \t]*`;
const dashRe = () => new RegExp(DASH_SRC, 'g');
const UNSPACED_DOUBLE_RE = /(?<!-)--(?!-)/;
const SPACED_HYPHEN_RE = /(?<=[^\s|]) - (?=[^\s|])/;
// A table cell holding only a dash means "none"; it is not punctuation.
const DASH_CELL_RE = /(?<=\|)([ \t]*)([\u2013\u2014]|-{1,2})([ \t]*)(?=\|)/g;
const BOLD_BULLET_RE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+(\*\*|__)\S/;

function frontMatterEnd(lines) {
  if (lines[0]?.trimEnd() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) return i;
  return -1;
}

// One entry per line: null inside a fenced block or front matter, else { text, restore }.
export function proseLines(lines) {
  const fenced = fencedLines(lines);
  const fmEnd = frontMatterEnd(lines);
  let inComment = false;
  return lines.map((line, i) => {
    if (fenced.has(i) || i <= fmEnd) return null;
    const pieces = [];
    const hide = (s) => `\uE000${pieces.push(s) - 1}\uE001`;
    let text = line;
    if (inComment) {
      const end = text.indexOf('-->');
      if (end < 0) text = hide(text);
      else {
        text = hide(text.slice(0, end + 3)) + text.slice(end + 3);
        inComment = false;
      }
    }
    text = text.replace(/<!--[\s\S]*?-->/g, hide);
    const open = text.indexOf('<!--');
    if (open >= 0) {
      text = text.slice(0, open) + hide(text.slice(open));
      inComment = true;
    }
    text = text
      .replace(/(`+)[\s\S]*?\1/g, hide)
      .replace(/^(\s*\[[^\]]+\]:)(.*)$/, (_, def, target) => def + hide(target))
      .replace(/\]\((?:<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/g, (m) => ']' + hide(m.slice(1)))
      .replace(HTML_TAG_RE, hide)
      .replace(URL_RE, hide);
    const restore = (s) => {
      while (/\uE000\d+\uE001/.test(s)) s = s.replace(HOLE_RE, (_, n) => pieces[n]);
      return s;
    };
    return { text, restore };
  });
}

const isOnlyDashes = (s) => /^\s*(?:[\u2013\u2014]|-{1,2})\s*$/.test(s);
const blankDashCells = (text) => text.replace(DASH_CELL_RE, (_, a, d, b) => a + ' '.repeat(d.length) + b);

// The dash-like patterns on one prose line, as kinds in a fixed order.
function dashKinds(text) {
  if (isOnlyDashes(text)) return [];
  const t = blankDashCells(text);
  const kinds = [];
  if (/\u2014/.test(t)) kinds.push('em');
  if (/\u2013/.test(t)) kinds.push('en');
  const rest = t.replace(/[\u2013\u2014]/g, ' ');
  if (dashRe().test(rest)) kinds.push('spaced_double');
  if (UNSPACED_DOUBLE_RE.test(rest.replace(dashRe(), ' '))) kinds.push('unspaced_double');
  if (SPACED_HYPHEN_RE.test(rest)) kinds.push('spaced_hyphen');
  return kinds;
}

const DASH_NOTES = {
  em: 'em dash in prose; use a comma, a colon or parentheses',
  en: 'en dash in prose; use a hyphen in a number range, else a comma, a colon or parentheses',
  spaced_double: 'double hyphen used as a dash; use a comma, a colon or parentheses',
  unspaced_double: 'double hyphen outside code; put a command-line flag in backticks, else use a comma, a colon or parentheses',
  spaced_hyphen: 'spaced hyphen used as a dash; use a comma, a colon or parentheses',
};

// The code pre-check run before the checker's verdict is acted on: dashes and attribution on the
// lines this draft adds or changes, as "must" issues the correction pass has to fix.
export function mechanicalIssues(draft) {
  if (draft.action === 'delete' || draft.content == null) return [];
  const lines = draft.content.split('\n');
  const prose = proseLines(lines);
  const issues = [];
  const add = (i, note) => issues.push({ severity: 'must', note: `line ${i + 1}: ${note}`, source: 'style' });
  for (const i of [...addedLineIndexes(lineDiff(draft.current ?? '', draft.content))].sort((a, b) => a - b)) {
    if (prose[i]) for (const kind of dashKinds(prose[i].text)) add(i, DASH_NOTES[kind]);
    if (ATTRIBUTION_RE.test(lines[i])) add(i, 'attribution string; remove it');
  }
  return issues;
}


// The replacement table. Prose is fixed a paragraph at a time: consecutive lines of one
// paragraph or list item are joined with their newlines, which count as spaces, so a dash at the
// end of a wrapped line and a pair split across lines get the same rules as on one line. The
// newlines stay where they are, so the line count never changes. `eligible[i]` says whether line
// i may change; a replacement that would change any other line is skipped, along with its pair.
const RANGE_RE = new RegExp(String.raw`(\d)(?:${DASH_SRC})(?=\d)`, 'g');
const LEAD_RE = /^(\s*)(?:[\u2013\u2014]|--(?=[ \t]))[ \t]*/;
const TRAIL_RE = /[ \t]*(?:[\u2013\u2014]|(?<=^|[ \t])--)[ \t]*$/;
const PARA_DASH_SRC = String.raw`[ \t]*(?:\n[ \t]*)?(?:[\u2013\u2014]|(?<=^|\s)--(?=\s|$))[ \t]*(?:\n[ \t]*)?`;
const paraDashRe = () => new RegExp(PARA_DASH_SRC, 'g');

function fixParagraph(bodies, eligible, label) {
  // A dash that opens a line is dangling on any line; a dash that closes one is dangling only on
  // the last line of the paragraph, since otherwise a continuation line follows it.
  const b = bodies.map((t, i) => (eligible[i] && !isOnlyDashes(t) ? t.replace(RANGE_RE, '$1-').replace(LEAD_RE, '$1') : t));
  const last = b.length - 1;
  if (eligible[last]) b[last] = b[last].replace(TRAIL_RE, '');
  const text = b.join('\n');
  const lineAt = (pos) => (text.slice(0, pos).match(/\n/g) ?? []).length;
  // The output for one dash and the lines it changes, or null when it cannot be placed.
  const place = (m, rep) => {
    const region = m[0];
    const line = lineAt(m.index);
    const nl = (region.match(/\n/g) ?? []).length;
    if (!nl) return { start: m.index, end: m.index + region.length, out: rep, lines: [line] };
    if (nl > 1) return null;
    // Punctuation that closes or follows stays before the newline; an opening parenthesis moves to
    // the start of the next line.
    const [pre, post] = region.split('\n');
    const [l, r] = rep.trim() === '(' ? ['', '('] : [rep.trim(), ''];
    const lines = [...(pre !== l ? [line] : []), ...(post !== r ? [line + 1] : [])];
    return { start: m.index, end: m.index + region.length, out: `${l}\n${r}`, lines };
  };
  const ok = (p) => p && p.lines.every((i) => eligible[i]);
  const edits = [];
  const parts = text.split(/(?<=[.!?])(\s+)/);
  let offset = 0;
  for (let s = 0; s < parts.length; offset += parts[s].length + (parts[s + 1]?.length ?? 0), s += 2) {
    const sentence = parts[s];
    const ms = [...sentence.matchAll(paraDashRe())].map((m) => Object.assign([m[0]], { index: m.index + offset }));
    if (!ms.length) continue;
    if (label && s === 0 && ms.length === 1) {
      const p = place(ms[0], ': ');
      if (ok(p)) edits.push(p);
      continue;
    }
    for (let k = 0; k + 1 < ms.length; k += 2) {
      const next = text[ms[k + 1].index + ms[k + 1][0].length];
      const pair = [place(ms[k], ' ('), place(ms[k + 1], next == null || /[.,;:!?)\]]/.test(next) ? ')' : ') ')];
      if (pair.every(ok)) edits.push(...pair);
    }
    if (ms.length % 2) {
      const p = place(ms.at(-1), sentence.replace(paraDashRe(), ' ').includes(':') ? ', ' : ': ');
      if (ok(p)) edits.push(p);
    }
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.out + out.slice(e.end);
  return out.split('\n');
}

// What a line is, for grouping lines into paragraphs.
function lineShape(text) {
  const m = text.match(/^(\s*(?:>\s*)*)(#{1,6}\s+|(?:[-*+]|\d+[.)])\s+)?/);
  const prefix = m[0];
  const body = text.slice(prefix.length);
  const quote = (m[1].match(/>/g) ?? []).length;
  const trimmed = text.replace(/^[\s>]*/, '').trimEnd();
  let kind = 'text';
  if (!body.trim()) kind = 'blank';
  else if (!text.replace(HOLE_RE, '').trim()) kind = 'hidden';
  else if (/^(?:=+|-+|(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(trimmed) || isOnlyDashes(body)) kind = 'break';
  else if (body.startsWith('|')) kind = 'table';
  else if (m[2]?.startsWith('#')) kind = 'heading';
  else if (m[2]) kind = 'item';
  return { prefix, body, quote, kind };
}

const fixCells = (body) =>
  body
    .split('|')
    .map((cell, i, all) => (i === 0 || (i === all.length - 1 && !cell.trim()) ? cell : cell.replace(/^(\s*)(.*?)(\s*)$/, (_, a, c, b) => a + fixParagraph([c], [true], true)[0] + b)))
    .join('|');

// Paragraphs of masked prose: { lines: [index], label }. A paragraph ends at a blank line, a
// fence, front matter, a heading, a table row, a thematic break, the start of a list item, a link
// definition, or a line holding nothing but a comment, a code span or a link target.
function paragraphs(prose) {
  const out = [];
  let cur = null;
  prose.forEach((p, i) => {
    const shape = p && lineShape(p.text);
    if (!shape || shape.kind === 'blank' || shape.kind === 'break' || shape.kind === 'hidden' || /^\s*\[[^\]]+\]:/.test(shape.body)) {
      cur = null;
      return;
    }
    if (shape.kind === 'text' && cur?.open && cur.quote === shape.quote) {
      cur.lines.push(i);
      return;
    }
    cur = { lines: [i], quote: shape.quote, kind: shape.kind, label: shape.kind !== 'text', open: shape.kind === 'text' || shape.kind === 'item' };
    out.push(cur);
  });
  return out;
}

const countDashes = (text) => (blankDashCells(text).match(dashRe()) ?? []).length;

// Gate 4. Attribution on a line this run added or changed drops the file. En and em dashes, and
// spaced double hyphens, in the prose of those lines are replaced by the table in fixParagraph;
// this is the fallback for what the correction pass left. Unspaced "--" and a spaced hyphen are
// left for the `style` flag. `fixes` lists every changed line, 1-based; `left` lists added lines
// that still hold a dash, because it pairs with one on a line this run did not change.
export function gateStyle(file, { current }) {
  const lines = file.content.split('\n');
  const added = new Set(addedLineIndexes(lineDiff(current ?? '', file.content)));
  for (const i of [...added].sort((a, b) => a - b)) if (ATTRIBUTION_RE.test(lines[i])) return { ok: false, reason: `attribution string on line ${i + 1}` };
  const prose = proseLines(lines);
  const masked = prose.map((p) => p?.text);
  for (const para of paragraphs(prose)) {
    const eligible = para.lines.map((i) => added.has(i));
    if (!eligible.some(Boolean) || !para.lines.some((i) => countDashes(masked[i]))) continue;
    const shapes = para.lines.map((i) => lineShape(masked[i]));
    if (para.kind === 'table') {
      if (eligible[0]) masked[para.lines[0]] = shapes[0].prefix + fixCells(shapes[0].body);
      continue;
    }
    // Continuation lines keep their indentation and quote markers as part of the prefix.
    const fixed = fixParagraph(shapes.map((s) => s.body), eligible, para.label);
    para.lines.forEach((i, k) => {
      masked[i] = shapes[k].prefix + fixed[k];
    });
  }
  const fixes = [];
  const left = [];
  for (const i of [...added].sort((a, b) => a - b)) {
    const p = prose[i];
    if (!p) continue;
    const after = p.restore(masked[i]);
    if (after !== lines[i]) {
      fixes.push({ line: i + 1, before: lines[i], after, count: Math.max(0, countDashes(p.text) - countDashes(masked[i])) });
      lines[i] = after;
    }
    if (countDashes(masked[i])) left.push(i + 1);
  }
  return { ok: true, content: lines.join('\n'), fixes, left };
}

// "3 dashes replaced mechanically on lines 14, 37; check they read well", for the PR body and log.
export function describeDashFixes(fixes = [], left = []) {
  const out = [];
  if (fixes.length) {
    const n = fixes.reduce((s, f) => s + (f.count ?? 1), 0);
    const at = fixes.map((f) => f.line);
    out.push(`${n} ${n === 1 ? 'dash' : 'dashes'} replaced mechanically on ${at.length === 1 ? 'line' : 'lines'} ${at.join(', ')}; check ${n === 1 ? 'it reads' : 'they read'} well`);
  }
  if (left.length) out.push(`${left.length === 1 ? 'dash' : 'dashes'} left on ${left.length === 1 ? 'line' : 'lines'} ${left.join(', ')}: ${left.length === 1 ? 'it pairs' : 'they pair'} with a line this run did not change`);
  return out.join('; ');
}

// Reviewer attention flags: never blocking.
export function gateFlags(file, { current, isGuideline }) {
  const flags = [];
  const before = current ?? '';
  const ops = lineDiff(before, file.content);
  const added = addedLineIndexes(ops);
  const lines = file.content.split('\n');
  const oldUrls = new Set(before.match(URL_RE) ?? []);
  const newUrls = new Set();
  const newTags = new Set();
  const vendors = new Set();
  const inFence = fencedLines(lines);
  const proseOf = proseLines(lines);
  const style = { bold: [], unspaced_double: [], spaced_hyphen: [] };
  for (const i of [...added].sort((a, b) => a - b)) {
    const line = lines[i];
    for (const u of line.match(URL_RE) ?? []) if (!oldUrls.has(u)) newUrls.add(u);
    // Markdown renders tags inside code as text, so only prose is scanned; URLs are flagged anywhere.
    if (inFence.has(i)) continue;
    const prose = line.replace(/<!--[\s\S]*?-->/g, '').replace(/(`+)[\s\S]*?\1/g, '');
    for (const t of prose.match(HTML_TAG_RE) ?? []) {
      if (/^<a\s+(name|id)=/i.test(t) || /^<\/a>$/i.test(t)) continue;
      newTags.add(t);
    }
    const v = line.match(VENDOR_RE);
    if (v) vendors.add(v[0]);
    if (!proseOf[i]) continue;
    if (BOLD_BULLET_RE.test(proseOf[i].text)) style.bold.push(i + 1);
    for (const kind of dashKinds(proseOf[i].text)) if (style[kind]) style[kind].push(i + 1);
  }
  const at = (nums) => `${nums.length === 1 ? 'line' : 'lines'} ${nums.join(', ')}`;
  const styleDetail = [
    ...(style.bold.length ? [`bullet starting with a bold label on ${at(style.bold)}`] : []),
    ...(style.unspaced_double.length ? [`double hyphen outside code on ${at(style.unspaced_double)}`] : []),
    ...(style.spaced_hyphen.length ? [`spaced hyphen used as a dash on ${at(style.spaced_hyphen)}`] : []),
  ];
  if (newUrls.size) flags.push({ kind: 'new_urls', detail: [...newUrls] });
  if (newTags.size) flags.push({ kind: 'raw_html', detail: [...newTags] });
  if (vendors.size) flags.push({ kind: 'vendor_names', detail: [...vendors] });
  if (styleDetail.length) flags.push({ kind: 'style', detail: styleDetail });
  if (isGuideline) flags.push({ kind: 'guideline_edit', detail: unifiedDiff(before, file.content, file.path) });
  return { ok: true, flags };
}

// `format.run(content, path)` returns { ok, content } or { ok: false, error }.
export function gateFormat(file, { format }) {
  if (!format || format.mode !== 'strict') return { ok: true, content: file.content };
  const r = format.run(file.content, file.path);
  if (!r.ok) return { ok: false, reason: `prettier failed: ${r.error}` };
  return { ok: true, content: r.content };
}

// Runs gates 0-6 in order. `carriedDeletes` are still in the checkout, so they must be named.
export function runGates(files, ctx) {
  const { isEditableDoc, readCurrent, readTarget, existsInCheckout, guidelineFiles, format, carriedDeletes = new Set() } = ctx;
  const guidelines = guidelineFiles ?? new Set();
  const dropped = [];
  const orphaned = [];
  const drop = (f, gate, reason) => dropped.push({ path: f.path, gate, reason });

  const stage1 = [];
  for (const f of files) {
    let r = gateAllowlist(f, { isEditableDoc });
    if (!r.ok) {
      drop(f, 0, r.reason);
      continue;
    }
    const current = readCurrent(f.path);
    if (f.action === 'delete') {
      if (current == null) drop(f, 1, 'nothing to delete');
      else stage1.push({ ...f, current });
      continue;
    }
    r = gateNonEmpty(f, { current });
    if (!r.ok) {
      drop(f, 1, r.reason);
      continue;
    }
    stage1.push({ ...f, current });
  }

  const treeOf = (alive) => {
    const edited = new Set(alive.filter((f) => f.action !== 'delete').map((f) => f.path));
    const deleted = new Set(alive.filter((f) => f.action === 'delete').map((f) => f.path));
    return (p) => edited.has(p) || (!deleted.has(p) && !carriedDeletes.has(p) && existsInCheckout(p));
  };
  const pruneOrphans = (alive) => {
    const r = dropOrphanedDependents(alive, new Set(alive.map((f) => f.path)));
    orphaned.push(...r.orphaned);
    return r.kept;
  };

  const alive = pruneOrphans(stage1);
  const existsInTree = treeOf(alive);
  const next = [];
  for (const f of alive) {
    if (f.action === 'delete') {
      const isGuideline = isGuidelineFile(f.path, guidelines);
      const flags = (f.flags ?? []).filter((x) => x.kind !== 'guideline_delete');
      if (isGuideline) flags.push({ kind: 'guideline_delete', detail: unifiedDiff(f.current, '', f.path) });
      next.push({ ...f, flags });
      continue;
    }
    // Against the target, like gate 3, so links carried from earlier runs are re-checked.
    let r = gateLinks(f, { existsInTree, current: readTarget(f.path) });
    if (!r.ok) {
      drop(f, 2, r.reason);
      continue;
    }
    r = gateSize(f, { target: readTarget(f.path) });
    if (!r.ok) {
      drop(f, 3, r.reason);
      continue;
    }
    r = gateStyle(f, { current: f.current });
    if (!r.ok) {
      drop(f, 4, r.reason);
      continue;
    }
    const styled = { ...f, content: r.content, dashFixes: r.fixes, dashesLeft: r.left };
    const flags = gateFlags(styled, { current: f.current, isGuideline: isGuidelineFile(f.path, guidelines) }).flags;
    r = gateFormat(styled, { format });
    if (!r.ok) {
      drop(f, 6, r.reason);
      continue;
    }
    next.push({ ...styled, content: r.content, flags });
  }

  // A create or delete held back changes the tree, so gate 2 reruns until nothing more drops.
  let kept = next;
  for (;;) {
    const pruned = pruneOrphans(kept);
    const inTree = treeOf(pruned);
    const survivors = pruned.filter((f) => {
      if (f.action === 'delete') return true;
      const r = gateLinks(f, { existsInTree: inTree, current: readTarget(f.path) });
      if (!r.ok) drop(f, 2, r.reason);
      return r.ok;
    });
    if (survivors.length === kept.length) return { kept: survivors, dropped, orphaned };
    kept = survivors;
  }
}

