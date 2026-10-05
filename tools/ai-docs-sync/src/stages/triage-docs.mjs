import { costLine } from '#core/usage.mjs';

import { applyReviewerDecisions } from '../carry.mjs';
import { inboundLinks } from '../links.mjs';
import { applyInboundLinks, planCreates, planDeletes } from '../plan.mjs';
import { TRIAGE_SYSTEM, parseTriage, renderReviewerBlock, triageUser } from '../triage.mjs';

export async function triageDocs(ctx) {
  const { TRIAGE_ONLY, allMarkdown, callModel, cfg, classified, decisions, earlierPaths, guidelineFiles, guidelines, isEditableDoc, isEditableDocPath, log, manifest, manifestText, models, moveCursor, mustRefresh, narrative, packed, readCurrent, reviewerRemoved, staleText, tombstones, undeleted, usage, warn } = ctx;
  // 5.7 triage
  const triageText = triageUser({ guidelines: guidelines.text, narrative, diff: packed.diff, manifest: manifestText, stale: staleText, reviewer: renderReviewerBlock(decisions) });
  const triageRaw = await callModel(models.triage, 'triage', { system: TRIAGE_SYSTEM, blocks: [{ text: triageText }], maxTokens: cfg.response_max_tokens });
  const triage = parseTriage(triageRaw.text, { isEditableDocPath, exists: (p) => readCurrent(p) != null || tombstones.has(p) });
  if (!triage) throw new Error('triage returned unparseable output (run with DEBUG=1 to see it)');
  for (const d of triage.dropped) warn(`triage named "${d.path}": ${d.reason}; dropped`);
  // A reviewer's decision beats triage, even a nomination that would undo a carried delete.
  const ruled = applyReviewerDecisions({ affected: triage.affected, deletes: triage.deletes, decisions });
  for (const d of ruled.dropped) log(`  triage ${d.action} of ${d.path} dropped: ${d.reason}`);
  for (const a of [...ruled.affected, ...ruled.deletes]) if (tombstones.has(a.path)) undeleted.add(a.path);

  const codePaths = new Set([...classified.code.flatMap((c) => [c.path, c.oldPath]).filter(Boolean), ...earlierPaths]);
  const delPlan = planDeletes({ deletes: ruled.deletes, codePaths, readCurrent, guidelineFiles });
  const markdownNow = () => allMarkdown.map((p) => ({ path: p, content: readCurrent(p) }));
  const linkPlan = applyInboundLinks({
    affected: ruled.affected,
    deletes: delPlan.deletes,
    reviewer: [...reviewerRemoved.values()],
    inbound: inboundLinks(markdownNow(), [...delPlan.deletes.map((d) => d.path), ...reviewerRemoved.keys()]),
    isEditableDoc,
  });
  const deletes = linkPlan.deletes;
  const deletedPaths = new Set(deletes.map((d) => d.path));
  const createPlan = planCreates({ affected: linkPlan.affected, manifest, deleted: deletedPaths, isEditable: isEditableDoc, guidelineFiles });
  const tasks = createPlan.affected;
  const indexTasks = createPlan.indexTasks;
  const heldBack = [...createPlan.refused];
  log(`Triage: ${triage.affected.length} affected, ${deletes.length} delete(s)` + (delPlan.suggested.length ? `, ${delPlan.suggested.length} suggested deletion(s)` : ''));
  for (const a of tasks) log(`  ${a.action} ${a.path}: ${a.reason}${a.source_files.length ? ` [${a.source_files.join(', ')}]` : ''}`);
  for (const d of deletes) log(`  delete ${d.path}: ${d.reason} [${d.source_files.join(', ')}]`);
  for (const d of delPlan.suggested) log(`  suggested deletion ${d.path}: ${d.reason} (${d.why})`);
  for (const c of tasks.filter((a) => a.action === 'create'))
    log(`  create ${c.path}: placement ok; exemplar ${c.exemplar?.path ?? '(none)'}; index ${c.index ?? '(none, will be flagged)'}`);
  for (const r of createPlan.refused) log(`  create ${r.path}: held back, ${r.reason}`);
  for (const t of indexTasks) log(`  index update ${t.path} (second wave) links ${t.dependsOn.join(', ')}`);
  for (const [p, qs] of linkPlan.reviewerFixups) log(`  link fix-up(s) for ${p} (${reviewerRemoved.get(p).kind} by a reviewer): ${qs.join(', ')}`);
  if (!tasks.length && !deletes.length) log(`  ${triage.unaffectedReason || 'no reason given'}`);
  if (TRIAGE_ONLY) {
    log(`TRIAGE_ONLY set; stopping. ${costLine(usage)}`);
    return { done: true };
  }
  if (!tasks.length && !deletes.length && !mustRefresh) {
    log(costLine(usage));
    moveCursor('No docs affected; nothing to write');
    return { done: true };
  }
  return { delPlan, linkPlan, deletes, deletedPaths, tasks, indexTasks, heldBack };
}
