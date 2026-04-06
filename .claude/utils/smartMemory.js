/**
 * .claude/utils/smartMemory.js
 *
 * Smart Memory Extraction Engine (V3 — MemoryItem output)
 *
 * Extracts structured, high-signal facts from the current prompt into
 * persistent memory fields. Rebuild and compact modes use this structured
 * memory to reconstruct context without replaying raw conversation history.
 *
 * V3 change: extraction functions now return MemoryItem[] with confidence
 * scores instead of plain string[]. buildStructuredRebuildContext accepts
 * currentTurn and uses toActiveValues() to filter by effective confidence
 * (decay + superseded checks). Legacy string[] in memory is handled
 * transparently by toActiveValues.
 *
 * Extracted fields:
 *   decisions        — architectural or approach choices detected this turn
 *   constraints      — rules, limits, or hard requirements stated by the user
 *   known_issues     — errors, bugs, and failures mentioned
 *   important_files  — file paths explicitly referenced in the prompt
 *
 * Confidence scoring:
 *   decisions     — strong commitment verb → 0.9, neutral phrasing → 0.75
 *   constraints   — hard trigger (must not/never/always) → 0.9, soft → 0.75
 *   known_issues  — explicit (error:/exception:) → 0.8, implicit → 0.65
 *   important_files → 0.8 (uniform — presence is clear signal)
 *
 * Design rules:
 *   - Keyword heuristics only — no ML, no API calls
 *   - Short phrases only — not raw sentences
 *   - Deduped and capped within extraction; cross-turn merge handled by mergeAndPruneItems
 *   - Non-fatal — extraction failure returns empty arrays
 *   - Pure function — no I/O
 */

"use strict";

const path = require("path");

const {
  createMemoryItem,
  toActiveValues,
} = require(path.join(__dirname, "memoryDecay.js"));

// ─── Caps ────────────────────────────────────────────────────────────────────

const MAX_DECISIONS       = 8;
const MAX_CONSTRAINTS     = 6;
const MAX_KNOWN_ISSUES    = 5;
const MAX_IMPORTANT_FILES = 10;
const MAX_PHRASE_CHARS    = 100;

// ─── Decision Extraction ─────────────────────────────────────────────────────

// Strong commitment verbs — phrase must contain one of these to be stored.
// Prevents hedging/speculation ("maybe try X") from polluting decisions.
const STRONG_DECISION_VERBS = [
  "decided",
  "going with",
  "switched",
  "chose",
  "replacing",
  "migrating",
  "moving to",
  "we'll use",
  "will use",
  "use instead",
];

// Weak hedging markers — if present WITHOUT a strong verb, phrase is discarded.
// "maybe we should try JWT" contains "try" but no strong verb → rejected.
const WEAK_MARKERS = [
  "maybe",
  "perhaps",
  "possibly",
  "might",
  "could try",
  "should try",
  "thinking about",
  "wondering",
  "considering",
  "what if",
  "what about",
];

// Trigger patterns used for initial phrase extraction
const DECISION_TRIGGERS = [
  "decided to",
  "going with",
  "switched to",
  "use instead",
  "instead of using",
  "chose",
  "replacing",
  "migrating to",
  "moving to",
  "we'll use",
  "will use",
];

/**
 * Returns true if the phrase is a confident decision, not speculation.
 * A phrase is hedged if it contains a weak marker but no strong commitment verb.
 *
 * @param {string} phrase — lowercased extracted phrase
 * @returns {boolean}
 */
function isConfidentDecision(phrase) {
  const lower = phrase.toLowerCase();
  const hasStrong = STRONG_DECISION_VERBS.some((v) => lower.includes(v));
  const hasWeak   = WEAK_MARKERS.some((w) => lower.includes(w));
  // Keep if strong verb is present, regardless of weak markers.
  // Reject only if weak marker present AND no strong verb.
  if (hasWeak && !hasStrong) return false;
  return true;
}

