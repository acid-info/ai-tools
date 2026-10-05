import { collectAgentsFiles } from '#core/guidelines.mjs';

export const guidelineFileSet = (cfg, root) => {
  const set = new Set(cfg.guidelines_files);
  for (const f of collectAgentsFiles(root, [])) set.add(f);
  return set;
};

export const isGuidelineFile = (p, set) => set.has(p) || /(^|\/)(AGENTS|CLAUDE)\.md$/.test(p);
