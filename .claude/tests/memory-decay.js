#!/usr/bin/env node
/**
 * .claude/tests/memory-decay.js
 *
 * Memory Decay Engine Tests (V3)
 *
 * Validates all mechanisms in memoryDecay.js:
 *   - createMemoryItem schema
 *   - normalizeToItems (string[] and MemoryItem[] backward compat)
 *   - computeEffectiveConfidence (decay formula + floor + superseded=0)
 *   - applySupersededDetection (regex patterns, mutation semantics)
 *   - mergeAndPruneItems (dedup, reinforce, supersede, prune, cap)
 *   - pruneMemoryItems (standalone prune)
 *   - wordOverlap (4+ char overlap fraction)
 *   - detectTaskShift (conservative — both goal AND task must be low)
 *   - applyTaskShiftReset (clears issues, decays decisions, keeps constraints)
 *   - toActiveValues (render helper, filters superseded + below threshold)
 *   - Full multi-turn scenario
 *
 * Run:
 *   node .claude/tests/memory-decay.js
 *
 * Exit 0 = all pass, exit 1 = one or more failures.
 */

"use strict";

const path = require("path");

const {
  createMemoryItem,
  normalizeToItems,
  computeEffectiveConfidence,
  applySupersededDetection,
  mergeAndPruneItems,
  pruneMemoryItems,
  wordOverlap,
  detectTaskShift,
  applyTaskShiftReset,
  toActiveValues,
  DECAY_PER_TURN,
  PRUNE_THRESHOLD,
  MIN_EFFECTIVE_CONF,
  TASK_SHIFT_OVERLAP,
  MIN_TURN_FOR_SHIFT,
} = require(path.join(__dirname, "../utils/memoryDecay.js"));

// ─── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  PASS ✓  ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    process.stdout.write(`  FAIL ✗  ${name}: ${err.message}\n`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg ?? "assertClose"}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  }
}

function assertTrue(condition, msg) {
  if (!condition) throw new Error(msg ?? "expected truthy");
}

function assertFalse(condition, msg) {
  if (condition) throw new Error(msg ?? "expected falsy");
}

function assertArrayIncludes(arr, value, msg) {
  if (!arr.includes(value)) {
    throw new Error(`${msg ?? "assertArrayIncludes"}: "${value}" not found in [${arr.join(", ")}]`);
  }
}

function assertArrayExcludes(arr, value, msg) {
  if (arr.includes(value)) {
    throw new Error(`${msg ?? "assertArrayExcludes"}: "${value}" unexpectedly found in [${arr.join(", ")}]`);
  }
}

const LINE = "═".repeat(64);
const DASH = "─".repeat(64);

// ─── Section 1: createMemoryItem ─────────────────────────────────────────────

console.log(LINE);
console.log("1. createMemoryItem");
console.log(DASH);

test("creates item with correct value", () => {
  const item = createMemoryItem("use PostgreSQL", "decision", 0.9, 3);
  assertEqual(item.value, "use PostgreSQL");
});

test("creates item with correct type", () => {
  const item = createMemoryItem("use PostgreSQL", "decision", 0.9, 3);
  assertEqual(item.type, "decision");
});

test("creates item with clamped confidence (0.0–1.0)", () => {
  const item = createMemoryItem("x", "decision", 1.5, 0);
  assertEqual(item.confidence, 1.0);
});

test("creates item with confidence clamped at 0", () => {
  const item = createMemoryItem("x", "decision", -0.5, 0);
  assertEqual(item.confidence, 0.0);
});

test("creates item with turn and last_seen_turn equal to turn", () => {
  const item = createMemoryItem("x", "decision", 0.8, 5);
  assertEqual(item.turn, 5);
  assertEqual(item.last_seen_turn, 5);
});

test("creates item with superseded=false", () => {
  const item = createMemoryItem("x", "decision", 0.8, 1);
  assertFalse(item.superseded, "new items should not be superseded");
});

test("handles missing turn (defaults to 0)", () => {
  const item = createMemoryItem("x", "decision", 0.7);
  assertEqual(item.turn, 0);
  assertEqual(item.last_seen_turn, 0);
});

