/**
 * .claude/utils/memoryDecay.js
 *
 * Memory Item Schema and Decay Engine (V3)
 *
 * Solves the "wrong-context retention" problem:
 *   - Old implementation details surviving after direction changed
 *   - Outdated constraints remaining in rebuild memory
 *   - Earlier failed approaches continuing to influence later turns
 *   - Stale files staying pinned long after they're irrelevant
 *
 * Each memory item is now:
 *   { value, type, confidence, turn, last_seen_turn, superseded }
 *
 * Three mechanisms that eliminate stale context:
 *
 *   1. CONFIDENCE DECAY — items lose confidence each turn they aren't reinforced.
 *      Items that haven't appeared in the prompt for 10+ turns fade away naturally.
 *      Floor at MIN_EFFECTIVE_CONF so old items don't become negative.
 *
 *   2. SUPERSEDED DETECTION — when a new item explicitly contradicts an old one
 *      ("switched from X", "instead of X", "no longer using X"), the old item
 *      is immediately marked superseded and excluded from rebuild context.
 *
 *   3. TASK SHIFT RESET — when the new prompt has very low word overlap with
 *      the established goal AND current task, the session has likely pivoted.
 *      Task-specific memory is cleared; project-wide rules are kept.
 *
 * BACKWARD COMPAT: normalizeToItems() handles both legacy string[] and new
 * MemoryItem[]. Old sessions load cleanly without schema migration.
 *
 * This module has no I/O. Pure functions only.
 */

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

// Confidence degradation per turn without reinforcement.
// After 10 turns: 0.9 → 0.9 - (10 × 0.03) = 0.6. After 20: 0.6 - 0.3 = 0.3 (near floor).
const DECAY_PER_TURN     = 0.03;

// Effective confidence floor from decay alone. Superseded items return 0.
const MIN_EFFECTIVE_CONF = 0.10;

// Items with effective confidence below this are pruned from memory entirely.
const PRUNE_THRESHOLD    = 0.15;

// Word overlap below this → task has likely shifted
// (fraction of shared 4+ char words between new prompt and existing goal/task)
const TASK_SHIFT_OVERLAP = 0.10;

// Don't detect task shifts in the first N turns — session context still forming
const MIN_TURN_FOR_SHIFT = 5;

// ─── Item Schema ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   value:          string,   — the extracted phrase
 *   type:           string,   — "decision"|"constraint"|"known_issue"|"important_file"
 *   confidence:     number,   — 0.0–1.0, set at extraction time
 *   turn:           number,   — turn when first extracted
 *   last_seen_turn: number,   — last turn this item appeared in prompt
 *   superseded:     boolean,  — true if a later item explicitly replaces this one
 * }} MemoryItem
 */

/**
 * Create a new MemoryItem.
 * @param {string} value
 * @param {string} type
 * @param {number} confidence — 0.0–1.0
 * @param {number} turn       — current session turn
 * @returns {MemoryItem}
 */
function createMemoryItem(value, type, confidence, turn) {
  return {
    value,
    type,
    confidence:     clamp(confidence, 0.0, 1.0),
    turn:           turn || 0,
    last_seen_turn: turn || 0,
    superseded:     false,
  };
}

// ─── Normalization (backward compat) ─────────────────────────────────────────

/**
 * Convert a mixed array of strings (legacy) or MemoryItems to a clean MemoryItem[].
 * Legacy strings get confidence=0.7 (medium — they existed before scoring was added).
 *
 * @param {Array<string|MemoryItem>} arr
 * @param {string} type
 * @param {number} currentTurn
 * @returns {MemoryItem[]}
 */
function normalizeToItems(arr, type, currentTurn) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (typeof item === "string") {
        // Legacy string — treat as medium-confidence item from an earlier turn
        const turn = Math.max(0, currentTurn - 1);
        return createMemoryItem(item, type, 0.7, turn);
      }
      // Already a MemoryItem — ensure all required fields exist
      return {
        value:          String(item.value          ?? ""),
        type:           String(item.type           ?? type),
        confidence:     clamp(Number(item.confidence ?? 0.7), 0, 1),
        turn:           Number(item.turn           ?? 0),
        last_seen_turn: Number(item.last_seen_turn ?? item.turn ?? 0),
        superseded:     Boolean(item.superseded    ?? false),
      };
    })
    .filter((item) => item.value.trim().length > 0);
}

// ─── Confidence Decay ─────────────────────────────────────────────────────────

