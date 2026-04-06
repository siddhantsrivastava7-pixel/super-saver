/**
 * .claude/utils/savings.js
 *
 * Token Savings Tracker
 *
 * Estimates and accumulates token savings across the session.
 * Uses the standard approximation: 1 token ≈ 4 characters.
 *
 * Tracks five sources of savings:
 *   1. Prompt compression      — filler removal + phrase replacement
 *   2. History compression     — older turns collapsed to summaries
 *   3. File cache hits         — files served from registry vs. full re-reads
 *   4. Output policy shaping   — task-aware response directives
 *   5. Lifecycle optimization  — idle gap rebuild / long-session compact mode
 *
 * INVARIANT: total_estimated_saved_tokens === sum of all five breakdown fields.
 * The total is always recomputed from components — never carried forward from
 * an old total. This eliminates drift caused by schema migrations where old
 * sessions had a total but no breakdown fields.
 *
 * Savings are stored in memory.savings and reported via formatSavingsBlock().
 *
 * Note: All numbers are estimates. The actual savings depend on the
 * real tokenizer, which we don't invoke (it would require an API call).
 * These numbers are directionally correct and useful for tracking trends.
 */

"use strict";

// 1 token ≈ 4 characters (industry standard approximation)
const CHARS_PER_TOKEN = 4;

// Estimated token savings per compressed message.
// A full turn is ~600–1000 chars (~150–250 tokens); the summary replaces it
// with ~20–30 tokens. Conservative midpoint: ~180 tokens saved per message.
const TOKENS_PER_COMPRESSED_MSG = 180;

// Estimated token savings per file cache hit.
// Average file read: 300–500 lines ≈ 800–2000 tokens.
// Cache summary: ~50 tokens. Net saving: 750+. Conservative estimate: 400.
const TOKENS_PER_CACHE_HIT = 400;

// Tokens saved per non-default output policy (structured directive prevents
// Claude from padding responses).
const TOKENS_PER_POLICY = 50;

// ─── Estimation ───────────────────────────────────────────────────────────────

/**
 * Estimate token count from character count.
 */
