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
 *   "constraints": [],      // User-set constraints (populated externally)
 *   "recent_files": [],     // Last 10 files touched (strings)
 *   "known_failures": [],   // Last 5 failure records
 *   "last_verification_command": "",
 *   "last_verification_result": "",  // "success" | "failure" | ""
 *   "last_successful_pattern": "",
 *   "read_registry": {},    // { absPath: { hash, summary, symbols, lastUsedTurn, ... } }
 *   "savings": {
 *     "prompts_processed": 0,
 *     "total_estimated_saved_tokens": 0,
 *     "total_original_tokens": 0,
 *     "total_optimized_tokens": 0,
 *     "total_cache_hits": 0
 *   }
 * }
 */

"use strict";

const fs = require("fs");
const path = require("path");

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
    constraints: [],
    recent_files: [],
    known_failures: [],
    last_verification_command: "",
    last_verification_result: "",
    last_successful_pattern: "",
    read_registry: {},
    savings: {
      prompts_processed: 0,
      total_estimated_saved_tokens: 0,
      total_original_tokens: 0,
      total_optimized_tokens: 0,
      total_cache_hits: 0,
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