/**
 * Compute the effective confidence of an item at the current turn.
 *
 * Superseded items always return 0.
 * Otherwise: confidence decays linearly per unreinforced turn, floored at MIN.
 *
 * @param {MemoryItem} item
 * @param {number} currentTurn
 * @returns {number} — 0.0 to 1.0
 */
function computeEffectiveConfidence(item, currentTurn) {
  if (item.superseded) return 0;
  const turnsSince = Math.max(0, currentTurn - (item.last_seen_turn ?? item.turn ?? 0));
  const decayed    = item.confidence - turnsSince * DECAY_PER_TURN;
  return Math.max(MIN_EFFECTIVE_CONF, decayed);
}

// ─── Superseded Detection ─────────────────────────────────────────────────────

// Patterns that signal the user is explicitly replacing a prior decision/approach.
// The first capture group is the term being replaced (what we search for in existing items).
const SUPERSEDE_PATTERNS = [
  /instead of (\w+)/gi,
  /no longer (?:using |use )?(\w+)/gi,
  /switching from (\w+)/gi,
  /switched from (\w+)/gi,
  /replaced (\w+)/gi,
  /replacing (\w+)/gi,
  /dropped (\w+)/gi,
  /removing (\w+)/gi,
  /moved away from (\w+)/gi,
];

/**
 * Check if a new item supersedes any existing items and mark them in-place.
 * Searches each supersede pattern against the new item's value, extracts the
 * replaced term, and marks any existing item containing that term as superseded.
 *
 * Mutates existingItems.
 *
 * @param {MemoryItem[]} existingItems
 * @param {MemoryItem}   newItem
 */
function applySupersededDetection(existingItems, newItem) {
  const newLower = newItem.value.toLowerCase();

  for (const pattern of SUPERSEDE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(newLower)) !== null) {
      const replaced = match[1].toLowerCase().trim();
      if (replaced.length < 3) continue;  // skip noise like "it", "be"

      for (const existing of existingItems) {
        if (existing.superseded) continue;
        if (existing.value.toLowerCase().includes(replaced)) {
          existing.superseded = true;
        }
      }
    }
  }
}

// ─── Merge and Prune ─────────────────────────────────────────────────────────

/**
 * Merge fresh MemoryItems into existing items with:
 *   - Superseded detection (new item may invalidate old ones)
 *   - Reinforcement (same value seen again → update last_seen_turn + raise confidence)
 *   - Pruning (remove superseded + below-threshold items)
 *   - Cap at maxLen (keep most recent)
 *
 * @param {MemoryItem[]} existing    — current session items (already normalized)
 * @param {MemoryItem[]} fresh       — items extracted this turn
 * @param {number}       currentTurn
 * @param {number}       maxLen
 * @returns {MemoryItem[]}
 */
function mergeAndPruneItems(existing, fresh, currentTurn, maxLen) {
  const merged = [...existing];

  for (const newItem of fresh) {
    // Check if newItem supersedes any existing item
    applySupersededDetection(merged, newItem);

    // Check for exact-value match (reinforce existing item rather than duplicate)
    const existingIdx = merged.findIndex(
      (e) => !e.superseded &&
              e.value.toLowerCase().trim() === newItem.value.toLowerCase().trim()
    );

    if (existingIdx >= 0) {
      // Reinforce: update last_seen and take the higher confidence
      merged[existingIdx].last_seen_turn = currentTurn;
      merged[existingIdx].confidence     = Math.max(
        merged[existingIdx].confidence,
        newItem.confidence
      );
    } else {
      merged.push(newItem);
    }
  }

  // Prune superseded + below-threshold items
  const pruned = merged.filter((item) => {
    if (item.superseded) return false;
    return computeEffectiveConfidence(item, currentTurn) >= PRUNE_THRESHOLD;
  });

  // Cap at maxLen (keep most recent)
  return pruned.slice(-maxLen);
}

/**
 * Prune an existing items array in-place (no new items to merge).
 * Used when restoring memory on load.
 *
 * @param {MemoryItem[]} items
 * @param {number}       currentTurn
 * @returns {MemoryItem[]}
 */
function pruneMemoryItems(items, currentTurn) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    if (item.superseded) return false;
    return computeEffectiveConfidence(item, currentTurn) >= PRUNE_THRESHOLD;
  });
}

// ─── Task Shift Detection ─────────────────────────────────────────────────────

