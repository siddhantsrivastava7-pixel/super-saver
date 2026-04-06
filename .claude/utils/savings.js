/**
 * .claude/utils/savings.js
 *
 * Token Savings Tracker
 *
 * Estimates and accumulates token savings across the session.
 * Uses the standard approximation: 1 token ≈ 4 characters.
 *
 * Tracks three sources of savings:
 *   1. Prompt compression  — filler removal + phrase replacement
 *   2. History compression — older turns collapsed to summaries
 *   3. File cache hits     — files served from registry vs. full re-reads
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

// Estimated token size of one average compressed message (replaces full turn)
const TOKENS_PER_COMPRESSED_MSG = 180;

// Estimated token savings per file cache hit
// (average file read is ~300-500 lines = ~800-2000 tokens;
//  summary is ~50 tokens; net saving ~750+ tokens per hit)
const TOKENS_PER_CACHE_HIT = 400;

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
  const originalTokens = estimateTokens(originalChars);
  const optimizedTokens = estimateTokens(optimizedChars);
  const savedTokens = Math.max(0, originalTokens - optimizedTokens);
  const savedPercent =
    originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

  return { originalTokens, optimizedTokens, savedTokens, savedPercent };
}

// ─── Accumulation ─────────────────────────────────────────────────────────────

/**
 * Update the savings sub-object in memory with stats from one hook run.
 *
 * @param {object} currentSavings  - memory.savings (may be undefined on first run)
 * @param {{
 *   originalChars: number,
 *   optimizedChars: number,
 *   messagesCompressed: number,
 *   cacheHits: number,
 * }} stats
 * @returns {object} Updated savings object
 */
function updateSavings(currentSavings, stats) {
  const s = currentSavings ?? {
    prompts_processed: 0,
    total_estimated_saved_tokens: 0,
    total_original_tokens: 0,
    total_optimized_tokens: 0,
    total_cache_hits: 0,
  };

  const { originalTokens, optimizedTokens, savedTokens } = computePromptSavings(
    stats.originalChars,
    stats.optimizedChars
  );

  const compressionSaved = (stats.messagesCompressed || 0) * TOKENS_PER_COMPRESSED_MSG;
  const cacheSaved = (stats.cacheHits || 0) * TOKENS_PER_CACHE_HIT;
  const totalSaved = savedTokens + compressionSaved + cacheSaved;

  return {
    prompts_processed: s.prompts_processed + 1,
    total_estimated_saved_tokens: s.total_estimated_saved_tokens + totalSaved,
    total_original_tokens: s.total_original_tokens + originalTokens,
    total_optimized_tokens: s.total_optimized_tokens + optimizedTokens,
    total_cache_hits: (s.total_cache_hits || 0) + (stats.cacheHits || 0),
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

  const totalSaved = savings.total_estimated_saved_tokens;

  // Honest efficiency rate: saved / (saved + sent)
  // = proportion of what WOULD have been consumed that we avoided
  const totalWouldHaveSent = savings.total_original_tokens + totalSaved;
  const pct =
    totalWouldHaveSent > 0
      ? ((totalSaved / totalWouldHaveSent) * 100).toFixed(0)
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
 * Detailed savings breakdown (used for diagnostics, not injected into context).
 */
function formatDetailedSavings(savings) {
  if (!savings) return "No savings data yet.";

  const lines = [
    `Prompts processed     : ${savings.prompts_processed}`,
    `Original tokens (est) : ${savings.total_original_tokens}`,
    `Optimized tokens (est): ${savings.total_optimized_tokens}`,
    `Total tokens saved    : ${savings.total_estimated_saved_tokens}`,
    `File cache hits       : ${savings.total_cache_hits ?? 0}`,
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
};