/**
 * Compute confidence score for a decision phrase.
 * Phrases anchored by a strong commitment verb get 0.9; neutral phrasing 0.75.
 * Only called on phrases that already passed isConfidentDecision.
 *
 * @param {string} phrase
 * @returns {number}
 */
function decisionConfidence(phrase) {
  const lower = phrase.toLowerCase();
  return STRONG_DECISION_VERBS.some((v) => lower.includes(v)) ? 0.9 : 0.75;
}

/**
 * Extract decision phrases from a prompt as MemoryItem[].
 * Only stores phrases that contain strong commitment verbs (not hedges/speculation).
 * @param {string} prompt
 * @param {number} currentTurn
 * @returns {MemoryItem[]}
 */
function extractDecisions(prompt, currentTurn = 0) {
  const lower = prompt.toLowerCase();
  const found = [];

  for (const trigger of DECISION_TRIGGERS) {
    let idx = 0;
    while ((idx = lower.indexOf(trigger, idx)) !== -1) {
      const snippet = prompt.slice(idx, idx + trigger.length + 60).trim();
      const phrase  = snippet.split(/[.!?\n]/)[0].trim().slice(0, MAX_PHRASE_CHARS);
      if (phrase.length > 8 && isConfidentDecision(phrase)) {
        found.push(phrase);
      }
      idx += trigger.length;
    }
  }

  const deduped = dedupStrings(found, MAX_DECISIONS);
  return deduped.map((v) =>
    createMemoryItem(v, "decision", decisionConfidence(v), currentTurn)
  );
}

// ─── Constraint Extraction ────────────────────────────────────────────────────

// Hard constraint triggers → high confidence (0.9) — absolute rules
const HARD_CONSTRAINT_TRIGGERS = [
  "must not",
  "never",
  "always",
];

const CONSTRAINT_TRIGGERS = [
  "don't",
  "do not",
  "must not",
  "never",
  "always",
  "avoid",
  "no external",
  "keep it",
  "only use",
  "no dependencies",
  "no third-party",
  "without adding",
];

/**
 * Compute confidence for a constraint phrase.
 * Hard constraints (must not/never/always) → 0.9; soft → 0.75.
 * @param {string} phrase
 * @returns {number}
 */
function constraintConfidence(phrase) {
  const lower = phrase.toLowerCase();
  return HARD_CONSTRAINT_TRIGGERS.some((t) => lower.includes(t)) ? 0.9 : 0.75;
}

/**
 * Extract constraint phrases from a prompt as MemoryItem[].
 * @param {string} prompt
 * @param {number} currentTurn
 * @returns {MemoryItem[]}
 */
function extractConstraints(prompt, currentTurn = 0) {
  const lower = prompt.toLowerCase();
  const found = [];

  for (const trigger of CONSTRAINT_TRIGGERS) {
    let idx = 0;
    while ((idx = lower.indexOf(trigger, idx)) !== -1) {
      const snippet = prompt.slice(idx, idx + trigger.length + 50).trim();
      const phrase  = snippet.split(/[.!?\n]/)[0].trim().slice(0, MAX_PHRASE_CHARS);
      if (phrase.length > 6) found.push(phrase);
      idx += trigger.length;
    }
  }

  const deduped = dedupStrings(found, MAX_CONSTRAINTS);
  return deduped.map((v) =>
    createMemoryItem(v, "constraint", constraintConfidence(v), currentTurn)
  );
}

// ─── Known Issues Extraction ─────────────────────────────────────────────────

// Explicit issue triggers → higher confidence (0.8) — exact signal
const EXPLICIT_ISSUE_TRIGGERS = [
  "error:",
  "exception:",
];

const ISSUE_TRIGGERS = [
  "error:",
  "exception:",
  "bug in",
  "issue with",
  "failing",
  "broken",
  "not working",
  "crashes when",
  "incorrect output",
  "wrong output",
  "regression in",
];

