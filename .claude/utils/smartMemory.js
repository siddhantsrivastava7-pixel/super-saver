/**
 * .claude/utils/smartMemory.js
 *
 * Smart Memory Extraction Engine
 *
 * Extracts structured, high-signal facts from the current prompt into
 * persistent memory fields. Rebuild and compact modes use this structured
 * memory to reconstruct context without replaying raw conversation history.
 *
 * Extracted fields:
 *   decisions        — architectural or approach choices detected this turn
 *   constraints      — rules, limits, or hard requirements stated by the user
 *   known_issues     — errors, bugs, and failures mentioned
 *   important_files  — file paths explicitly referenced in the prompt
 *
 * Design rules:
 *   - Keyword heuristics only — no ML, no API calls
 *   - Short phrases only — not raw sentences
 *   - Deduped and capped — never unbounded growth
 *   - Non-fatal — extraction failure returns empty arrays
 *   - Pure function — no I/O
 */

"use strict";

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
 * Extract decision phrases from a prompt.
 * Only stores phrases that contain strong commitment verbs (not hedges/speculation).
 * @param {string} prompt
 * @returns {string[]}
 */
function extractDecisions(prompt) {
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

  return dedupCap(found, MAX_DECISIONS);
}

// ─── Constraint Extraction ────────────────────────────────────────────────────

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
 * Extract constraint phrases from a prompt.
 * @param {string} prompt
 * @returns {string[]}
 */
function extractConstraints(prompt) {
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

  return dedupCap(found, MAX_CONSTRAINTS);
}

// ─── Known Issues Extraction ─────────────────────────────────────────────────

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
 * Extract known-issue phrases from a prompt.
 * @param {string} prompt
 * @returns {string[]}
 */
function extractKnownIssues(prompt) {
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

  return dedupCap(found, MAX_KNOWN_ISSUES);
}

// ─── Important Files Extraction ───────────────────────────────────────────────

// Common source file extensions worth tracking
const FILE_PATTERN = /\b[\w\-./@]+\.(js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|json|yaml|yml|toml|md|sh|env|sql|css|scss)\b/gi;

// Noise patterns to exclude from file extraction
const FILE_NOISE  = /^(e\.g|etc|i\.e|vs|eg)$/i;

/**
 * Extract important file paths explicitly mentioned in the prompt.
 * @param {string} prompt
 * @returns {string[]}
 */
function extractImportantFiles(prompt) {
  const matches = prompt.match(FILE_PATTERN) ?? [];
  const cleaned = matches
    .map((f) => f.toLowerCase())
    .filter((f) => f.length > 3 && !FILE_NOISE.test(f.replace(/\.\w+$/, "")));
  return dedupCap(cleaned, MAX_IMPORTANT_FILES);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deduplicate and cap an array at maxLen.
 * Uses case-insensitive dedup; keeps the most recently seen unique entries.
 */
function dedupCap(arr, maxLen) {
  const seen   = new Set();
  const result = [];
  for (const item of arr) {
    const key = item.toLowerCase().trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  // Keep the last maxLen (most recent)
  return result.slice(-maxLen);
}

/**
 * Merge two arrays deduped and capped.
 * Used to merge existing memory arrays with freshly extracted items.
 */
function mergeArrays(existing, fresh, maxLen) {
  return dedupCap([...(existing ?? []), ...(fresh ?? [])], maxLen);
}

// ─── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Extract structured memory facts from the current prompt.
 * Returns only the delta for THIS TURN — the caller (memory.js) merges
 * these into the existing session memory with proper caps.
 *
 * @param {string} prompt   — current user prompt
 * @returns {{
 *   decisions:       string[],
 *   constraints:     string[],
 *   known_issues:    string[],
 *   important_files: string[],
 * }}
 */
function extractSmartMemory(prompt) {
  try {
    return {
      decisions:       extractDecisions(prompt),
      constraints:     extractConstraints(prompt),
      known_issues:    extractKnownIssues(prompt),
      important_files: extractImportantFiles(prompt),
    };
  } catch {
    return { decisions: [], constraints: [], known_issues: [], important_files: [] };
  }
}

// ─── Structured Rebuild Context ───────────────────────────────────────────────

/**
 * Build a structured [SESSION REBUILD] context block from rich session memory.
 *
 * Replaces the shallow rebuild context from lifecycle.js with a fully
 * structured block that provides Goal → Decisions → Constraints → Issues → Files.
 * This is the primary output of the Smart Memory Engine.
 *
 * @param {object} memory - full session memory (schema v3 with v2 fields + v3 fields)
 * @returns {string}
 */
function buildStructuredRebuildContext(memory) {
  const lines = ["[SESSION REBUILD]"];

  // ── Core identity ─────────────────────────────────────────────────────────
  if (memory.goal) {
    lines.push(`Goal: ${memory.goal}`);
  }
  if (memory.current_task && memory.current_task !== memory.goal) {
    lines.push(`Current Task: ${memory.current_task}`);
  }

  // ── Key Decisions ─────────────────────────────────────────────────────────
  const decisions = memory.decisions ?? [];
  if (decisions.length > 0) {
    lines.push("\nKey Decisions:");
    decisions.slice(-5).forEach((d) => lines.push(`* ${d}`));
  }

  // ── Constraints ───────────────────────────────────────────────────────────
  const constraints = memory.constraints ?? [];
  if (constraints.length > 0) {
    lines.push("\nConstraints:");
    constraints.forEach((c) => lines.push(`* ${c}`));
  }

  // ── Known Issues ─────────────────────────────────────────────────────────
  const issues = memory.known_issues ?? [];
  if (issues.length > 0) {
    lines.push("\nKnown Issues:");
    issues.forEach((i) => lines.push(`* ${i}`));
  }

  // ── Important Files (merge smart + recent) ────────────────────────────────
  const allFiles = mergeArrays(
    memory.important_files ?? [],
    memory.recent_files    ?? [],
    6
  );
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
  dedupCap,
  MAX_DECISIONS,
  MAX_CONSTRAINTS,
  MAX_KNOWN_ISSUES,
  MAX_IMPORTANT_FILES,
};
