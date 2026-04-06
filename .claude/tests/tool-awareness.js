/**
 * .claude/tests/tool-awareness.js
 *
 * Tests for the Tool Awareness Engine.
 * Run: node .claude/tests/tool-awareness.js
 */

"use strict";

const path = require("path");
const {
  analyzeToolBehavior,
  countRepeatedReads,
  estimateToolCalls,
  LIGHTWEIGHT_TASKS,
  COMPLEX_TASKS,
  REPEATED_READ_THRESHOLD,
  TOKENS_PER_TOOL_CALL,
} = require(path.resolve(__dirname, "../utils/toolTracker.js"));

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, name, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
    failed++;
  }
}

function section(title) { console.log(`\n${title}`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake registry where N files each have lastUsedTurn > 1 */
function makeRegistry(repeatedCount, totalCount = repeatedCount) {
  const reg = {};
  for (let i = 0; i < totalCount; i++) {
    reg[`/project/file${i}.js`] = {
      hash:         `abc${i}`,
      lastUsedTurn: i < repeatedCount ? 3 : 1,
    };
  }
  return reg;
}

// ─── 1. Task-type suppression ─────────────────────────────────────────────────

section("1. Lightweight tasks get suppression block");
{
  for (const taskType of LIGHTWEIGHT_TASKS) {
    const result = analyzeToolBehavior({
      taskType,
      readRegistry:  {},
      relevantFiles: [],
      cacheHits:     0,
      currentTurn:   5,
    });
    assert(result.suppressionBlock.includes("[TOOL USAGE POLICY]"),
      `${taskType} → suppression block injected`);
    assert(result.stats.is_suppressed === true,
      `${taskType} → is_suppressed = true`);
  }
}

section("2. Complex tasks do NOT get suppression block");
{
  for (const taskType of COMPLEX_TASKS) {
    const result = analyzeToolBehavior({
      taskType,
      readRegistry:  {},
      relevantFiles: [],
      cacheHits:     0,
      currentTurn:   5,
    });
    assert(result.suppressionBlock === "",
      `${taskType} → no suppression block`);
    assert(result.stats.is_suppressed === false,
      `${taskType} → is_suppressed = false`);
  }
}

// ─── 2. Suppression block content ────────────────────────────────────────────

section("3. Suppression block contains correct instructions");
{
  const result = analyzeToolBehavior({
    taskType:      "explanation",
    readRegistry:  {},
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   3,
  });
  assert(result.suppressionBlock.includes("Do not use tools"), "contains 'Do not use tools'");
  assert(result.suppressionBlock.includes("Prefer reasoning"),  "contains 'Prefer reasoning'");
  assert(result.suppressionBlock.includes("Avoid re-reading"),  "contains 'Avoid re-reading'");
}

// ─── 3. Repeated read detection ───────────────────────────────────────────────

section("4. No optimization hint when repeated reads below threshold");
{
  const registry = makeRegistry(REPEATED_READ_THRESHOLD - 1);
  const result = analyzeToolBehavior({
    taskType:      "code-fix",
    readRegistry:  registry,
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   5,
  });
  assert(result.optimizationHint === "",
    `no hint when repeated reads (${REPEATED_READ_THRESHOLD - 1}) < threshold (${REPEATED_READ_THRESHOLD})`);
  assert(result.stats.has_repeated_reads === false, "has_repeated_reads = false");
}

section("5. Optimization hint injected when repeated reads at threshold");
{
  const registry = makeRegistry(REPEATED_READ_THRESHOLD);
  const result = analyzeToolBehavior({
    taskType:      "code-fix",
    readRegistry:  registry,
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   5,
  });
  assert(result.optimizationHint.includes("[TOOL OPTIMIZATION]"),
    `hint injected when repeated reads >= ${REPEATED_READ_THRESHOLD}`);
  assert(result.stats.has_repeated_reads === true,   "has_repeated_reads = true");
  assert(result.stats.repeated_read_count >= REPEATED_READ_THRESHOLD,
    `repeated_read_count >= ${REPEATED_READ_THRESHOLD}`);
}

section("6. Optimization hint content is correct");
{
  const registry = makeRegistry(REPEATED_READ_THRESHOLD + 1);
  const result = analyzeToolBehavior({
    taskType:      "refactor",
    readRegistry:  registry,
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   6,
  });
  assert(result.optimizationHint.includes("repeated file access"), "mentions repeated file access");
  assert(result.optimizationHint.includes("Reuse cached"),         "mentions cache reuse");
}

section("7. No repeated reads on turn 1 or 2");
{
  // Even if lastUsedTurn > 1 in the registry, early turns return 0
  const registry = makeRegistry(5);
  const count = countRepeatedReads(registry, 2);
  assert(count === 0, "countRepeatedReads returns 0 on turn ≤ 2", `got ${count}`);
}

// ─── 4. Stats correctness ────────────────────────────────────────────────────

section("8. Stats — file_reads_this_turn and redundant_reads");
{
  const result = analyzeToolBehavior({
    taskType:      "default",
    readRegistry:  {},
    relevantFiles: ["a.js", "b.js", "c.js"],
    cacheHits:     2,
    currentTurn:   4,
  });
  assert(result.stats.file_reads_this_turn === 3, `file_reads = 3 (got ${result.stats.file_reads_this_turn})`);
  assert(result.stats.redundant_reads      === 2, `redundant = 2 (got ${result.stats.redundant_reads})`);
}

section("9. Stats — tool_calls_estimate for complex task");
{
  // Complex task with 2 cache misses → 2 file reads + 1 bonus = 3
  const result = analyzeToolBehavior({
    taskType:      "code-fix",
    readRegistry:  {},
    relevantFiles: ["a.js", "b.js"],
    cacheHits:     0,
    currentTurn:   4,
  });
  assert(result.stats.tool_calls_estimate === 3,
    `complex task: 2 misses + 1 bonus = 3 (got ${result.stats.tool_calls_estimate})`);
}

section("10. Stats — tool_calls_estimate for lightweight task");
{
  // Lightweight task with 0 files → 0 tool calls (no bonus for lightweight)
  const result = analyzeToolBehavior({
    taskType:      "explanation",
    readRegistry:  {},
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   3,
  });
  assert(result.stats.tool_calls_estimate === 0,
    `explanation with 0 files = 0 tool calls (got ${result.stats.tool_calls_estimate})`);
}

// ─── 5. Both suppression + hint can coexist ───────────────────────────────────

section("11. Both suppression and optimization hint can be active");
{
  // Lightweight task WITH enough repeated reads
  const registry = makeRegistry(REPEATED_READ_THRESHOLD + 2);
  const result = analyzeToolBehavior({
    taskType:      "explanation",
    readRegistry:  registry,
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   8,
  });
  assert(result.suppressionBlock  !== "", "suppression active for explanation");
  assert(result.optimizationHint !== "", "optimization hint active for repeated reads");
}

// ─── 6. Token impact ─────────────────────────────────────────────────────────

section("12. Token impact — estimated_tool_cost_tokens");
{
  // complex task: 3 misses + 1 bonus = 4 tool calls × 200 = 800
  const result = analyzeToolBehavior({
    taskType:      "code-fix",
    readRegistry:  {},
    relevantFiles: ["a.js", "b.js", "c.js"],
    cacheHits:     0,
    currentTurn:   4,
  });
  const expectedCalls = result.stats.tool_calls_estimate;
  const expectedCost  = expectedCalls * TOKENS_PER_TOOL_CALL;
  assert(result.stats.estimated_tool_cost_tokens === expectedCost,
    `tool cost = ${expectedCost} (${expectedCalls} calls × ${TOKENS_PER_TOOL_CALL})`,
    `got ${result.stats.estimated_tool_cost_tokens}`);
}

section("13. Token impact — estimated_suppression_saved for lightweight task");
{
  // Lightweight task with 2 files → 2 × TOKENS_PER_TOOL_CALL suppressed
  const result = analyzeToolBehavior({
    taskType:      "explanation",
    readRegistry:  {},
    relevantFiles: ["a.js", "b.js"],
    cacheHits:     0,
    currentTurn:   3,
  });
  const expectedSaved = 2 * TOKENS_PER_TOOL_CALL;
  assert(result.stats.estimated_suppression_saved === expectedSaved,
    `suppression saves ${expectedSaved} tokens on explanation with 2 files`,
    `got ${result.stats.estimated_suppression_saved}`);
}

section("14. Token impact — no suppression savings on complex task");
{
  const result = analyzeToolBehavior({
    taskType:      "implementation",
    readRegistry:  {},
    relevantFiles: ["a.js", "b.js"],
    cacheHits:     0,
    currentTurn:   4,
  });
  assert(result.stats.estimated_suppression_saved === 0,
    "complex task: suppression savings = 0 (tools are expected and useful)",
    `got ${result.stats.estimated_suppression_saved}`);
}

section("15. Token impact — suppression savings = 0 when no files");
{
  const result = analyzeToolBehavior({
    taskType:      "explanation",
    readRegistry:  {},
    relevantFiles: [],
    cacheHits:     0,
    currentTurn:   3,
  });
  assert(result.stats.estimated_suppression_saved === 0,
    "no files → suppression savings = 0",
    `got ${result.stats.estimated_suppression_saved}`);
}

// ─── 7. Non-fatal on bad input ────────────────────────────────────────────────

section("16. analyzeToolBehavior is non-fatal on invalid input");
{
  const result = analyzeToolBehavior({});
  assert(result.suppressionBlock  === "", "empty suppression on empty input");
  assert(result.optimizationHint  === "", "empty hint on empty input");
  assert(typeof result.stats      === "object", "stats object returned");
  assert(result.stats.estimated_tool_cost_tokens  === 0, "cost = 0 on bad input");
  assert(result.stats.estimated_suppression_saved === 0, "saved = 0 on bad input");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Tool Awareness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
