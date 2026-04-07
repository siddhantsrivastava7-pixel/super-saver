/**
 * .claude/utils/memory.js  (v2 — UPGRADED)
 *
 * Structured Persistent Session Memory
 *
 * Stores the minimal state needed to provide context across turns:
 *   - What the user is trying to accomplish (goal, current_task)
 *   - Which files have been touched (recent_files)
 *   - What has failed (known_failures — compact, capped)
 *   - What worked last (last_successful_pattern)
 *   - File read registry (read_registry — populated by diffPolicy)
 *   - Savings stats (savings — from savings.js)
 *
 * BACKWARD COMPATIBILITY:
 *   Old memory.json format (v1) had flat fields: promptCount, totalOriginalChars, etc.
 *   The migrateIfNeeded() function maps those to the new schema transparently.
 *   No data is lost; old sessions continue working.
 *
 * Schema (v2):
 * {
 *   "schema_version": 2,
 *   "session_started": "ISO",
 *   "last_updated": "ISO",
 *   "goal": "",             // First prompt, used as session anchor
 *   "current_task": "",     // Most recent prompt
 *   "last_summary": "",     // One-line summary of last assistant action
 *   "constraints": [],      // User-stated rules / limits (smart memory)
 *   "decisions": [],        // Architectural/approach decisions (smart memory)
 *   "known_issues": [],     // Errors and problems mentioned (smart memory)
 *   "important_files": [],  // Files explicitly referenced (smart memory)
 *   "recent_files": [],     // Last 10 files touched (strings)
 *   "known_failures": [],   // Last 5 failure records
 *   "last_verification_command": "",
 *   "last_verification_result": "",  // "success" | "failure" | ""
 *   "last_successful_pattern": "",
 *   "read_registry": {},    // { absPath: { hash, summary, symbols, lastUsedTurn, ... } }
 *   "last_turn_timestamp": 0,      // ms epoch of last hook run (idle gap detection)
 *   "idle_gap_ms": 0,              // ms elapsed since last turn (set each run)
 *   "session_mode": "normal",      // "normal" | "compact" | "rebuild"
 *   "savings": {
 *     "prompts_processed": 0,
 *     "total_estimated_saved_tokens": 0,
 *     "total_original_tokens": 0,
 *     "total_optimized_tokens": 0,
 *     "total_cache_hits": 0,
 *     "lifecycle_saved_tokens": 0
 *   }
 * }
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  normalizeToItems,
  mergeAndPruneItems,
  detectTaskShift,
  applyTaskShiftReset,
} = require(path.join(__dirname, "memoryDecay.js"));

// ─── Path ─────────────────────────────────────────────────────────────────────

const MEMORY_FILE = path.resolve(__dirname, "../hooks/.session-memory.json");

// ─── Defaults ─────────────────────────────────────────────────────────────────

function defaultMemory() {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    session_started: now,
    last_updated: now,
    goal: "",
    current_task: "",
    last_summary: "",
    // V2 Smart Memory fields
    constraints:      [],   // User-stated rules/limits
    decisions:        [],   // Architectural/approach decisions
    known_issues:     [],   // Errors and problems mentioned
    important_files:  [],   // Files explicitly referenced in prompts
    recent_files:     [],
    known_failures:   [],
    last_verification_command: "",
    last_verification_result: "",
    last_successful_pattern: "",
    read_registry: {},
    // Lifecycle fields (added in v3 extension, backward-compatible)
    last_turn_timestamp: 0,
    idle_gap_ms:         0,
    session_mode:        "normal",
    // V5: Last classified task type — used by session strategy for next-turn comparison
    last_task_type:      "default",
    // V5: Last session strategy mode — for telemetry/debugging
    last_session_mode:   "continuation",
    savings: {
      prompts_processed:            0,
      total_estimated_saved_tokens: 0,
      total_original_tokens:        0,
      total_optimized_tokens:       0,
      total_cache_hits:             0,
      lifecycle_saved_tokens:       0,
    },
  };
}

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * Migrate v1 memory (flat stats fields) to v2 schema.
 * Called automatically on load when schema_version is missing or < 2.
 */
function migrateIfNeeded(raw) {
  // Already v2
  if (raw.schema_version >= 2) return raw;

  const migrated = defaultMemory();

  // Carry over fields that exist in both versions
  if (raw.sessionStarted)  migrated.session_started = raw.sessionStarted;
  if (raw.lastUpdated)     migrated.last_updated = raw.lastUpdated;
  if (raw.goal)            migrated.goal = raw.goal;

  // Migrate flat stats → savings sub-object
  if (raw.promptCount || raw.estimatedTokensSaved) {
    migrated.savings = {
      prompts_processed: raw.promptCount || 0,
      total_estimated_saved_tokens: raw.estimatedTokensSaved || 0,
      total_original_tokens: Math.ceil((raw.totalOriginalChars || 0) / 4),
      total_optimized_tokens: Math.ceil((raw.totalOptimizedChars || 0) / 4),
      total_cache_hits: 0,
    };
  }

  return migrated;
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
      const migrated = migrateIfNeeded(raw);
      // Merge with defaults to pick up any new fields added in future versions
      return { ...defaultMemory(), ...migrated };
    }
  } catch {
    // Corrupted or missing file — start fresh
  }
  return defaultMemory();
}