/**
 * Compute the fraction of shared 4+ char words between two texts.
 * Filters stopwords by requiring minimum word length.
 * Returns 0–1 (1 = identical vocabulary).
 *
 * @param {string} text1
 * @param {string} text2
 * @returns {number}
 */
function wordOverlap(text1, text2) {
  const words1 = new Set((text1.toLowerCase().match(/\b\w{4,}\b/g)) ?? []);
  const words2 = new Set((text2.toLowerCase().match(/\b\w{4,}\b/g)) ?? []);
  if (words1.size === 0 || words2.size === 0) return 0;
  let shared = 0;
  for (const w of words1) { if (words2.has(w)) shared++; }
  return shared / Math.min(words1.size, words2.size);
}

/**
 * Detect if the current prompt represents a significant topic shift
 * away from the established session goal and recent task.
 *
 * Conservative: only fires when BOTH goal and recent-task overlap are very low.
 * Does not fire in the first MIN_TURN_FOR_SHIFT turns.
 *
 * @param {object} memory     — session memory
 * @param {string} newPrompt
 * @param {number} currentTurn
 * @returns {boolean}
 */
function detectTaskShift(memory, newPrompt, currentTurn) {
  if (currentTurn < MIN_TURN_FOR_SHIFT) return false;
  if (!newPrompt || newPrompt.length < 20)  return false;

  const goal        = memory.goal         ?? "";
  const currentTask = memory.current_task ?? "";
  if (!goal && !currentTask)               return false;

  const overlapGoal = goal        ? wordOverlap(newPrompt, goal)        : 1;
  const overlapTask = currentTask ? wordOverlap(newPrompt, currentTask) : 1;

  return overlapGoal < TASK_SHIFT_OVERLAP && overlapTask < TASK_SHIFT_OVERLAP;
}

/**
 * Apply a task-shift reset to memory (mutates in place).
 *
 * Clears: known_issues (task-specific — irrelevant after pivot)
 * Decays: decisions (approach may have changed) → confidence × 0.4
 * Keeps:  constraints (project-wide rules that survive task changes)
 * Keeps:  important_files (the files still exist)
 * Updates: goal → new prompt is the new session anchor
 *
 * @param {object} memory
 * @param {string} newPrompt
 * @param {number} currentTurn
 */
function applyTaskShiftReset(memory, newPrompt, currentTurn) {
  // Clear task-specific issues — no longer relevant
  memory.known_issues = [];

  // Heavily decay decisions — the approach context may have changed
  if (Array.isArray(memory.decisions)) {
    memory.decisions = memory.decisions
      .map((item) => {
        if (typeof item === "string") {
          // Legacy string — convert and heavily decay
          return createMemoryItem(item, "decision", 0.3, currentTurn);
        }
        return { ...item, confidence: item.confidence * 0.4 };
      })
      .filter((item) =>
        computeEffectiveConfidence(item, currentTurn) >= PRUNE_THRESHOLD
      );
  }

  // Update goal to reflect the new task anchor
  memory.goal = newPrompt.slice(0, 200).replace(/\n/g, " ");
}

// ─── Render Helper ────────────────────────────────────────────────────────────

/**
 * Extract plain string values from a MemoryItem[] for rendering in context blocks.
 * Filters out superseded and below-threshold items.
 * Handles legacy string[] transparently.
 *
 * @param {Array<string|MemoryItem>} items
 * @param {number} currentTurn
 * @param {number} threshold — defaults to PRUNE_THRESHOLD
 * @returns {string[]}
 */
function toActiveValues(items, currentTurn, threshold = PRUNE_THRESHOLD) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => {
      if (typeof item === "string") return true; // legacy strings always shown
      if (item.superseded) return false;
      return computeEffectiveConfidence(item, currentTurn) >= threshold;
    })
    .map((item) => (typeof item === "string" ? item : item.value));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, Number(val) || 0));
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  createMemoryItem,
  normalizeToItems,
  computeEffectiveConfidence,
  applySupersededDetection,
  mergeAndPruneItems,
  pruneMemoryItems,
  detectTaskShift,
  applyTaskShiftReset,
  toActiveValues,
  wordOverlap,
  // Constants exposed for tests and calibration
  DECAY_PER_TURN,
  PRUNE_THRESHOLD,
  MIN_EFFECTIVE_CONF,
  TASK_SHIFT_OVERLAP,
  MIN_TURN_FOR_SHIFT,
};
