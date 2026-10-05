import { isTransientError } from '#core/http.mjs';
import { approxTokens, mapConcurrent } from '#core/text.mjs';

import { renderManifest } from '../manifest.mjs';
import { finaliseIndexTasks } from '../plan.mjs';
import { renderReviewerBlock } from '../triage.mjs';
import { WRITER_SYSTEM, parseWriterOutput, writerDocPart, writerPrefix } from '../writer.mjs';

export async function writeDocs(ctx) {
  const { callModel, cfg, decisions, deletedPaths, deletes, earlierByPath, guidelines, heldBack, indexTasks, log, manifest, models, narrative, packed, patches, readCurrent, reviewerRemoved, staleText, tasks, warn } = ctx;
  // 5.8 writer, one call per doc, cached prefix, concurrency of three
  const prefix = writerPrefix({
    guidelines: guidelines.text,
    narrative,
    diff: packed.diff,
    manifest: renderManifest(manifest.filter((m) => !deletedPaths.has(m.path))),
    stale: staleText,
    reviewer: renderReviewerBlock(decisions),
    deleted: [
      ...deletes.map((d) => ({ path: d.path, reason: d.reason })),
      ...[...reviewerRemoved.values()].map((d) => ({ path: d.path, reason: d.kind === 'renamed' ? `renamed by a reviewer to ${d.to}; link there instead` : 'deleted by a reviewer' })),
    ],
  });
  const patchByPath = new Map(patches.map((p) => [p.path, p]));
  const fits = (a) => {
    const current = readCurrent(a.path);
    if (current == null || approxTokens(current) <= cfg.max_doc_tokens) return true;
    heldBack.push({ path: a.path, reason: 'too large for a full rewrite in v1' });
    return false;
  };
  const writable = tasks.filter(fits);
  log(`Writer: ${writable.length} call(s) planned` + (indexTasks.length ? `, then up to ${indexTasks.length} index update(s)` : '') + (heldBack.length ? `, ${heldBack.length} held back` : ''));
  const docPart = (a) =>
    writerDocPart({
      path: a.path,
      action: a.action,
      reason: a.reason,
      sourcePatches: a.source_files.flatMap((f) => [earlierByPath.get(f)?.patch, patchByPath.get(f)?.patch]).filter(Boolean).join('\n\n'),
      current: readCurrent(a.path) ?? '',
      exemplar: a.exemplar ? { path: a.exemplar.path, content: readCurrent(a.exemplar.path) } : null,
      exemplarTokens: cfg.max_doc_tokens / 2,
    });
  // { content } with content null when unparseable, or { error } once the call's retries are spent.
  const writeDoc = async (a, extra = '') => {
    try {
      const r = await callModel(models.writer, `writer ${a.path}`, {
        system: WRITER_SYSTEM,
        blocks: [{ text: prefix, cache: true }, { text: docPart(a) + extra }],
        maxTokens: cfg.writer_max_tokens,
        stream: models.writer.provider === 'anthropic',
      });
      return { content: parseWriterOutput(r.text) };
    } catch (error) {
      warn(`writer ${a.path} failed (${error.message})`);
      return { error };
    }
  };
  const drafts = [];
  const collect = (wave, written) =>
    wave.forEach((a, i) => {
      if (written[i].error) heldBack.push({ path: a.path, reason: `writer call failed: ${written[i].error.message}` });
      else if (written[i].content == null) heldBack.push({ path: a.path, reason: 'writer output could not be parsed as a fenced file' });
      else drafts.push({ ...a, content: written[i].content, current: readCurrent(a.path) });
    });
  // Wave 1, every triage task and link fix-up. The first call alone warms the cached prefix; the
  // rest run three at a time against it.
  const written = writable.length ? [await writeDoc(writable[0])] : [];
  written.push(...(await mapConcurrent(writable.slice(1), cfg.writer_concurrency, (a) => writeDoc(a))));
  // Nothing written and an outage among the causes: fail so the cursor stays put and a later run
  // retries. A request-specific failure (a 400, a timeout) would fail every run, so it is held back.
  if (written.length && written.every((w) => w.error) && written.some((w) => isTransientError(w.error)))
    throw written.find((w) => isTransientError(w.error)).error;
  collect(writable, written);
  // Wave 2, index updates, which need the drafted title of the doc they link.
  const wave2 = finaliseIndexTasks(indexTasks, new Map(drafts.filter((d) => d.action === 'create').map((d) => [d.path, d.content])));
  heldBack.push(...wave2.orphaned);
  const writable2 = wave2.tasks.filter(fits);
  if (writable2.length) {
    log(`Writer: ${writable2.length} index update(s)`);
    collect(writable2, await mapConcurrent(writable2, cfg.writer_concurrency, (a) => writeDoc(a)));
  }
  log(`Writer: ${drafts.length} draft(s)` + (heldBack.length ? `, ${heldBack.length} held back` : ''));
  return { writeDoc, drafts };
}
