import { loadGuidelines } from '#core/guidelines.mjs';
import { makeMatcher } from '#core/paths.mjs';

import { DENYLIST } from '../config.mjs';
import { guidelineFileSet } from '../guidelines.mjs';
import { buildManifest, renderManifest } from '../manifest.mjs';

export async function readDocs(ctx) {
  const { ROOT, carried, cfg, changedPaths, isEditableDoc, log, readCheckout, readCurrent, tombstones, walkDocs, warn } = ctx;
  // 5.6 manifest. Every Markdown file is kept for the inbound-link check on deletes.
  const denied = makeMatcher(DENYLIST);
  const allMarkdown = [...new Set([...walkDocs((p) => p.endsWith('.md') && !denied(p)), ...carried.keys()])].filter((p) => !tombstones.has(p));
  const docPaths = allMarkdown.filter((p) => carried.has(p) || isEditableDoc(p));
  const manifest = buildManifest(docPaths.map((p) => ({ path: p, content: readCurrent(p) })));
  const manifestText = renderManifest(manifest);
  log(`Manifest: ${manifest.length} editable docs\n${manifestText}\n`);

  const guidelines = loadGuidelines(cfg.guidelines_files, ROOT, changedPaths, readCheckout, { log, warn });
  const guidelineFiles = guidelineFileSet(cfg, ROOT);
  return { allMarkdown, manifest, manifestText, guidelines, guidelineFiles };
}