// ─── Section 2: normalizeToItems ─────────────────────────────────────────────

console.log(LINE);
console.log("2. normalizeToItems");
console.log(DASH);

test("normalizes string[] to MemoryItem[]", () => {
  const items = normalizeToItems(["use JWT", "PostgreSQL"], "decision", 5);
  assertEqual(items.length, 2);
  assertEqual(items[0].value, "use JWT");
  assertEqual(items[0].type, "decision");
  assertEqual(items[0].confidence, 0.7);  // legacy strings get 0.7
});

test("normalizes string[] — last_seen_turn = currentTurn - 1", () => {
  const items = normalizeToItems(["use JWT"], "decision", 5);
  assertEqual(items[0].last_seen_turn, 4);  // max(0, 5-1)
});

test("passes through existing MemoryItems unchanged", () => {
  const original = createMemoryItem("use JWT", "decision", 0.9, 3);
  const items    = normalizeToItems([original], "decision", 10);
  assertEqual(items[0].confidence, 0.9);
  assertEqual(items[0].turn, 3);
});

test("handles mixed string/MemoryItem array", () => {
  const item  = createMemoryItem("use JWT", "decision", 0.9, 2);
  const items = normalizeToItems(["old string", item], "decision", 5);
  assertEqual(items.length, 2);
  assertEqual(items[0].confidence, 0.7); // string → 0.7
  assertEqual(items[1].confidence, 0.9); // MemoryItem preserved
});

test("filters out empty-value items", () => {
  const items = normalizeToItems(["", "  ", "valid"], "decision", 1);
  assertEqual(items.length, 1);
  assertEqual(items[0].value, "valid");
});

test("returns [] for non-array input", () => {
  const items = normalizeToItems(null, "decision", 1);
  assertEqual(items.length, 0);
});

test("handles missing fields in MemoryItem gracefully", () => {
  const item  = { value: "partial item" }; // missing confidence, turn, etc.
  const items = normalizeToItems([item], "decision", 3);
  assertEqual(items[0].value, "partial item");
  assertEqual(items[0].confidence, 0.7);
  assertEqual(items[0].superseded, false);
});

// ─── Section 3: computeEffectiveConfidence ────────────────────────────────────

console.log(LINE);
console.log("3. computeEffectiveConfidence");
console.log(DASH);

test("superseded item always returns 0", () => {
  const item = { ...createMemoryItem("x", "d", 0.9, 0), superseded: true };
  assertEqual(computeEffectiveConfidence(item, 100), 0);
});

test("no decay at same turn", () => {
  const item = createMemoryItem("x", "d", 0.9, 5);
  assertClose(computeEffectiveConfidence(item, 5), 0.9, 0.001, "no decay at turn 0");
});

test("decays linearly per turn", () => {
  const item = createMemoryItem("x", "d", 0.9, 0);
  // After 10 turns: 0.9 - 10 * 0.03 = 0.6
  assertClose(computeEffectiveConfidence(item, 10), 0.6, 0.001, "10 turns");
});

test("floor at MIN_EFFECTIVE_CONF (not below)", () => {
  const item = createMemoryItem("x", "d", 0.5, 0);
  // After 30 turns: 0.5 - 30*0.03 = -0.4 → floored at MIN_EFFECTIVE_CONF
  const conf = computeEffectiveConfidence(item, 30);
  assertTrue(conf >= MIN_EFFECTIVE_CONF, `floor violated: got ${conf}`);
  assertEqual(conf, MIN_EFFECTIVE_CONF);
});

test("uses last_seen_turn for decay (not turn)", () => {
  const item = {
    ...createMemoryItem("x", "d", 0.9, 0),
    last_seen_turn: 8,  // last seen at turn 8
  };
  // currentTurn=10 → turnsSince = 10-8 = 2 → 0.9 - 2*0.03 = 0.84
  assertClose(computeEffectiveConfidence(item, 10), 0.84, 0.001);
});

test("PRUNE_THRESHOLD constant is accessible", () => {
  assertTrue(PRUNE_THRESHOLD > 0 && PRUNE_THRESHOLD < 1);
});

