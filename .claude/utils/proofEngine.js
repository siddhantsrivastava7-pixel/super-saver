/**
 * .claude/utils/proofEngine.js
 *
 * Proof Engine — Credible Before-vs-After Token Estimates
 *
 * Answers: "What would this session have cost without Super Saver?"
 *
 * DESIGN PRINCIPLE: Trustworthy over impressive.
 * Numbers are derived directly from measured savings data, not invented.
 * Every estimate traces to a concrete, documented formula.
 *
 * ─── Key Invariants (always enforced) ────────────────────────────────────────
 *   total_saved   = total_without - total_with             (never negative)
 *   efficiency %  = total_saved / total_without × 100      (0–100 range)
 *   total_without ≥ total_with                             (cannot go negative)
 *   total_without = total_optimized + total_saved          (derived from savings.js)
 *
 * ─── Where numbers come from ─────────────────────────────────────────────────
 *   total_with    = memory.savings.total_optimized_tokens  (tokens actually sent)
 *   total_saved   = memory.savings.total_estimated_saved_tokens (accumulated savings)
 *   total_without = total_with + total_saved               (what would have been sent)
 *
 * No separate counters needed. All fields come from savings.js which already
 * computes correct cumulative totals using additive turnStats accumulation.
 *
 * This module has no I/O. Pure functions only.
 */

"use strict";

// ─── Session-Level Proof ──────────────────────────────────────────────────────

/**
 * Derive session proof from cumulative savings.
 * All invariants are guaranteed by derivation, not checked after the fact.
 *
 * @param {object} savings — memory.savings from updateSavings()
 * @returns {{
 *   estimated_total_tokens_without_optimizer: number,
 *   estimated_total_tokens_with_optimizer:    number,
 *   estimated_total_tokens_saved:             number,
 *   estimated_efficiency_percent:             number,
 * }}
 */
function computeSessionProof(savings) {
  // with = what was actually sent: optimized prompt tokens + additionalContext tokens.
  // Prefer the new total_with_tokens (set when additionalContextChars is tracked).
  // Fall back to total_optimized_tokens for sessions that predate the fix — those
  // sessions will still show inflated efficiency, but new sessions will be honest.
  const total_with = Math.max(
    0,
    savings?.total_with_tokens ?? savings?.total_optimized_tokens ?? 0
  );

  // saved = accumulation of all five savings categories
  const total_saved = Math.max(0, savings?.total_estimated_saved_tokens ?? 0);

  // without = what would have been sent without any optimization.
  // Derived: without = with + saved. Invariant: without >= with.
  const total_without = total_with + total_saved;

  // efficiency = fraction of would-be tokens that were cut
  const efficiency_pct = total_without > 0
    ? Math.round((total_saved / total_without) * 100)
    : 0;

  return {
    estimated_total_tokens_without_optimizer: total_without,
    estimated_total_tokens_with_optimizer:    total_with,
    estimated_total_tokens_saved:             total_saved,
    estimated_efficiency_percent:             Math.min(100, efficiency_pct),
  };
}

// ─── Per-Turn Proof ───────────────────────────────────────────────────────────

/**
 * Compute per-turn before/after for telemetry log entries.
 * Uses turnStats from savings.js (the per-turn delta, not session total).
 *
 * @param {{
 *   optimizedChars: number,  — post-optimization prompt char count
 *   turnStats:      object,  — per-turn deltas from savings.js
 * }} input
 * @returns {{
 *   without_tokens: number,
 *   with_tokens:    number,
 *   saved_tokens:   number,
 * }}
 */
function computeTurnProof({ optimizedChars = 0, turnStats = {} }) {
  const prompt_tokens  = Math.ceil(optimizedChars / 4);
  // Include per-turn additionalContext chars (tracked since V4 fix).
  const context_tokens = Math.ceil((turnStats?.additional_context_chars ?? 0) / 4);
  const with_tokens    = prompt_tokens + context_tokens;
  const saved_tokens   = Math.max(0, turnStats?.total_saved ?? 0);
  const without_tokens = with_tokens + saved_tokens;
  return { without_tokens, with_tokens, saved_tokens };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a one-line proof summary for the [SUPER SAVER] telemetry block.
 * Returns empty string if no data yet (before any savings accumulate).
 *
 * @param {object} proof — return value of computeSessionProof()
 * @returns {string}
 */
function formatProofLine(proof) {
  const {
    estimated_total_tokens_without_optimizer: without,
    estimated_total_tokens_with_optimizer:    with_,
    estimated_total_tokens_saved:             saved,
    estimated_efficiency_percent:             pct,
  } = proof;

  if (without === 0 || saved === 0) return "";
  return `${saved} tokens saved | ${without} → ${with_} (${pct}% efficiency)`;
}

/**
 * Validate that proof invariants hold.
 * Returns null if valid, error string if violated.
 * Used by tests and debug logging.
 *
 * @param {object} proof — return value of computeSessionProof()
 * @returns {string|null}
 */
function validateProof(proof) {
  const {
    estimated_total_tokens_without_optimizer: without,
    estimated_total_tokens_with_optimizer:    with_,
    estimated_total_tokens_saved:             saved,
    estimated_efficiency_percent:             pct,
  } = proof;

  if (without < with_)         return `INVARIANT: without (${without}) < with (${with_})`;
  if (without - with_ !== saved) return `INVARIANT: without-with (${without-with_}) ≠ saved (${saved})`;
  if (pct < 0 || pct > 100)   return `INVARIANT: efficiency ${pct}% out of range`;
  if (saved < 0)               return `INVARIANT: saved (${saved}) is negative`;
  return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  computeSessionProof,
  computeTurnProof,
  formatProofLine,
  validateProof,
};
