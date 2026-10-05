#!/usr/bin/env node
/**
 * Dual-model PR review orchestrator.
 * Env: GITHUB_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, REPO ("owner/name"), PR_NUMBER
 * Runs from the DEFAULT-branch checkout (trusted): .github/ai-review.yml and the
 * guideline files are read from that checkout, while the PR diff is fetched via the
 * GitHub API by PR_NUMBER, so PR-authored code/config never executes in this job.
 * The only file that reads process.env or writes to GitHub; the rest is in src/.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { createGitHub } from '#core/github.mjs';
import { loadGuidelines } from '#core/guidelines.mjs';
import { effortConfig, isAnthropicModel } from '#core/models.mjs';
import { makeMatcher } from '#core/paths.mjs';
import { anthropicCall, openaiCall } from '#core/providers.mjs';
import { approxTokens } from '#core/text.mjs';
import { makeUsageLog, usageTable } from '#core/usage.mjs';

import { CONFIG_PATH, MAX_RESPONSE_TOKENS, loadConfig } from './src/config.mjs';
import { fetchPrFiles, packFiles } from './src/diff.mjs';
import { renderReview, renderUnreviewable } from './src/post.mjs';
import { pickSynthModel, runReviewers, synthesize } from './src/review.mjs';

const { GITHUB_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, REPO, PR_NUMBER, GITHUB_OUTPUT, SKIP_GUIDELINES, DRY_RUN } = process.env;

// When truthy ("1", "true", "yes"), reviewers run without any guideline files.
const skipGuidelines = /^(1|true|yes)$/i.test(SKIP_GUIDELINES ?? '');

const log = (m) => console.log(m);
const warn = (m) => console.warn(`[warn] ${m}`);

async function main() {
  const missingEnv = [
    ['GITHUB_TOKEN', GITHUB_TOKEN],
    ['REPO', REPO],
    ['PR_NUMBER', PR_NUMBER],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) missingEnv.push('ANTHROPIC_API_KEY or OPENAI_API_KEY');
  if (missingEnv.length) {
    console.error(`Missing required env var(s): ${missingEnv.join(', ')}`);
    process.exit(1);
  }

  const cfg = loadConfig(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null, { warn });
  const isIgnored = makeMatcher(cfg.ignore);
  const { request: gh, paginate } = createGitHub({ token: GITHUB_TOKEN, onRetry: warn });
  const usage = makeUsageLog(log, warn);

  const { pr, files: listed } = await fetchPrFiles({ gh, paginate }, REPO, PR_NUMBER);
  const packed = packFiles(listed, { changedFiles: pr.changed_files, isIgnored, budget: cfg.max_diff_tokens });
  const { diff, files, fileCount, skipped, noPatch, omitted, unlisted, validLines } = packed;

  if (!diff.trim()) {
    const body = renderUnreviewable({ noPatch, omitted, unlisted, maxDiffTokens: cfg.max_diff_tokens });
    if (DRY_RUN) {
      console.log('\n===== DRY RUN -- comment that WOULD be posted =====\n');
      console.log(body);
    } else {
      await gh(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, { method: 'POST', body: { body } });
    }
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'criticals=0\n');
    return;
  }
  console.log(
    `Reviewing ${fileCount} files (~${approxTokens(diff)} tokens, ${skipped} skipped, ` +
      `${noPatch.length} without patch, ${omitted} over budget)`
  );

  if (skipGuidelines) console.log('Guideline files disabled via SKIP_GUIDELINES.');
  const readFile = (f) => readFileSync(f, 'utf8');
  const guidelines = skipGuidelines ? '' : loadGuidelines(cfg.guidelines_files, process.cwd(), files, readFile, { log, warn }).text;

  const call = async (label, model, { system, prompt, effort, timeoutMs }) => {
    const anthropic = isAnthropicModel(model);
    const r = await (anthropic ? anthropicCall : openaiCall)({
      fetch,
      apiKey: anthropic ? ANTHROPIC_API_KEY : OPENAI_API_KEY,
      model,
      system,
      blocks: [{ text: prompt }],
      maxTokens: MAX_RESPONSE_TOKENS,
      effort,
      timeoutMs,
      retry: { onRetry: (m) => warn(`${label}: ${m}`) },
    });
    usage.log(label, model, r.usage);
    return r;
  };

  const reviews = await runReviewers({ call, cfg, diff, guidelines });
  const { model: synthModel, providerDown } = pickSynthModel(cfg, reviews);
  const synthEffortSent = Object.keys(effortConfig(synthModel, cfg.synth_effort)).length > 0;
  console.log(
    `Synthesizing with ${synthModel} (effort: ${synthEffortSent ? cfg.synth_effort : 'not supported, omitted'})` +
      (providerDown ? ` -- fallback, ${cfg.synth_model}'s provider is down` : '')
  );
  const { merged, synthFailed } = await synthesize({ call, cfg, model: synthModel, reviewA: reviews.reviewA, reviewB: reviews.reviewB });

  const review = renderReview(
    merged,
    { skipped, noPatch, omitted, unlisted, validLines, ...reviews, synthFailed, synthModel },
    { cfg, prNumber: PR_NUMBER, usage: ['', '#### API usage', ...usageTable({ entries: usage.entries, total: usage.total(), unpriced: usage.unpriced() })] }
  );

  if (DRY_RUN) {
    console.log('\n===== DRY RUN -- review that WOULD be posted =====\n');
    console.log(review.body);
    for (const c of review.comments) console.log(`\n--- ${c.path}:${c.line} ---\n${c.body}`);
  } else {
    try {
      await gh(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, {
        method: 'POST',
        body: { event: 'COMMENT', body: review.body, comments: review.comments },
      });
    } catch (e) {
      // Inline anchors can fail if a model hallucinated a line number: fall back to summary-only.
      console.error(`[warn] inline review failed (${e.message}); posting summary + list instead.`);
      await gh(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, { method: 'POST', body: { body: review.flatBody() } });
    }
  }

  const { criticals } = review;
  writeFileSync('critical-issues.json', JSON.stringify(criticals, null, 2));
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `criticals=${criticals.length}\n`);
  console.log(`Done: ${merged.issues.length} merged issues, ${criticals.length} critical.`);
  const unpriced = usage.unpriced();
  console.log(`[cost] TOTAL for this review ≈ $${usage.total().toFixed(4)}` + (unpriced.length ? ` (excludes unpriced model(s): ${unpriced.join(', ')})` : ''));
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
