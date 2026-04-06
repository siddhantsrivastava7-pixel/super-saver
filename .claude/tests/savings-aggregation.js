/**
 * .claude/tests/savings-aggregation.js
 *
 * Validates all savings math invariants:
 *   1. total === sum(5 components) on every turn
 *   2. history_saved_tokens > 0 after compression window passed
 *   3. total_tokens_processed_estimate > total_estimated_saved_tokens
 *   4. No individual component exceeds the total
 *   5. ?? not || — zero values don't trigger fallback
 *   6. Schema migration: old total discarded, recomputed from components
 *
 * Run: node .claude/tests/savings-aggregation.js
 */

"use strict";

const path = require("path");
const {
  updateSavings,
  formatSavingsBlock,
  formatDetailedSavings,
  TOKENS_PER_COMPRESSED_MSG,
  TOKENS_PER_CACHE_HIT,
} = require(path.resolve(__dirname, "../utils/savings.js"));

// ─── Test Harness ─────────────────────────────────────────────────────────────

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

function section(title) {
  console.log(`\n${title}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function componentSum(s) {
  return (
    (s.prompt_saved_tokens        || 0) +
    (s.history_saved_tokens       || 0) +
    (s.read_cache_saved_tokens    || 0) +
    (s.output_policy_saved_tokens || 0) +
    (s.lifecycle_saved_tokens     || 0)
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

section("1. Single turn — total === sum(components)");
{
  const s = updateSavings(undefined, {
    originalChars:      500,
    optimizedChars:     460,
    messagesCompressed: 2,
    cacheHits:          1,
    taskType:           "code-fix",
    lifecycleMode:      "normal",
    lifecycleTokensSaved: 0,
  });

  const sum = componentSum(s);
  assert(s.total_estimated_saved_tokens === sum,
    "total === component_sum after first turn",
    `total=${s.total_estimated_saved_tokens}, sum=${sum}`);

  assert(s.prompts_processed === 1, "prompts_processed = 1");
}

section("2. Multi-turn accumulation — total stays in sync");
{
  let s = undefined;
  for (let i = 0; i < 5; i++) {
    s = updateSavings(s, {
      originalChars:      600,
      optimizedChars:     540,
      messagesCompressed: 1,
      cacheHits:          i % 2 === 0 ? 1 : 0,
      taskType:           "implementation",
      lifecycleMode:      "normal",
      lifecycleTokensSaved: 0,
    });
  }
  const sum = componentSum(s);
  assert(s.total_estimated_saved_tokens === sum,
    "total === component_sum after 5 turns",
    `total=${s.total_estimated_saved_tokens}, sum=${sum}`);
  assert(s.prompts_processed === 5, "prompts_processed = 5");
}

section("3. history_saved_tokens > 0 when messages are compressed");
{
  const s = updateSavings(undefined, {
    originalChars:      800,
    optimizedChars:     720,
    messagesCompressed: 3,   // 3 messages compressed this turn
    cacheHits:          0,
    taskType:           "default",
    lifecycleMode:      "compact",
    lifecycleTokensSaved: 0,
  });

  const expectedHist = 3 * TOKENS_PER_COMPRESSED_MSG;
  assert(s.history_saved_tokens === expectedHist,
    `history_saved_tokens = ${expectedHist} (3 × TOKENS_PER_COMPRESSED_MSG)`,
    `got ${s.history_saved_tokens}`);
  assert(s.history_saved_tokens > 0, "history_saved_tokens > 0");
}

section("4. total_tokens_processed_estimate > total_estimated_saved_tokens");
{
  const s = updateSavings(undefined, {
    originalChars:      500,
    optimizedChars:     460,
    messagesCompressed: 2,
    cacheHits:          1,
    taskType:           "code-fix",
    lifecycleMode:      "normal",
    lifecycleTokensSaved: 0,
  });

  assert(
    s.total_tokens_processed_estimate > s.total_estimated_saved_tokens,
    "total_tokens_processed_estimate > total_saved",
    `processed=${s.total_tokens_processed_estimate}, saved=${s.total_estimated_saved_tokens}`
  );
  assert(
    s.total_tokens_processed_estimate === s.total_optimized_tokens + s.total_estimated_saved_tokens,
    "total_tokens_processed_estimate = optimized + saved"
  );
}

section("5. No component exceeds total");
{
  const s = updateSavings(undefined, {
    originalChars:      1000,
    optimizedChars:     900,
    messagesCompressed: 4,
    cacheHits:          2,
    taskType:           "refactor",
    lifecycleMode:      "rebuild",
    lifecycleTokensSaved: 2000,
  });

  const total = s.total_estimated_saved_tokens;
  assert(s.prompt_saved_tokens        <= total, `prompt_saved (${s.prompt_saved_tokens}) <= total (${total})`);
  assert(s.history_saved_tokens       <= total, `history_saved (${s.history_saved_tokens}) <= total (${total})`);
  assert(s.read_cache_saved_tokens    <= total, `cache_saved (${s.read_cache_saved_tokens}) <= total (${total})`);
  assert(s.output_policy_saved_tokens <= total, `policy_saved (${s.output_policy_saved_tokens}) <= total (${total})`);
  assert(s.lifecycle_saved_tokens     <= total, `lifecycle_saved (${s.lifecycle_saved_tokens}) <= total (${total})`);
}

section("6. Zero values don't trigger fallback (?? semantics)");
{
  // Seed with 0 in every component
  const seed = {
    prompts_processed:               1,
    prompt_saved_tokens:             0,
    history_saved_tokens:            0,
    read_cache_saved_tokens:         0,
    output_policy_saved_tokens:      0,
    lifecycle_saved_tokens:          0,
    total_estimated_saved_tokens:    0,
    total_original_tokens:           100,
    total_optimized_tokens:          100,
    total_tokens_processed_estimate: 100,
    total_cache_hits:                0,
    lifecycle_mode:                  "normal",
  };

  // Next turn also saves nothing (matching prompt)
  const s = updateSavings(seed, {
    originalChars:      400,
    optimizedChars:     400,  // no prompt savings
    messagesCompressed: 0,    // no compression
    cacheHits:          0,
    taskType:           "default",
    lifecycleMode:      "normal",
    lifecycleTokensSaved: 0,
  });

  assert(s.prompt_saved_tokens === 0,         "prompt_saved stays 0 with no compression");
  assert(s.history_saved_tokens === 0,        "history_saved stays 0 with no messages compressed");
  assert(s.read_cache_saved_tokens === 0,     "cache_saved stays 0 with no cache hits");
  assert(s.total_estimated_saved_tokens === 0,"total stays 0 when all components are 0");
  assert(s.prompts_processed === 2,           "prompts_processed incremented to 2");
}

section("7. Schema migration — old total discarded, recomputed from components");
{
  // Simulate an old-schema session: total=999 but no breakdown fields
  const oldSchema = {
    prompts_processed:            5,
    total_estimated_saved_tokens: 999,  // stale pre-breakdown total
    total_original_tokens:        2000,
    total_optimized_tokens:       1900,
    // No breakdown fields — they don't exist in old schema
  };

  const s = updateSavings(oldSchema, {
    originalChars:      400,
    optimizedChars:     380,
    messagesCompressed: 1,
    cacheHits:          0,
    taskType:           "default",
    lifecycleMode:      "normal",
    lifecycleTokensSaved: 0,
  });

  const sum = componentSum(s);
  assert(s.total_estimated_saved_tokens === sum,
    "total recomputed from components (old total discarded)",
    `total=${s.total_estimated_saved_tokens}, sum=${sum}, old_total=999`);

  assert(s.total_estimated_saved_tokens !== 999 + 5,
    "total is NOT old_total + turnSaved");
}

section("8. Lifecycle rebuild mode — savings tracked via lifecycle field");
{
  const s = updateSavings(undefined, {
    originalChars:        500,
    optimizedChars:       480,
    messagesCompressed:   0,
    cacheHits:            0,
    taskType:             "default",
    lifecycleMode:        "rebuild",
    lifecycleTokensSaved: 2000,
  });

  assert(s.lifecycle_saved_tokens === 2000,
    "lifecycle_saved_tokens = 2000 on rebuild turn",
    `got ${s.lifecycle_saved_tokens}`);
  assert(s.lifecycle_mode === "rebuild", "lifecycle_mode = rebuild");
  assert(componentSum(s) === s.total_estimated_saved_tokens, "total = sum after rebuild turn");
}

section("9. formatSavingsBlock — uses total_tokens_processed_estimate as denominator");
{
  let s = undefined;
  for (let i = 0; i < 3; i++) {
    s = updateSavings(s, {
      originalChars:      500,
      optimizedChars:     450,
      messagesCompressed: 1,
      cacheHits:          1,
      taskType:           "code-fix",
      lifecycleMode:      "normal",
      lifecycleTokensSaved: 0,
    });
  }

  const line = formatSavingsBlock(s);
  assert(typeof line === "string" && line.length > 0,
    "formatSavingsBlock returns non-empty string after 3 turns");
  assert(line.includes("efficiency"), "line includes efficiency %");
  assert(line.includes("cache hits"), "line includes cache hits");
}

section("10. formatDetailedSavings — drift check passes");
{
  let s = undefined;
  for (let i = 0; i < 4; i++) {
    s = updateSavings(s, {
      originalChars:      600,
      optimizedChars:     540,
      messagesCompressed: 2,
      cacheHits:          1,
      taskType:           "implementation",
      lifecycleMode:      i === 2 ? "rebuild" : "normal",
      lifecycleTokensSaved: i === 2 ? 2000 : 0,
    });
  }

  const detail = formatDetailedSavings(s);
  assert(detail.includes("total === component_sum"),
    "formatDetailedSavings shows no drift");
  assert(!detail.includes("DRIFT"),
    "no DRIFT warning in detail output");
}

section("11. turnStats — per-turn deltas are correct");
{
  const seed = {
    prompts_processed:            3,
    prompt_saved_tokens:          10,
    history_saved_tokens:         540,
    read_cache_saved_tokens:      400,
    output_policy_saved_tokens:   50,
    lifecycle_saved_tokens:       2000,
    total_estimated_saved_tokens: 3000,
    total_original_tokens:        1800,
    total_optimized_tokens:       1700,
    total_tokens_processed_estimate: 4700,
    total_cache_hits:             1,
    lifecycle_mode:               "normal",
  };

  const s = updateSavings(seed, {
    originalChars:        400,
    optimizedChars:       380,   // 5 tokens saved
    messagesCompressed:   2,     // 2 × 180 = 360
    cacheHits:            1,     // 1 × 400 = 400
    taskType:             "code-fix",   // policy: 50
    lifecycleMode:        "normal",
    lifecycleTokensSaved: 0,
  });

  const ts = s.turnStats;
  assert(ts !== undefined, "turnStats is present in result");
  assert(ts.prompt_saved    === 5,   `prompt_saved = 5 (got ${ts.prompt_saved})`);
  assert(ts.history_saved   === 360, `history_saved = 360 (got ${ts.history_saved})`);
  assert(ts.cache_saved     === 400, `cache_saved = 400 (got ${ts.cache_saved})`);
  assert(ts.policy_saved    === 50,  `policy_saved = 50 (got ${ts.policy_saved})`);
  assert(ts.lifecycle_saved === 0,   `lifecycle_saved = 0 (got ${ts.lifecycle_saved})`);

  const expectedTurnTotal = 5 + 360 + 400 + 50 + 0;
  assert(ts.total_saved === expectedTurnTotal,
    `total_saved = ${expectedTurnTotal} (got ${ts.total_saved})`);

  // turnStats.total_saved === cumulative delta
  const prevTotal = 3000;
  assert(s.total_estimated_saved_tokens - prevTotal === ts.total_saved,
    "cumulative total increased by exactly total_saved");
}

section("12. turnStats survives session reset (additive safety)");
{
  // Simulate a session reset: seed has large accumulated totals (prior session)
  // but this call starts with undefined (fresh session memory)
  const s1 = updateSavings(undefined, {
    originalChars:      500,
    optimizedChars:     450,
    messagesCompressed: 1,
    cacheHits:          1,
    taskType:           "code-fix",
    lifecycleMode:      "rebuild",
    lifecycleTokensSaved: 2000,
  });

  // turnStats should reflect THIS turn only, not any prior session state
  const ts = s1.turnStats;
  assert(ts.lifecycle_saved === 2000, `turnStats.lifecycle_saved = 2000 after rebuild (got ${ts.lifecycle_saved})`);
  assert(ts.cache_saved     === 400,  `turnStats.cache_saved = 400 (got ${ts.cache_saved})`);
  assert(ts.total_saved     === ts.prompt_saved + ts.history_saved + ts.cache_saved + ts.policy_saved + ts.lifecycle_saved,
    "turnStats.total_saved = sum of components");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Savings aggregation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