function estimateTokens(charCount) {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Compute prompt-level savings between raw and optimized text.
 */
function computePromptSavings(originalChars, optimizedChars) {
  const originalTokens  = estimateTokens(originalChars);
  const optimizedTokens = estimateTokens(optimizedChars);
  const savedTokens     = Math.max(0, originalTokens - optimizedTokens);
  const savedPercent    = originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;
  return { originalTokens, optimizedTokens, savedTokens, savedPercent };
}

// ─── Accumulation ─────────────────────────────────────────────────────────────

/**
 * Update the savings sub-object in memory with stats from one hook run.
 *
 * CRITICAL DESIGN NOTE:
 *   total_estimated_saved_tokens is computed as the SUM of all five breakdown
 *   fields — never as old_total + turnSaved. This guarantees the invariant
 *   total = sum(components) regardless of schema migrations or field additions.
 *
 * @param {object} currentSavings  - memory.savings (may be undefined on first run)
 * @param {{
 *   originalChars:         number,
 *   optimizedChars:        number,
 *   messagesCompressed:    number,  — actual count from compressor (0 if no transcript)
 *   cacheHits:             number,
 *   taskType?:             string,
 *   lifecycleMode?:        "normal"|"compact"|"rebuild",
 *   lifecycleTokensSaved?: number,
 * }} stats
 * @returns {object} Updated savings object
 */
function updateSavings(currentSavings, stats) {
  // Use ?? not || so a legitimate 0 doesn't fall back to the default schema.
  const s = currentSavings ?? {};

  const { originalTokens, optimizedTokens, savedTokens } = computePromptSavings(
    stats.originalChars,
    stats.optimizedChars
  );

  const compressionSaved = (stats.messagesCompressed || 0) * TOKENS_PER_COMPRESSED_MSG;
  const cacheSaved       = (stats.cacheHits          || 0) * TOKENS_PER_CACHE_HIT;
  const policySaved      = (stats.taskType || "default") !== "default" ? TOKENS_PER_POLICY : 0;
  const lifecycleSaved   = stats.lifecycleTokensSaved || 0;

  // Accumulate each category using ?? so a legitimate 0 doesn't fall back to a
  // stale state value (unlike ||, which treats 0 as falsy).
  const newPromptSaved  = (s.prompt_saved_tokens        ?? 0) + savedTokens;
  const newHistSaved    = (s.history_saved_tokens        ?? 0) + compressionSaved;
  const newCacheSaved   = (s.read_cache_saved_tokens     ?? 0) + cacheSaved;
  const newPolicySaved  = (s.output_policy_saved_tokens  ?? 0) + policySaved;
  const newLifeSaved    = (s.lifecycle_saved_tokens      ?? 0) + lifecycleSaved;

  // THE FIX: total is always recomputed as the exact sum of components.
  // Any old total carried over from a pre-breakdown schema is discarded.
  const newTotal = newPromptSaved + newHistSaved + newCacheSaved + newPolicySaved + newLifeSaved;

  const newOriginalTokens  = (s.total_original_tokens  ?? 0) + originalTokens;
  const newOptimizedTokens = (s.total_optimized_tokens ?? 0) + optimizedTokens;

  // total_tokens_processed_estimate = what would have been sent without optimization.
  // = tokens actually sent (optimized) + tokens saved by all mechanisms.
  // Efficiency % = newTotal / total_tokens_processed_estimate * 100.
  const newProcessedEstimate = newOptimizedTokens + newTotal;

  return {
    prompts_processed:               (s.prompts_processed ?? 0) + 1,
    total_cache_hits:                (s.total_cache_hits  ?? 0) + (stats.cacheHits || 0),

    // Token counts
    total_original_tokens:           newOriginalTokens,
    total_optimized_tokens:          newOptimizedTokens,
    total_tokens_processed_estimate: newProcessedEstimate,

    // Total — always exactly the sum of the five breakdown fields below.
    total_estimated_saved_tokens:    newTotal,

    // Five-category breakdown (all additive, all use ??):
    prompt_saved_tokens:             newPromptSaved,
    history_saved_tokens:            newHistSaved,
    read_cache_saved_tokens:         newCacheSaved,
    output_policy_saved_tokens:      newPolicySaved,
    lifecycle_saved_tokens:          newLifeSaved,

    // Last-turn mode (non-cumulative; for telemetry/debugging):
    lifecycle_mode:                  stats.lifecycleMode || "normal",

    // Per-turn contributions — used by telemetry for additive accumulation.
    // These are the raw deltas for THIS TURN ONLY, not cumulative session totals.
    // Telemetry must use these (not session totals) so it survives session resets.
    turnStats: {
      prompt_saved:    savedTokens,
      history_saved:   compressionSaved,
      cache_saved:     cacheSaved,
      policy_saved:    policySaved,
      lifecycle_saved: lifecycleSaved,
      total_saved:     newTotal - (
        (s.prompt_saved_tokens       ?? 0) +
        (s.history_saved_tokens      ?? 0) +
        (s.read_cache_saved_tokens   ?? 0) +
        (s.output_policy_saved_tokens ?? 0) +
        (s.lifecycle_saved_tokens    ?? 0)
      ),
      optimized_tokens: optimizedTokens,
    },
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/**
 * Format a compact savings summary for injection into additionalContext.
 * Only shown after 2+ prompts (first prompt has nothing to compare).
 *
 * @param {object} savings - memory.savings
 * @returns {string}       - One-line summary, or empty string
 */
function formatSavingsBlock(savings) {
  if (!savings || savings.prompts_processed < 2) return "";

  const totalSaved   = savings.total_estimated_saved_tokens || 0;
  const totalProcess = savings.total_tokens_processed_estimate || 0;

  // Efficiency = saved / total_processed (includes history, cache, lifecycle)
  // Falls back to old formula if total_tokens_processed_estimate not yet present.
  const denominator = totalProcess > 0
    ? totalProcess
    : (savings.total_original_tokens || 0) + totalSaved;

  const pct = denominator > 0
    ? ((totalSaved / denominator) * 100).toFixed(0)
    : "0";

  const parts = [
    `${savings.prompts_processed} prompts`,
    `~${totalSaved} tokens saved (${pct}% efficiency)`,
  ];

  if (savings.total_cache_hits > 0) {
    parts.push(`${savings.total_cache_hits} file cache hits`);
  }

  return `Session: ${parts.join(" | ")}`;
}

/**
 * Detailed savings breakdown for diagnostics.
 * Validates the invariant: total === sum(components).
 */
function formatDetailedSavings(savings) {
  if (!savings) return "No savings data yet.";

  const componentSum =
    (savings.prompt_saved_tokens        || 0) +
    (savings.history_saved_tokens       || 0) +
    (savings.read_cache_saved_tokens    || 0) +
    (savings.output_policy_saved_tokens || 0) +
    (savings.lifecycle_saved_tokens     || 0);

  const total = savings.total_estimated_saved_tokens || 0;
  const drift = total - componentSum;

  const lines = [
    `Prompts processed         : ${savings.prompts_processed}`,
    `Original tokens (est)     : ${savings.total_original_tokens || 0}`,
    `Optimized tokens (est)    : ${savings.total_optimized_tokens || 0}`,
    `Total processed (est)     : ${savings.total_tokens_processed_estimate || 0}`,
    ``,
    `Total tokens saved        : ${total}`,
    `  prompt_saved            : ${savings.prompt_saved_tokens        || 0}`,
    `  history_saved           : ${savings.history_saved_tokens       || 0}`,
    `  read_cache_saved        : ${savings.read_cache_saved_tokens    || 0}`,
    `  output_policy_saved     : ${savings.output_policy_saved_tokens || 0}`,
    `  lifecycle_saved         : ${savings.lifecycle_saved_tokens     || 0}`,
    `  component_sum           : ${componentSum}`,
    drift !== 0 ? `  ⚠ DRIFT (total - sum)   : ${drift}` : `  ✓ total === component_sum`,
    ``,
    `File cache hits           : ${savings.total_cache_hits ?? 0}`,
  ];

  return lines.join("\n");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  estimateTokens,
  computePromptSavings,
  updateSavings,
  formatSavingsBlock,
  formatDetailedSavings,
  // Export constants so pipeline.js can use them for estimates
  TOKENS_PER_COMPRESSED_MSG,
  TOKENS_PER_CACHE_HIT,
};