/**
 * Compute confidence for a known-issue phrase.
 * Explicit labels (error:/exception:) → 0.8; implicit → 0.65.
 * @param {string} phrase
 * @returns {number}
 */
function issueConfidence(phrase) {
  const lower = phrase.toLowerCase();
  return EXPLICIT_ISSUE_TRIGGERS.some((t) => lower.includes(t)) ? 0.8 : 0.65;
}

/**
 * Extract known-issue phrases from a prompt as MemoryItem[].
 * @param {string} prompt
 * @param {number} currentTurn
 * @returns {MemoryItem[]}
 */
function extractKnownIssues(prompt, currentTurn = 0) {
  const lower = prompt.toLowerCase();
  const found = [];

  for (const trigger of ISSUE_TRIGGERS) {
    let idx = 0;
    while ((idx = lower.indexOf(trigger, idx)) !== -1) {
      const snippet = prompt.slice(idx, idx + trigger.length + 60).trim();
      const phrase  = snippet.split(/[.!?\n]/)[0].trim().slice(0, MAX_PHRASE_CHARS);
      if (phrase.length > 6) found.push(phrase);
      idx += trigger.length;
    }
  }

  const deduped = dedupStrings(found, MAX_KNOWN_ISSUES);
  return deduped.map((v) =>
    createMemoryItem(v, "known_issue", issueConfidence(v), currentTurn)
  );
}

// ─── Important Files Extraction ───────────────────────────────────────────────

// Common source file extensions worth tracking
const FILE_PATTERN = /\b[\w\-./@]+\.(js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|json|yaml|yml|toml|md|sh|env|sql|css|scss)\b/gi;

// Noise patterns to exclude from file extraction
const FILE_NOISE  = /^(e\.g|etc|i\.e|vs|eg)$/i;

// Uniform confidence for file mentions — presence in prompt is clear signal
const FILE_CONFIDENCE = 0.8;

/**
 * Extract important file paths explicitly mentioned in the prompt as MemoryItem[].
 * @param {string} prompt
 * @param {number} currentTurn
 * @returns {MemoryItem[]}
 */
