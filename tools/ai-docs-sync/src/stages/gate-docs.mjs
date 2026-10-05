import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { runGates } from '../gates.mjs';
import { inboundLinks } from '../links.mjs';
import { flagBrokenInbound, markNewDocLinks } from '../plan.mjs';

export async function gateDocs(ctx) {
  const { ROOT, allMarkdown, candidates, carried, cfg, guidelineFiles, heldBack, isEditableDoc, isNewDoc, makeFormatter, readCheckout, readCurrent, reviewerRemoved, tombstones } = ctx;
  // 5.10 gates
  const format = candidates.some((c) => c.action !== 'delete') ? makeFormatter(cfg) : { mode: 'off' };
  const gated = runGates(candidates, {
    isEditableDoc,
    readCurrent,
    readTarget: readCheckout,
    // Carried-forward creates live on the rolling branch only, so links to them must resolve.
    existsInCheckout: (p) => carried.has(p) || existsSync(join(ROOT, p)),
    carriedDeletes: tombstones,
    guidelineFiles,
    format,
  });
  const { dropped } = gated;
  heldBack.push(...gated.orphaned);
  const keptEdits = new Map(gated.kept.filter((k) => k.action !== 'delete').map((k) => [k.path, k.content]));
  const gone = new Set(gated.kept.filter((k) => k.action === 'delete').map((k) => k.path));
  // An earlier run's create, edited again, is still new to the target.
  const kept = markNewDocLinks(
    gated.kept.filter((k) => k.action !== 'delete').map((k) => (k.action === 'update' && isNewDoc(k.path) ? { ...k, action: 'create' } : k)),
    allMarkdown.filter((p) => !keptEdits.has(p) && !gone.has(p)).map((p) => ({ path: p, content: readCurrent(p) }))
  );
  // On the final content, so a link fix-up that was held back still shows.
  const finalInbound = inboundLinks(
    [...new Set([...allMarkdown, ...keptEdits.keys()])].map((p) => ({ path: p, content: keptEdits.has(p) ? keptEdits.get(p) : readCurrent(p) })),
    [...gone, ...reviewerRemoved.keys()]
  );
  const keptDeletes = flagBrokenInbound(gated.kept.filter((k) => k.action === 'delete'), finalInbound);
  return { dropped, keptEdits, kept, finalInbound, keptDeletes };
}