test("DECAY_PER_TURN constant is accessible", () => {
  assertEqual(DECAY_PER_TURN, 0.03);
});

// ─── Section 4: applySupersededDetection ──────────────────────────────────────

console.log(LINE);
console.log("4. applySupersededDetection");
console.log(DASH);

test("'instead of X' marks matching existing item as superseded", () => {
  const existing = [createMemoryItem("use sessions for auth", "decision", 0.9, 1)];
  const newItem  = createMemoryItem("use JWT instead of sessions", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded, "sessions item should be superseded");
});

test("'no longer using X' supersedes matching item", () => {
  const existing = [createMemoryItem("using Redux for state", "decision", 0.9, 1)];
  const newItem  = createMemoryItem("no longer using Redux", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded);
});

test("'switching from X' supersedes matching item", () => {
  const existing = [createMemoryItem("webpack bundler", "decision", 0.8, 1)];
  const newItem  = createMemoryItem("switching from webpack to vite", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded);
});

test("'switched from X' supersedes matching item", () => {
  const existing = [createMemoryItem("decided to use mongoose", "decision", 0.9, 1)];
  const newItem  = createMemoryItem("switched from mongoose to prisma", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded);
});

test("'replaced X' supersedes matching item", () => {
  const existing = [createMemoryItem("use express router", "decision", 0.9, 1)];
  const newItem  = createMemoryItem("replaced express with fastify", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded);
});

