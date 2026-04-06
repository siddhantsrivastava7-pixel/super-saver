/**
 * .claude/utils/lifecycle.js
 *
 * Lifecycle Optimization Engine
 *
 * Detects session lifecycle state across three axes and emits the minimal
 * configuration needed to keep context lean on every turn:
 *
 *   ┌─────────────────────┬──────────────────────────┬──────────────┐
 *   │  Condition          │  Mode                    │  Compression │
 *   ├─────────────────────┼──────────────────────────┼──────────────┤
 *   │  idle_gap > 5 min   │  rebuild                 │  HIGH (2)    │
 *   │  turn > 15          │  compact                 │  HIGH (2)    │
 *   │  turn ≤ 3 (new)     │  normal                  │  LOW  (6)    │
 *   │  otherwise          │  normal                  │  MEDIUM (4)  │
 *   └─────────────────────┴──────────────────────────┴──────────────┘
 *
 * Modes:
 *   normal  — standard compression + full context injection
 *   compact — aggressive compression, [SESSION COMPACT MODE] header
 *   rebuild — full history bypassed, minimal [SESSION REBUILD] context only
 *
 * Tool policy:
 *   For lightweight tasks (explanation, small edits, formatting) inject
 *   [TOOL USAGE POLICY] to discourage unnecessary tool calls.
 *
 * Debug output (internal only, never user-visible):
 *   .claude/logs/lifecycle-debug.log
 *
 * INVARIANT: All functions are non-fatal. Lifecycle failures must never
 * propagate to the caller — the pipeline treats them as mode="normal".
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const { buildStructuredRebuildContext } = require(path.join(__dirname, "smartMemory.js"));

// ─── Constants ────────────────────────────────────────────────────────────────

// If > 5 minutes have elapsed since the last turn, the model's cache has
// very likely expired. Rebuilding from memory is cheaper than re-sending
// the full history.
const IDLE_GAP_THRESHOLD_MS = 5 * 60 * 1000;

// Sessions longer than this trigger compact mode — aggressive compression
// to prevent context from ballooning across a long coding session.
const LONG_SESSION_TURNS = 15;

// Maps compression level names to RECENT_WINDOW integers for compressor.js
//   LOW    — newer/short sessions: keep more verbatim turns
//   MEDIUM — default: last 4 turns
//   HIGH   — idle gap or long session: only last 2 turns + summary
const COMPRESSION_WINDOWS = { LOW: 6, MEDIUM: 4, HIGH: 2 };

// Task types that benefit from tool constraint injection
// (simple tasks rarely need external tool calls)
const LIGHTWEIGHT_TASK_TYPES = new Set([
  "explanation",
  "simple-fix",
  "formatting",
  "small-edit",
  "default",
]);

// Estimated token savings per lifecycle intervention
// These are conservative estimates based on typical session sizes.
const TOKENS_SAVED_REBUILD = 2000; // full history (~8KB avg) replaced by ~50-token summary
const TOKENS_SAVED_COMPACT = 360;  // 2 fewer verbatim messages × 180 tokens each

// ─── Debug Log ────────────────────────────────────────────────────────────────

const DEBUG_LOG = path.resolve(__dirname, "../logs/lifecycle-debug.log");

function debugLog(msg) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ─── State Detection ─────────────────────────────────────────────────────────

/**
 * Detect the current lifecycle state from memory and turn count.
 *
 * @param {object} memory       - loaded session memory
 * @param {number} currentTurn  - prompts_processed + 1
 * @returns {{
 *   mode:                  "normal"|"compact"|"rebuild",
 *   compressionLevel:      "LOW"|"MEDIUM"|"HIGH",
 *   idleGapMs:             number,
 *   idleGapMin:            string,
 *   isIdleGap:             boolean,
 *   isLongSession:         boolean,
 *   estimatedSavedTokens:  number,
 * }}
 */
