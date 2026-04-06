/**
 * .claude/utils/toolTracker.js
 *
 * Tool Awareness Engine
 *
 * Reduces hidden waste from unnecessary tool-heavy behavior.
 *
 * Two mechanisms:
 *   1. Task-type suppression — lightweight tasks get [TOOL USAGE POLICY]
 *      injected to prevent unnecessary file reads and bash calls.
 *   2. Repeated-read detection — sessions with many repeated file accesses
 *      get [TOOL OPTIMIZATION] injected to encourage cache reuse.
 *
 * Tool stats tracked per-session:
 *   tool_calls_estimate     — estimated external tool invocations
 *   file_reads_estimate     — files considered by the pipeline
 *   redundant_reads_estimate — files that were cache hits (would-be re-reads)
 *   tool_suppressed_turns   — turns where suppression was injected
 *
 * Philosophy:
 *   - Never suppress complex tasks (code-fix, implementation, refactor, etc.)
 *   - Signal only — we inject hints, not hard constraints
 *   - Lightweight: only task type + read registry patterns needed
 *   - Non-fatal: failures return empty blocks
 *
 * This module has no I/O. Pure functions only.
 */

"use strict";

// ─── Task Classification ──────────────────────────────────────────────────────

// Tasks where Claude rarely needs to call tools.
// Injecting suppression here prevents unnecessary file reads for Q&A.
const LIGHTWEIGHT_TASKS = new Set([
  "explanation",
  "default",
]);

// Tasks that legitimately need tools — never suppress these.
const COMPLEX_TASKS = new Set([
  "code-fix",
  "implementation",
  "test",
  "refactor",
  "review",
  "multi-step",
]);

// ─── Thresholds ───────────────────────────────────────────────────────────────

// Number of registry entries with repeat access before injecting optimization hint
const REPEATED_READ_THRESHOLD = 3;

// ─── Blocks ───────────────────────────────────────────────────────────────────

const SUPPRESSION_BLOCK = [
  "[TOOL USAGE POLICY]",
  "Do not use tools unless strictly necessary.",
  "Prefer reasoning from existing context.",
  "Avoid re-reading unchanged files.",
].join("\n");

const OPTIMIZATION_BLOCK = [
  "[TOOL OPTIMIZATION]",
  "This session has repeated file access.",
  "Reuse cached understanding unless a fresh read is required.",
].join("\n");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count how many registry entries have been accessed in more than one turn.
 * A file with lastUsedTurn > 1 has been re-accessed after its first read.
 *
 * @param {object} readRegistry — memory.read_registry
 * @param {number} currentTurn
 * @returns {number}
 */
function countRepeatedReads(readRegistry, currentTurn) {
  if (!readRegistry || typeof readRegistry !== "object" || currentTurn <= 2) return 0;
  let count = 0;
  for (const entry of Object.values(readRegistry)) {
    if ((entry?.lastUsedTurn ?? 0) > 1) count++;
  }
  return count;
}

/**
 * Estimate tool calls for this turn.
 * Conservative: each cache miss = 1 file-read tool call.
 * Complex tasks may also involve 1 additional bash/run call.
 *
 * @param {string}   taskType
 * @param {number}   fileMisses   — files not served from cache
 * @returns {number}
 */
function estimateToolCalls(taskType, fileMisses) {
  const baseCalls   = Math.max(0, fileMisses);
  const complexBonus = COMPLEX_TASKS.has(taskType) ? 1 : 0;
  return baseCalls + complexBonus;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Analyze tool behavior for this turn.
 *
 * @param {{
 *   taskType:      string,   — classified task type from outputPolicy
 *   readRegistry:  object,   — memory.read_registry
 *   relevantFiles: string[], — files identified this turn
 *   cacheHits:     number,   — files served from cache
 *   currentTurn:   number,
 * }} opts
 * @returns {{
 *   suppressionBlock:  string,   — [TOOL USAGE POLICY] or ""
 *   optimizationHint:  string,   — [TOOL OPTIMIZATION] or ""
 *   stats: {
 *     is_suppressed:          boolean,
 *     has_repeated_reads:     boolean,
 *     repeated_read_count:    number,
 *     file_reads_this_turn:   number,
 *     redundant_reads:        number,
 *     tool_calls_estimate:    number,
 *   },
 * }}
 */
function analyzeToolBehavior({ taskType, readRegistry, relevantFiles, cacheHits, currentTurn }) {
  try {
    const is_lightweight = LIGHTWEIGHT_TASKS.has(taskType);
    const suppressionBlock = is_lightweight ? SUPPRESSION_BLOCK : "";

    const repeatedCount  = countRepeatedReads(readRegistry, currentTurn);
    const has_repeated   = repeatedCount >= REPEATED_READ_THRESHOLD;
    const optimizationHint = has_repeated ? OPTIMIZATION_BLOCK : "";

    const file_reads_this_turn = relevantFiles?.length ?? 0;
    const redundant_reads      = Math.max(0, cacheHits ?? 0);
    const fileMisses           = Math.max(0, file_reads_this_turn - redundant_reads);
    const tool_calls_estimate  = estimateToolCalls(taskType, fileMisses);

    return {
      suppressionBlock,
      optimizationHint,
      stats: {
        is_suppressed:       is_lightweight,
        has_repeated_reads:  has_repeated,
        repeated_read_count: repeatedCount,
        file_reads_this_turn,
        redundant_reads,
        tool_calls_estimate,
      },
    };
  } catch {
    return {
      suppressionBlock: "",
      optimizationHint: "",
      stats: {
        is_suppressed:       false,
        has_repeated_reads:  false,
        repeated_read_count: 0,
        file_reads_this_turn: 0,
        redundant_reads:     0,
        tool_calls_estimate: 0,
      },
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  analyzeToolBehavior,
  countRepeatedReads,
  estimateToolCalls,
  LIGHTWEIGHT_TASKS,
  COMPLEX_TASKS,
  REPEATED_READ_THRESHOLD,
};