test("non-matching item is not affected", () => {
  const existing = [createMemoryItem("use TypeScript", "decision", 0.9, 1)];
  const newItem  = createMemoryItem("switching from webpack to vite", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  assertFalse(existing[0].superseded, "TypeScript decision should be unaffected");
});

test("already-superseded items are not re-processed", () => {
  const existing = [{ ...createMemoryItem("use sessions", "decision", 0.9, 1), superseded: true }];
  const newItem  = createMemoryItem("use JWT instead of sessions", "decision", 0.9, 5);
  // Should not error; already superseded stays superseded
  applySupersededDetection(existing, newItem);
  assertTrue(existing[0].superseded);
});

test("short replaced term (< 3 chars) is skipped as noise", () => {
  const existing = [createMemoryItem("use it for auth", "decision", 0.9, 1)];
  // "it" is 2 chars — too short to be a meaningful replacement term
  const newItem  = createMemoryItem("instead of it use something else", "decision", 0.9, 5);
  applySupersededDetection(existing, newItem);
  // The item MIGHT or MIGHT NOT be superseded — but should not throw
  // The exact behavior depends on whether "it" passes the length check
  // (it doesn't — < 3 chars are skipped, so item should remain unsuperseded)
  assertFalse(existing[0].superseded, "short 'it' token should be skipped");
});

// ─── Section 5: mergeAndPruneItems ────────────────────────────────────────────

console.log(LINE);
console.log("5. mergeAndPruneItems");
console.log(DASH);

test("adds new items not already present", () => {
  const existing = [createMemoryItem("use JWT", "decision", 0.9, 1)];
  const fresh    = [createMemoryItem("use PostgreSQL", "decision", 0.85, 5)];
  const result   = mergeAndPruneItems(existing, fresh, 5, 10);
  assertEqual(result.length, 2);
});

test("reinforces existing item (same value) — updates last_seen_turn", () => {
  const existing = [createMemoryItem("use JWT", "decision", 0.8, 1)];
  const fresh    = [createMemoryItem("use JWT", "decision", 0.7, 5)];
  const result   = mergeAndPruneItems(existing, fresh, 5, 10);
  assertEqual(result.length, 1);
  assertEqual(result[0].last_seen_turn, 5);
});

test("reinforces existing item — takes higher confidence", () => {
  const existing = [createMemoryItem("use JWT", "decision", 0.6, 1)];
  const fresh    = [createMemoryItem("use JWT", "decision", 0.85, 5)];
  const result   = mergeAndPruneItems(existing, fresh, 5, 10);
  assertEqual(result[0].confidence, 0.85);
});

test("prunes superseded items after merge", () => {
  const existing = [
    createMemoryItem("use sessions for auth", "decision", 0.9, 1),
    createMemoryItem("use TypeScript", "decision", 0.9, 1),
  ];
  const fresh = [createMemoryItem("use JWT instead of sessions", "decision", 0.9, 5)];
  const result = mergeAndPruneItems(existing, fresh, 5, 10);
  const values = result.map((i) => i.value);
  assertArrayExcludes(values, "use sessions for auth", "superseded item should be pruned");
  assertArrayIncludes(values, "use TypeScript", "non-superseded should survive");
  assertArrayIncludes(values, "use JWT instead of sessions", "new item should be added");
});

test("prunes items below PRUNE_THRESHOLD", () => {
  // Item with confidence 0.2 created at turn 0, evaluated at turn 30:
  // effectiveConf = max(0.10, 0.2 - 30*0.03) = max(0.10, -0.7) = 0.10 < 0.15
  const old  = createMemoryItem("old stale item", "decision", 0.2, 0);
  const fresh = [createMemoryItem("new item", "decision", 0.9, 30)];
  const result = mergeAndPruneItems([old], fresh, 30, 10);
  const values = result.map((i) => i.value);
  assertArrayExcludes(values, "old stale item", "decayed item should be pruned");
});

test("caps at maxLen — keeps most recent", () => {
  const existing = Array.from({ length: 5 }, (_, i) =>
    createMemoryItem(`item-${i}`, "decision", 0.9, i)
  );
  const fresh = [createMemoryItem("newest", "decision", 0.9, 5)];
  const result = mergeAndPruneItems(existing, fresh, 5, 5);
  assertEqual(result.length, 5);
  // Newest should be present (slice(-maxLen) keeps last 5)
  const values = result.map((i) => i.value);
  assertArrayIncludes(values, "newest");
});

test("case-insensitive dedup for reinforcement", () => {
  const existing = [createMemoryItem("Use JWT", "decision", 0.8, 1)];
  const fresh    = [createMemoryItem("use jwt", "decision", 0.9, 5)];
  const result   = mergeAndPruneItems(existing, fresh, 5, 10);
  assertEqual(result.length, 1, "case-insensitive match should reinforce, not duplicate");
});

// ─── Section 6: pruneMemoryItems ─────────────────────────────────────────────

console.log(LINE);
console.log("6. pruneMemoryItems");
console.log(DASH);

test("removes superseded items", () => {
  const items = [
    createMemoryItem("use JWT", "decision", 0.9, 1),
    { ...createMemoryItem("use sessions", "decision", 0.9, 1), superseded: true },
  ];
  const result = pruneMemoryItems(items, 2);
  assertEqual(result.length, 1);
  assertEqual(result[0].value, "use JWT");
});

test("removes items below PRUNE_THRESHOLD", () => {
  const items = [createMemoryItem("stale item", "decision", 0.2, 0)];
  const result = pruneMemoryItems(items, 30);
  assertEqual(result.length, 0);
});

test("keeps items above PRUNE_THRESHOLD", () => {
  const items = [createMemoryItem("fresh item", "decision", 0.9, 29)];
  const result = pruneMemoryItems(items, 30);
  assertEqual(result.length, 1);
});

test("handles empty array", () => {
  assertEqual(pruneMemoryItems([], 5).length, 0);
});

test("handles non-array gracefully", () => {
  assertEqual(pruneMemoryItems(null, 5).length, 0);
});

// ─── Section 7: wordOverlap ───────────────────────────────────────────────────

console.log(LINE);
console.log("7. wordOverlap");
console.log(DASH);

test("identical texts → 1.0", () => {
  assertClose(wordOverlap("authentication login token", "authentication login token"), 1.0, 0.001);
});

test("no shared words → 0.0", () => {
  assertEqual(wordOverlap("authentication login", "database query schema"), 0);
});

test("partial overlap", () => {
  const overlap = wordOverlap("authentication login token", "authentication refresh token");
  assertTrue(overlap > 0 && overlap < 1, `expected partial overlap, got ${overlap}`);
});

test("short words (< 4 chars) excluded from overlap", () => {
  // "the" (3), "is" (2), "an" (2) — all < 4 chars, should not count
  const overlap = wordOverlap("the is an", "the is an");
  // Both 4+-char word sets are empty → overlap = 0
  assertEqual(overlap, 0);
});

test("empty first text → 0", () => {
  assertEqual(wordOverlap("", "authentication login"), 0);
});

test("empty second text → 0", () => {
  assertEqual(wordOverlap("authentication login", ""), 0);
});

test("case insensitive overlap", () => {
  const overlap = wordOverlap("Authentication Token", "authentication token");
  assertClose(overlap, 1.0, 0.001, "case should not affect overlap");
});

// ─── Section 8: detectTaskShift ──────────────────────────────────────────────

console.log(LINE);
console.log("8. detectTaskShift");
console.log(DASH);

test("returns false before MIN_TURN_FOR_SHIFT turns", () => {
  const memory = { goal: "fix auth bug", current_task: "fix login" };
  const result = detectTaskShift(memory, "completely different topic about databases", 3);
  assertFalse(result, "should not detect shift before MIN_TURN_FOR_SHIFT");
});

test("returns false when no goal and no current_task", () => {
  const memory = { goal: "", current_task: "" };
  assertFalse(detectTaskShift(memory, "anything", 10));
});

test("returns false when prompt is too short", () => {
  const memory = { goal: "authentication system", current_task: "fix login bug" };
  assertFalse(detectTaskShift(memory, "short", 10));
});

test("returns true when prompt has very low overlap with both goal and task", () => {
  const memory = {
    goal:         "fix authentication login token expiry",
    current_task: "debugging token validation middleware",
  };
  // Prompt about a completely different topic
  const prompt = "calculate total revenue from database quarterly report schema";
  const result = detectTaskShift(memory, prompt, MIN_TURN_FOR_SHIFT + 1);
  assertTrue(result, "should detect task shift on very different topic");
});

test("returns false when overlap is high enough with goal", () => {
  const memory = {
    goal:         "authentication login token system",
    current_task: "unrelated topic",
  };
  const prompt = "fix the authentication login token expiry bug";
  const result = detectTaskShift(memory, prompt, 10);
  assertFalse(result, "high goal overlap should prevent shift detection");
});

test("returns false when overlap is high enough with current_task", () => {
  const memory = {
    goal:         "unrelated topic from long ago",
    current_task: "authentication token validation middleware",
  };
  const prompt = "debug the token validation middleware for authentication";
  assertFalse(detectTaskShift(memory, prompt, 10));
});

test("is conservative — BOTH goal AND task must be low", () => {
  const memory = {
    goal:         "authentication login system",      // high overlap
    current_task: "database schema migration queries", // low overlap
  };
  // Prompt relates to goal but not task
  const prompt = "fix the authentication login token";
  assertFalse(detectTaskShift(memory, prompt, 10), "should not fire when goal overlap is high");
});

// ─── Section 9: applyTaskShiftReset ──────────────────────────────────────────

console.log(LINE);
console.log("9. applyTaskShiftReset");
console.log(DASH);

test("clears known_issues", () => {
  const memory = {
    known_issues: [createMemoryItem("bug in auth.js", "known_issue", 0.8, 1)],
    decisions:    [],
    constraints:  [],
    goal:         "old goal",
  };
  applyTaskShiftReset(memory, "new prompt about databases", 10);
  assertEqual(memory.known_issues.length, 0, "known_issues should be cleared");
});

test("decays decisions confidence × 0.4", () => {
  const memory = {
    known_issues: [],
    decisions:    [createMemoryItem("use JWT", "decision", 0.9, 1)],
    constraints:  [],
    goal:         "",
  };
  applyTaskShiftReset(memory, "new prompt about databases", 10);
  if (memory.decisions.length > 0) {
    // If the item survived prune, its confidence should be 0.9 * 0.4 = 0.36
    assertTrue(memory.decisions[0].confidence < 0.5, "decision should be heavily decayed");
  }
  // It's also acceptable that the heavily-decayed item was pruned
});

test("preserves constraints (project-wide rules survive task shift)", () => {
  const memory = {
    known_issues: [],
    decisions:    [],
    constraints:  [createMemoryItem("never store passwords in plaintext", "constraint", 0.9, 1)],
    goal:         "",
  };
  applyTaskShiftReset(memory, "new prompt about databases", 10);
  // Constraints must not be touched
  assertTrue(memory.constraints.length > 0, "constraints should be preserved");
  assertEqual(memory.constraints[0].value, "never store passwords in plaintext");
});

test("updates goal to new prompt", () => {
  const memory = { known_issues: [], decisions: [], constraints: [], goal: "old goal" };
  applyTaskShiftReset(memory, "new task about database migration", 10);
  assertTrue(memory.goal.includes("new task"), "goal should be updated to new prompt");
});

test("handles legacy string decisions gracefully", () => {
  const memory = {
    known_issues: [],
    decisions:    ["use JWT", "use PostgreSQL"],  // legacy strings
    constraints:  [],
    goal:         "",
  };
  // Should not throw
  applyTaskShiftReset(memory, "new prompt", 10);
  // Legacy strings are either converted+decayed or pruned — just no crash
  assertTrue(Array.isArray(memory.decisions), "decisions should remain an array");
});

// ─── Section 10: toActiveValues ──────────────────────────────────────────────

console.log(LINE);
console.log("10. toActiveValues");
console.log(DASH);

test("returns values of active (non-superseded, above-threshold) items", () => {
  const items = [
    createMemoryItem("use JWT", "decision", 0.9, 0),
    createMemoryItem("use PostgreSQL", "decision", 0.85, 0),
  ];
  const values = toActiveValues(items, 1);
  assertArrayIncludes(values, "use JWT");
  assertArrayIncludes(values, "use PostgreSQL");
});

test("excludes superseded items", () => {
  const items = [
    { ...createMemoryItem("use sessions", "decision", 0.9, 0), superseded: true },
    createMemoryItem("use JWT", "decision", 0.9, 0),
  ];
  const values = toActiveValues(items, 1);
  assertArrayExcludes(values, "use sessions", "superseded items should be excluded");
  assertArrayIncludes(values, "use JWT");
});

test("excludes items below PRUNE_THRESHOLD", () => {
  const items = [
    createMemoryItem("stale", "decision", 0.2, 0),  // will decay below threshold
    createMemoryItem("fresh", "decision", 0.9, 29),
  ];
  const values = toActiveValues(items, 30);
  assertArrayExcludes(values, "stale");
  assertArrayIncludes(values, "fresh");
});

test("passes through legacy string[] transparently", () => {
  const items  = ["legacy string", "another legacy"];
  const values = toActiveValues(items, 100);  // high turn — but strings always pass
  assertArrayIncludes(values, "legacy string");
  assertArrayIncludes(values, "another legacy");
});

test("handles empty array", () => {
  assertEqual(toActiveValues([], 5).length, 0);
});

test("handles non-array gracefully", () => {
  assertEqual(toActiveValues(null, 5).length, 0);
});

test("uses custom threshold when provided", () => {
  const items = [createMemoryItem("borderline", "decision", 0.5, 0)];
  // At turn 10: effectiveConf = max(0.10, 0.5 - 10*0.03) = max(0.10, 0.2) = 0.2
  // Default threshold 0.15 → passes; high threshold 0.3 → filtered
  const defaultResult = toActiveValues(items, 10);
  const highThreshold = toActiveValues(items, 10, 0.3);
  assertArrayIncludes(defaultResult, "borderline", "default threshold passes 0.2 item");
  assertArrayExcludes(highThreshold, "borderline", "high threshold filters 0.2 item");
});

// ─── Section 11: Full multi-turn scenario ─────────────────────────────────────

console.log(LINE);
console.log("11. Full multi-turn scenario");
console.log(DASH);

test("decisions accumulate across turns with reinforcement", () => {
  // Turn 1: decide to use JWT
  let existing = [];
  const t1 = [createMemoryItem("decided to use JWT for auth", "decision", 0.9, 1)];
  existing = mergeAndPruneItems(existing, t1, 1, 8);

  // Turn 3: another decision added
  const t3 = [createMemoryItem("going with PostgreSQL", "decision", 0.85, 3)];
  existing = mergeAndPruneItems(existing, t3, 3, 8);

  // Turn 5: JWT reinforced (mentioned again)
  const t5 = [createMemoryItem("decided to use JWT for auth", "decision", 0.9, 5)];
  existing = mergeAndPruneItems(existing, t5, 5, 8);

  assertEqual(existing.length, 2, "should have 2 unique decisions");
  const jwtItem = existing.find((i) => i.value.toLowerCase().includes("jwt"));
  assertTrue(jwtItem !== undefined, "JWT decision should exist");
  assertEqual(jwtItem.last_seen_turn, 5, "JWT should have been reinforced at turn 5");
});

test("superseded decision is removed and replacement added", () => {
  let existing = [createMemoryItem("decided to use sessions", "decision", 0.9, 1)];
  const fresh  = [createMemoryItem("switched from sessions to JWT", "decision", 0.9, 6)];
  existing = mergeAndPruneItems(existing, fresh, 6, 8);

  const values = existing.map((i) => i.value);
  assertArrayExcludes(values, "decided to use sessions", "sessions should be superseded");
  assertArrayIncludes(values, "switched from sessions to JWT");
});

test("stale item decays away over 30 turns", () => {
  // Item with confidence 0.4 created at turn 0
  let existing = [createMemoryItem("old approach detail", "decision", 0.4, 0)];
  // At turn 30: effectiveConf = max(0.10, 0.4 - 30*0.03) = max(0.10, -0.5) = 0.10 < 0.15
  const fresh  = [createMemoryItem("new fresh decision", "decision", 0.9, 30)];
  existing = mergeAndPruneItems(existing, fresh, 30, 8);

  const values = existing.map((i) => i.value);
  assertArrayExcludes(values, "old approach detail", "decayed item should be pruned");
  assertArrayIncludes(values, "new fresh decision");
});

test("task shift clears issues, keeps constraints, decays decisions", () => {
  const memory = {
    known_issues: [
      createMemoryItem("bug in auth middleware", "known_issue", 0.8, 1),
    ],
    decisions: [
      createMemoryItem("decided to use JWT", "decision", 0.9, 1),
    ],
    constraints: [
      createMemoryItem("never store passwords in plaintext", "constraint", 0.9, 1),
    ],
    goal: "fix authentication bugs",
  };

  applyTaskShiftReset(memory, "build a data analytics dashboard with charts", 10);

  // known_issues cleared
  assertEqual(memory.known_issues.length, 0, "issues cleared after task shift");

  // constraints preserved
  assertTrue(memory.constraints.length > 0, "constraints preserved after task shift");

  // decisions either decayed or pruned (confidence × 0.4 = 0.36 at turn 10)
  // Since effective confidence of 0.9*0.4=0.36 item at last_seen_turn=1, currentTurn=10:
  // effectiveConf = max(0.10, 0.36 - (10-1)*0.03) = max(0.10, 0.36 - 0.27) = max(0.10, 0.09) = 0.10
  // 0.10 < 0.15 (PRUNE_THRESHOLD) → item gets pruned
  // So memory.decisions.length === 0 is the expected outcome
  assertTrue(
    memory.decisions.length === 0 || memory.decisions[0].confidence < 0.5,
    "decisions should be decayed or pruned after task shift"
  );
});

test("toActiveValues on memory after task shift returns only constraints", () => {
  const memory = {
    known_issues: [createMemoryItem("bug in login", "known_issue", 0.8, 1)],
    decisions:    [createMemoryItem("use JWT", "decision", 0.9, 1)],
    constraints:  [createMemoryItem("never store passwords in plaintext", "constraint", 0.9, 1)],
    goal:         "auth",
  };
  applyTaskShiftReset(memory, "build analytics dashboard for reporting", 10);

  const issues      = toActiveValues(memory.known_issues, 10);
  const constraints = toActiveValues(memory.constraints, 10);

  assertEqual(issues.length, 0, "no issues should render after task shift");
  assertTrue(constraints.length > 0, "constraints should still render");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(LINE);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  failures.forEach((f) => console.log(`  ✗ ${f.name}: ${f.error}`));
}

console.log(LINE);
process.exit(failed > 0 ? 1 : 0);
