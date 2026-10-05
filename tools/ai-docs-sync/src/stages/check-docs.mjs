import { mapConcurrent } from '#core/text.mjs';

import { CHECKER_SYSTEM, checkInBatches, checkerUser, decideAfterCheck, parseChecker } from '../checker.mjs';
import { unifiedDiff } from '../linediff.mjs';
import { dropOrphanedDependents } from '../plan.mjs';
import { correctionPart } from '../writer.mjs';

export async function checkDocs(ctx) {
  const { callModel, cfg, deletes, drafts, heldBack, log, manifestText, models, narrative, packed, staleText, warn, writeDoc } = ctx;
  // 5.9 checker in batches, then at most one correction per file; a delete is never corrected
  const toCheck = [...drafts.map((d) => ({ ...d, editDiff: unifiedDiff(d.current ?? '', d.content, d.path) })), ...deletes];
  let verdicts = new Map();
  if (toCheck.length) {
    const r = await checkInBatches(toCheck, {
      budget: cfg.checker_batch_tokens,
      concurrency: cfg.writer_concurrency,
      check: async (batch, i, n) => {
        const res = await callModel(models.checker, n > 1 ? `checker ${i + 1}/${n}` : 'checker', {
          system: CHECKER_SYSTEM,
          blocks: [{ text: checkerUser({ narrative, diff: packed.diff, manifest: manifestText, stale: staleText, docs: batch }) }],
          maxTokens: cfg.response_max_tokens,
        });
        return parseChecker(res.text);
      },
    });
    verdicts = r.verdicts;
    for (const f of r.failed)
      warn(`checker ${f.error ? `failed (${f.error.message})` : 'returned unparseable output'}; proceeding unchecked for ${f.paths.join(', ')}`);
  }
  const toCorrect = [];
  let candidates = [];
  for (const d of toCheck) {
    const decision = decideAfterCheck(verdicts.get(d.path), d.action);
    const entry = { ...d, check: decision };
    if (decision.action === 'drop') heldBack.push({ path: d.path, reason: 'checker: drop' + (decision.issues.length ? ` (${decision.issues.map((i) => i.note).join('; ')})` : '') });
    else if (decision.action === 'correct') toCorrect.push(entry);
    else candidates.push(entry);
  }
  // A delete the checker dropped takes its link fix-ups with it, before a correction is spent.
  const alive = new Set([...toCorrect, ...candidates].map((d) => d.path));
  const correctable = dropOrphanedDependents(toCorrect, alive);
  heldBack.push(...correctable.orphaned);
  const pruned = dropOrphanedDependents(candidates, alive);
  heldBack.push(...pruned.orphaned);
  candidates = pruned.kept;
  if (correctable.kept.length) {
    log(`Correction pass for ${correctable.kept.length} file(s)`);
    const corrected = await mapConcurrent(correctable.kept, cfg.writer_concurrency, (d) =>
      writeDoc(d, '\n\n' + correctionPart({ draft: d.content, issues: d.check.issues }))
    );
    correctable.kept.forEach((d, i) => {
      const content = corrected[i].content;
      if (content == null) warn(`correction for ${d.path} ${corrected[i].error ? 'failed' : 'unparseable'}; keeping the first draft`);
      candidates.push({ ...d, content: content ?? d.content, corrected: content != null });
    });
  }
  return { candidates };
}