function saveMemory(mem) {
  try {
    const dir = path.dirname(MEMORY_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // Best-effort — never let a save failure break the hook
  }
}

// ─── Bounded Array Helpers ────────────────────────────────────────────────────

/** Deduplicate and cap an array, keeping the most recent entries. */
function cappedPush(arr, item, maxLen) {
  const deduped = arr.filter((x) => x !== item);
  return [...deduped, item].slice(-maxLen);
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Apply a full set of updates to memory from one hook run.
 * All fields are optional — only provided fields are updated.
 *
 * @param {object} mem - Loaded memory object (will be mutated)
 * @param {{
 *   prompt?: string,
 *   files?: string[],
 *   updatedRegistry?: object,
 *   updatedSavings?: object,
 *   verificationCommand?: string,
 *   verificationResult?: string,
 * }} updates
 * @returns {object} Updated memory (same reference)
 */
function applyUpdates(mem, updates) {
  const now = new Date().toISOString();
  mem.last_updated = now;

  if (updates.prompt) {
    mem.current_task = updates.prompt.slice(0, 200).replace(/\n/g, " ");
    if (!mem.goal) {
      mem.goal = mem.current_task;
    }
  }

  if (updates.files && updates.files.length > 0) {
    let recent = mem.recent_files ?? [];
    for (const f of updates.files) {
      recent = cappedPush(recent, f, 10);
    }
    mem.recent_files = recent;
  }

  if (updates.updatedRegistry) {
    mem.read_registry = updates.updatedRegistry;
  }

  if (updates.updatedSavings) {
    mem.savings = updates.updatedSavings;
  }

  if (updates.verificationCommand !== undefined) {
    mem.last_verification_command = updates.verificationCommand;
  }

  if (updates.verificationResult !== undefined) {
    mem.last_verification_result = updates.verificationResult;
  }

  // Persist lifecycle state so idle gap can be computed on the next turn.
  // last_turn_timestamp is always refreshed to now (the time of saving).
  if (updates.lifecycleState !== undefined) {
    mem.last_turn_timestamp = Date.now();
    mem.idle_gap_ms         = updates.lifecycleState.idleGapMs  || 0;
    mem.session_mode        = updates.lifecycleState.mode       || "normal";
  }

  // V5: Store last task type and session mode for next-turn strategy comparison.
  if (updates.taskType) {
    mem.last_task_type    = updates.taskType;
  }
  if (updates.sessionMode) {
    mem.last_session_mode = updates.sessionMode;
  }

  // V3: Smart memory — merge extracted MemoryItem[] into existing items with
  // confidence decay, superseded detection, and prune. Handles legacy string[]
  // in existing memory transparently via normalizeToItems().
  if (updates.smartMemoryUpdate) {
    const sm   = updates.smartMemoryUpdate;
    const turn = updates.currentTurn ?? 0;

    // Task shift: reset task-specific memory BEFORE merging new items.
    // Triggers on V3 word-overlap detection OR V5 session strategy fresh-task mode.
    // applyTaskShiftReset clears known_issues and decays decisions × 0.4.
    if (sm.taskShifted || updates.strategyTriggeredReset) {
      applyTaskShiftReset(mem, updates.prompt || "", turn);
    }

    if (Array.isArray(sm.decisions)) {
      const existing = normalizeToItems(mem.decisions   ?? [], "decision",       turn);
      const fresh    = normalizeToItems(sm.decisions,          "decision",       turn);
      mem.decisions  = mergeAndPruneItems(existing, fresh, turn, 8);
    }
    if (Array.isArray(sm.constraints)) {
      const existing   = normalizeToItems(mem.constraints ?? [], "constraint",   turn);
      const fresh      = normalizeToItems(sm.constraints,        "constraint",   turn);
      mem.constraints  = mergeAndPruneItems(existing, fresh, turn, 6);
    }
    if (Array.isArray(sm.known_issues)) {
      const existing    = normalizeToItems(mem.known_issues ?? [], "known_issue", turn);
      const fresh       = normalizeToItems(sm.known_issues,        "known_issue", turn);
      mem.known_issues  = mergeAndPruneItems(existing, fresh, turn, 5);
    }
    if (Array.isArray(sm.important_files)) {
      const existing       = normalizeToItems(mem.important_files ?? [], "important_file", turn);
      const fresh          = normalizeToItems(sm.important_files,        "important_file", turn);
      mem.important_files  = mergeAndPruneItems(existing, fresh, turn, 10);
    }
  }

  return mem;
}

// ─── Legacy Compat: recordRun ─────────────────────────────────────────────────
// Kept for backward compatibility with any external callers of the old API.
// New code should use applyUpdates() instead.

function recordRun(stats) {
  const mem = loadMemory();
  applyUpdates(mem, {
    prompt: stats.prompt,
    files: [],
  });
  if (mem.savings) {
    mem.savings.prompts_processed += 1;
  }
  saveMemory(mem);
  return mem;
}

// ─── Legacy Compat: formatSavingsSummary ─────────────────────────────────────
// Kept for backward compatibility.

function formatSavingsSummary(mem) {
  const s = mem.savings;
  if (!s) return "";
  const totalSaved = s.total_estimated_saved_tokens || 0;
  const pct =
    s.total_original_tokens > 0
      ? ((totalSaved / s.total_original_tokens) * 100).toFixed(1)
      : "0.0";

  return [
    `SUPER SAVER session stats:`,
    `  Prompts optimized  : ${s.prompts_processed}`,
    `  Tokens saved (est) : ${totalSaved} (${pct}%)`,
    `  File cache hits    : ${s.total_cache_hits ?? 0}`,
  ].join("\n");
}

// ─── Reset ────────────────────────────────────────────────────────────────────

function resetMemory() {
  saveMemory(defaultMemory());
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  loadMemory,
  saveMemory,
  applyUpdates,
  recordRun,            // legacy compat
  formatSavingsSummary, // legacy compat
  resetMemory,
};