function detectLifecycleState(memory, currentTurn) {
  try {
    const now       = Date.now();
    const lastTs    = memory.last_turn_timestamp || 0;
    const idleGapMs = lastTs > 0 ? Math.max(0, now - lastTs) : 0;
    const isIdleGap      = idleGapMs > IDLE_GAP_THRESHOLD_MS;
    const isLongSession  = currentTurn > LONG_SESSION_TURNS;

    let mode                 = "normal";
    let compressionLevel     = "MEDIUM";
    let estimatedSavedTokens = 0;

    if (isIdleGap) {
      mode                 = "rebuild";
      compressionLevel     = "HIGH";
      estimatedSavedTokens = TOKENS_SAVED_REBUILD;
    } else if (isLongSession) {
      mode                 = "compact";
      compressionLevel     = "HIGH";
      estimatedSavedTokens = TOKENS_SAVED_COMPACT;
    } else if (currentTurn <= 3) {
      // New session: keep more verbatim turns for richer context
      compressionLevel = "LOW";
    }

    const state = {
      mode,
      compressionLevel,
      idleGapMs,
      idleGapMin: (idleGapMs / 60000).toFixed(1),
      isIdleGap,
      isLongSession,
      estimatedSavedTokens,
    };

    debugLog(
      `[LIFECYCLE] mode=${mode} idle_gap=${state.idleGapMin}min ` +
      `turn=${currentTurn} compression=${compressionLevel} ` +
      `saved_est=${estimatedSavedTokens}`
    );

    return state;
  } catch {
    // Non-fatal fallback — normal mode, no optimization
    return {
      mode:                 "normal",
      compressionLevel:     "MEDIUM",
      idleGapMs:            0,
      idleGapMin:           "0.0",
      isIdleGap:            false,
      isLongSession:        false,
      estimatedSavedTokens: 0,
    };
  }
}

// ─── Context Builders ─────────────────────────────────────────────────────────

/**
 * Build a structured context block for rebuild mode.
 *
 * Delegates to smartMemory.buildStructuredRebuildContext() which produces a
 * full Goal → Decisions → Constraints → Known Issues → Files block using
 * the V2 structured memory fields. Falls back to a minimal block if
 * smartMemory is unavailable.
 *
 * @param {object} memory - loaded session memory (v2 schema with v3 fields)
 * @returns {string}
 */
function buildRebuildContext(memory) {
  try {
    return buildStructuredRebuildContext(memory);
  } catch {
    // Graceful fallback — basic block using only v1 fields
    const lines = ["[SESSION REBUILD]"];
    if (memory.goal)         lines.push(`Goal: ${memory.goal}`);
    if (memory.current_task) lines.push(`Current Task: ${memory.current_task}`);
    if (memory.last_summary) lines.push(`\nLast Summary: ${memory.last_summary}`);
    if (lines.length === 1)  lines.push("(resuming session)");
    return lines.join("\n");
  }
}

/**
 * Build the [SESSION COMPACT MODE] header for long sessions.
 * Prefixed onto the existing context block (not a replacement).
 *
 * @returns {string}
 */
function buildCompactHeader() {
  return [
    "[SESSION COMPACT MODE]",
    "Previous conversation has been compacted for efficiency.",
    "Use summary context instead of full history.",
  ].join("\n");
}

/**
 * Get a tool usage policy block based on task type.
 * Returns empty string for complex tasks (no constraint needed).
 *
 * @param {string} taskType - from outputPolicy classification
 * @returns {string}
 */
function getToolUsagePolicy(taskType) {
  if (LIGHTWEIGHT_TASK_TYPES.has(taskType)) {
    return [
      "[TOOL USAGE POLICY]",
      "Do NOT use external tools unless strictly required.",
      "Prefer reasoning from provided context.",
    ].join("\n");
  }
  return "";
}

/**
 * Map a compression level to a RECENT_WINDOW integer for compressor.js.
 *
 * @param {"LOW"|"MEDIUM"|"HIGH"} level
 * @returns {number}
 */
function getCompressionWindow(level) {
  return COMPRESSION_WINDOWS[level] ?? COMPRESSION_WINDOWS.MEDIUM;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  detectLifecycleState,
  buildRebuildContext,
  buildCompactHeader,
  getToolUsagePolicy,
  getCompressionWindow,
};
