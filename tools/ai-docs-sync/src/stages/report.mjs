import { costLine } from '#core/usage.mjs';

import { describeDecision } from '../carry.mjs';
import { isGuidelineFile } from '../guidelines.mjs';
import { unifiedDiff } from '../linediff.mjs';
import { regenerateFrom } from '../publish.mjs';

export async function report(ctx) {
  const { TARGET_BRANCH, carried, carryBase, cfg, decisions, delPlan, discardedReviewer, dropped, finalInbound, from, guidelineFiles, head, heldBack, kept, keptDeletes, keptEdits, linkPlan, log, moveCursor, mustRefresh, obsolete, packed, prevRuns, readCheckout, revertedFixups, reviewerRemoved, staleCarried, tombstones, usage } = ctx;
  log('\n===== RESULT =====');
  log(`Range ${from.slice(0, 7)}..${head.slice(0, 7)} on ${TARGET_BRANCH}; rolling branch ${cfg.branch}`);
  for (const k of kept) {
    const notes = [];
    if (k.check?.unchecked) notes.push('unchecked');
    else if (k.corrected) notes.push(`corrected after: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    else if (k.check?.issues?.length) notes.push(`checker notes: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    if (k.dashesFixed) notes.push(`${k.dashesFixed} dash line(s) fixed`);
    if (k.action === 'create') notes.push(k.linkedFrom.length ? `linked from ${k.linkedFrom.join(', ')}` : 'not linked from any doc');
    log(`KEEP ${k.action} ${k.path} -- ${k.reason}` + (notes.length ? `\n     ${notes.join('\n     ')}` : ''));
    for (const f of k.flags) {
      if (f.kind === 'guideline_edit') log(`     FLAG guideline file edited; full diff:\n${f.detail.replace(/^/gm, '       ')}`);
      else log(`     FLAG ${f.kind}: ${f.detail.join(', ')}`);
    }
  }
  for (const d of keptDeletes) {
    log(`DELETE ${d.path} -- ${d.reason}` + (d.check?.unchecked ? '\n     unchecked' : ''));
    for (const f of d.flags) {
      if (f.kind === 'guideline_delete') log(`     FLAG guideline file deleted; removed content:\n${f.detail.replace(/^/gm, '       ')}`);
      else log(`     FLAG ${f.kind}: ${f.detail.join(', ')}`);
    }
  }
  for (const d of dropped) log(`DROP ${d.path} -- gate ${d.gate}: ${d.reason}`);
  for (const h of heldBack) log(`HELD ${h.path} -- ${h.reason}`);
  const keptPaths = new Set([...kept, ...keptDeletes].map((k) => k.path));
  for (const { path: p, kind, reason } of staleCarried)
    log(
      `STALE carried ${kind} of ${p} discarded, ${reason ?? 'target changed the file'}; ` +
        (keptPaths.has(p) ? 'redone this run' : `not reselected (force with since=${regenerateFrom(prevRuns, p, carryBase)})`)
    );
  const reviewer = [
    ...decisions.map((d) => ({
      ...d,
      fixed: (linkPlan.reviewerFixups.get(d.path) ?? []).filter((q) => keptEdits.has(q)),
      linkers: [...(finalInbound.get(d.path) ?? [])].sort(),
      requeued: (revertedFixups.get(d.path) ?? []).map((q) => ({ path: q, redone: keptPaths.has(q) })),
      flags: reviewerRemoved.has(d.path) && isGuidelineFile(d.path, guidelineFiles) ? [{ kind: 'guideline_delete', detail: unifiedDiff(readCheckout(d.path) ?? '', '', d.path) }] : [],
    })),
    ...discardedReviewer.map((d) => ({ kind: 'discarded', path: d.path, requeued: (revertedFixups.get(d.path) ?? []).map((q) => ({ path: q, redone: keptPaths.has(q) })) })),
  ];
  for (const r of reviewer)
    log(
      `REVIEWER ${r.kind === 'discarded' ? `delete of ${r.path} discarded, ${TARGET_BRANCH} changed the file` : describeDecision(r)}` +
        (r.fixed?.length ? `; links fixed in ${r.fixed.join(', ')}` : '') +
        (r.linkers?.length ? `; still linked from ${r.linkers.join(', ')}` : '') +
        (r.requeued?.length ? `; fix-ups sent back to triage: ${r.requeued.map((q) => `${q.path} (${q.redone ? 'redone' : 'not reselected'})`).join(', ')}` : '')
    );
  for (const p of obsolete) log(`OBSOLETE carried change dropped, target deleted ${p}`);
  for (const d of delPlan.suggested) log(`SUGGESTED deletion (not acted on): ${d.path} -- ${d.reason} (${d.why})`);
  if (carried.size) log(`CARRIED forward from earlier runs: ${[...carried.keys()].join(', ')}`);
  if (tombstones.size) log(`CARRIED deletes from earlier runs: ${[...tombstones].join(', ')}`);
  if (packed.omitted.length) log(`DIFF over budget, not shown to the models: ${packed.omitted.join(', ')}`);
  log(costLine(usage));

  if (!keptPaths.size && !mustRefresh) {
    moveCursor('Nothing survived the gates; the rolling PR is left as it is');
    return { done: true };
  }
  return { keptPaths, reviewer };
}