function extractImportantFiles(prompt, currentTurn = 0) {
  const matches = prompt.match(FILE_PATTERN) ?? [];
  const cleaned = matches
    .map((f) => f.toLowerCase())
    .filter((f) => f.length > 3 && !FILE_NOISE.test(f.replace(/\.\w+$/, "")));
  const deduped = dedupStrings(cleaned, MAX_IMPORTANT_FILES);
  return deduped.map((v) =>
    createMemoryItem(v, "important_file", FILE_CONFIDENCE, currentTurn)
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deduplicate and cap a string array at maxLen.
 * Case-insensitive; keeps the last (most recent) maxLen unique entries.
 * Used within a single extraction call to collapse duplicates before wrapping.
 */
function dedupStrings(arr, maxLen) {
  const seen   = new Set();
  const result = [];
  for (const item of arr) {
    const key = item.toLowerCase().trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result.slice(-maxLen);
}

/**
 * Merge two string arrays deduped and capped.
 * Used by buildStructuredRebuildContext to merge important_files + recent_files
 * (both may be string[] for recent_files which is always strings).
 */
function mergeArrays(existing, fresh, maxLen) {
  return dedupStrings([...(existing ?? []), ...(fresh ?? [])], maxLen);
}

// ─── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Extract structured memory facts from the current prompt.
 * Returns MemoryItem[] per category for THIS TURN — the caller (memory.js)
 * merges these into the existing session memory via mergeAndPruneItems.
 *
 * Backward compat: existing memory fields may still be string[] (legacy sessions).
 * normalizeToItems() in memory.js handles the mixed-type merge transparently.
 *
 * @param {string} prompt       — current user prompt
 * @param {number} currentTurn  — current session turn (0 if unknown)
 * @returns {{
 *   decisions:       MemoryItem[],
 *   constraints:     MemoryItem[],
 *   known_issues:    MemoryItem[],
 *   important_files: MemoryItem[],
 * }}
 */
function extractSmartMemory(prompt, currentTurn = 0) {
  try {
    return {
      decisions:       extractDecisions(prompt, currentTurn),
      constraints:     extractConstraints(prompt, currentTurn),
      known_issues:    extractKnownIssues(prompt, currentTurn),
      important_files: extractImportantFiles(prompt, currentTurn),
    };
  } catch {
    return { decisions: [], constraints: [], known_issues: [], important_files: [] };
  }
}

// ─── Structured Rebuild Context ───────────────────────────────────────────────

/**
 * Build a structured [SESSION REBUILD] context block from rich session memory.
 *
 * V3: uses toActiveValues(items, currentTurn) to filter by effective confidence
 * before rendering. Items that have decayed, been superseded, or fall below
 * PRUNE_THRESHOLD are silently excluded from the rebuild block.
 *
 * Backward compat: string[] arrays (legacy sessions) pass through toActiveValues
 * unchanged — they are always included (no decay metadata available).
 *
 * @param {object} memory       — full session memory (v2+/v3 schema)
 * @param {number} currentTurn  — current turn for decay computation (default 0)
 * @returns {string}
 */
function buildStructuredRebuildContext(memory, currentTurn = 0) {
  const lines = ["[SESSION REBUILD]"];

  // ── Core identity ─────────────────────────────────────────────────────────
  if (memory.goal) {
    lines.push(`Goal: ${memory.goal}`);
  }
  if (memory.current_task && memory.current_task !== memory.goal) {
    lines.push(`Current Task: ${memory.current_task}`);
  }

  // ── Key Decisions — filtered by effective confidence ──────────────────────
  const decisions = toActiveValues(memory.decisions ?? [], currentTurn);
  if (decisions.length > 0) {
    lines.push("\nKey Decisions:");
    decisions.slice(-5).forEach((d) => lines.push(`* ${d}`));
  }

  // ── Constraints — filtered (kept unless decayed or superseded) ─────────────
  const constraints = toActiveValues(memory.constraints ?? [], currentTurn);
  if (constraints.length > 0) {
    lines.push("\nConstraints:");
    constraints.forEach((c) => lines.push(`* ${c}`));
  }

  // ── Known Issues — filtered (cleared on task shift by applyTaskShiftReset) ─
  const issues = toActiveValues(memory.known_issues ?? [], currentTurn);
  if (issues.length > 0) {
    lines.push("\nKnown Issues:");
    issues.forEach((i) => lines.push(`* ${i}`));
  }

  // ── Important Files (merge smart + recent; recent_files is always string[]) ─
  const smartFiles  = toActiveValues(memory.important_files ?? [], currentTurn);
  const recentFiles = (memory.recent_files ?? []).filter((f) => typeof f === "string");
  const allFiles    = mergeArrays(smartFiles, recentFiles, 6);
  if (allFiles.length > 0) {
    lines.push("\nImportant Files:");
    allFiles.forEach((f) => lines.push(`* ${f}`));
  }

  // ── Summary / Pattern ─────────────────────────────────────────────────────
  if (memory.last_summary) {
    lines.push(`\nLast Summary: ${memory.last_summary}`);
  }
  if (memory.last_successful_pattern) {
    lines.push(`Last Successful Pattern: ${memory.last_successful_pattern}`);
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  if (lines.length === 1) {
    lines.push("(resuming session — no prior context available)");
  }

  return lines.join("\n");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  extractSmartMemory,
  buildStructuredRebuildContext,
  mergeArrays,
  // Exposed individually for testing
  extractDecisions,
  extractConstraints,
  extractKnownIssues,
  extractImportantFiles,
  isConfidentDecision,
  decisionConfidence,
  constraintConfidence,
  issueConfidence,
  dedupStrings,
  MAX_DECISIONS,
  MAX_CONSTRAINTS,
  MAX_KNOWN_ISSUES,
  MAX_IMPORTANT_FILES,
};
