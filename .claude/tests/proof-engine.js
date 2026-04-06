/**
 * .claude/tests/proof-engine.js
 *
 * Tests for the Proof Engine — Before vs After Token Estimates.
 * Run: node .claude/tests/proof-engine.js
 */

"use strict";

const path = require("path");
const {
  computeSessionProof,
  computeTurnProof,
  formatProofLine,
  validateProof,
} = require(path.resolve(__dirname, "../utils/proofEngine.js"));

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

// ─── 1. Core Invariants ───────────────────────────────────────────────────────

section("1. Invariants — without = with + saved");
{
  const savings = {
    total_optimized_tokens:          1000,
    total_estimated_saved_tokens:    500,
  };
  const proof = computeSessionProof(savings);

  assert(proof.estimated_total_tokens_without_optimizer === 1500,
    "without = 1500 (1000 + 500)",
    `got ${proof.estimated_total_tokens_without_optimizer}`);
  assert(proof.estimated_total_tokens_with_optimizer === 1000,
    "with = 1000",
    `got ${proof.estimated_total_tokens_with_optimizer}`);
  assert(proof.estimated_total_tokens_saved === 500,
    "saved = 500",
    `got ${proof.estimated_total_tokens_saved}`);
  assert(proof.estimated_total_tokens_without_optimizer - proof.estimated_total_tokens_with_optimizer
         === proof.estimated_total_tokens_saved,
    "without - with === saved (exact)");
}

section("2. Efficiency percent calculation");
{
  const savings = {
    total_optimized_tokens:       6000,
    total_estimated_saved_tokens: 4000,
  };
  const proof = computeSessionProof(savings);
  // saved=4000, without=10000 → 40%
  assert(proof.estimated_efficiency_percent === 40,
    "efficiency = 40% when saved=4000, without=10000",
    `got ${proof.estimated_efficiency_percent}%`);
}

section("3. Efficiency is clamped to 100%");
{
  const savings = {
    total_optimized_tokens:       0,
    total_estimated_saved_tokens: 1000,
  };
  const proof = computeSessionProof(savings);
  assert(proof.estimated_efficiency_percent <= 100,
    "efficiency cannot exceed 100%",
    `got ${proof.estimated_efficiency_percent}%`);
}

section("4. Zero savings case");
{
  const savings = {
    total_optimized_tokens:       500,
    total_estimated_saved_tokens: 0,
  };
  const proof = computeSessionProof(savings);
  assert(proof.estimated_total_tokens_saved === 0,     "saved = 0");
  assert(proof.estimated_efficiency_percent === 0,     "efficiency = 0%");
  assert(proof.estimated_total_tokens_without_optimizer === 500,
    "without = with when saved = 0");
}

section("5. Null/undefined savings gracefully handled");
{
  const proof = computeSessionProof(null);
  assert(proof.estimated_total_tokens_without_optimizer === 0, "without = 0 on null");
  assert(proof.estimated_total_tokens_saved             === 0, "saved = 0 on null");
  assert(proof.estimated_efficiency_percent             === 0, "efficiency = 0% on null");
}

// ─── 2. validateProof ─────────────────────────────────────────────────────────

section("6. validateProof — valid proof passes");
{
  const proof = computeSessionProof({
    total_optimized_tokens:       800,
    total_estimated_saved_tokens: 200,
  });
  const err = validateProof(proof);
  assert(err === null, "validateProof returns null for valid proof", err ?? "");
}

section("7. validateProof — catches invariant violation");
{
  // Manually construct a broken proof
  const brokenProof = {
    estimated_total_tokens_without_optimizer: 500,
    estimated_total_tokens_with_optimizer:    600,  // with > without — invalid
    estimated_total_tokens_saved:             200,
    estimated_efficiency_percent:             40,
  };
  const err = validateProof(brokenProof);
  assert(err !== null, "validateProof catches without < with", err ?? "(no error)");
}

// ─── 3. computeTurnProof ─────────────────────────────────────────────────────

section("8. computeTurnProof — correct per-turn estimates");
{
  const result = computeTurnProof({
    optimizedChars: 400,   // 100 tokens
    turnStats:      { total_saved: 50 },
  });
  assert(result.with_tokens    === 100, `with = 100 (got ${result.with_tokens})`);
  assert(result.saved_tokens   === 50,  `saved = 50 (got ${result.saved_tokens})`);
  assert(result.without_tokens === 150, `without = 150 (got ${result.without_tokens})`);
  assert(result.without_tokens === result.with_tokens + result.saved_tokens,
    "without = with + saved for turn proof");
}

section("9. computeTurnProof — zero savings turn");
{
  const result = computeTurnProof({ optimizedChars: 200, turnStats: {} });
  assert(result.saved_tokens   === 0, "saved = 0 when no turnStats");
  assert(result.without_tokens === result.with_tokens, "without = with when no savings");
}

// ─── 4. formatProofLine ───────────────────────────────────────────────────────

section("10. formatProofLine — correct format");
{
  const proof = computeSessionProof({
    total_optimized_tokens:       10107,
    total_estimated_saved_tokens: 5871,
  });
  const line = formatProofLine(proof);
  assert(typeof line === "string" && line.length > 0, "returns non-empty string");
  assert(line.includes("5871"), "includes saved token count");
  assert(line.includes("→"),    "includes arrow separator");
  assert(line.includes("%"),    "includes efficiency percent");
}

section("11. formatProofLine — empty on no savings");
{
  const proof = computeSessionProof({
    total_optimized_tokens:       500,
    total_estimated_saved_tokens: 0,
  });
  const line = formatProofLine(proof);
  assert(line === "", "returns empty string when saved = 0");
}

// ─── 5. Real-world scenario ───────────────────────────────────────────────────

section("12. Real-world scenario — 71 prompts");
{
  const savings = {
    total_optimized_tokens:       10107,
    total_estimated_saved_tokens: 5871,
  };
  const proof = computeSessionProof(savings);

  assert(proof.estimated_total_tokens_without_optimizer === 15978,
    "without = 15978 (10107 + 5871)",
    `got ${proof.estimated_total_tokens_without_optimizer}`);
  assert(proof.estimated_efficiency_percent === 37,
    "efficiency = 37%",
    `got ${proof.estimated_efficiency_percent}%`);
  assert(validateProof(proof) === null, "invariants hold in real-world scenario");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Proof Engine: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
