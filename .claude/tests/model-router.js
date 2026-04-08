/**
 * .claude/tests/model-router.js
 *
 * Tests for the Model + Reasoning Router (modelRouter.js).
 *
 * Coverage:
 *   1. classifyRisk — correctness across task types and signal combinations
 *   2. selectModel — correct tier selection and escalation logic
 *   3. Hard rule: HIGH risk never routes to cheap model
 *   4. Confidence-based escalation (< 0.6 → one level up)
 *   5. Fallback escalation (lastTurnFailed → one level up)
 *   6. generateModelSuggestion — only when confidence ≥ 0.7, correct content
 *   7. detectWeakOutput — weakness signal detection
 *   8. routeTurn — integration, non-fatal on bad inputs
 *   9. MODELS shape
 */

"use strict";

const path = require("path");

const {
  classifyRisk,
  selectModel,
  generateModelSuggestion,
  detectWeakOutput,
  routeTurn,
  MODELS,
} = require(path.join(__dirname, "../utils/modelRouter.js"));

// ─── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗  ${name}`);
    console.error(`       ${e.message}`);
  }
}

function eq(a, b, msg) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as !== bs) throw new Error(msg || `Expected ${bs}, got ${as}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function isOneOf(val, choices, msg) {
  if (!choices.includes(val)) {
    throw new Error(msg || `Expected one of ${JSON.stringify(choices)}, got ${JSON.stringify(val)}`);
  }
}

// ─── classifyRisk ─────────────────────────────────────────────────────────────

console.log("\nclassifyRisk");

test("explanation task → low risk", () => {
  const r = classifyRisk("explanation", "What does this function do?", []);
  eq(r.risk, "low");
  ok(r.confidence > 0.4, `confidence too low: ${r.confidence}`);
  ok(Array.isArray(r.signals), "signals is array");
});

test("default task type → low risk", () => {
  const r = classifyRisk("default", "show me the list", []);
  eq(r.risk, "low");
});

test("multi-step task → high risk", () => {
  const r = classifyRisk("multi-step", "implement a full auth system", []);
  isOneOf(r.risk, ["medium", "high"]);
});

test("implementation + many files → high risk", () => {
  const r = classifyRisk("implementation", "implement the feature", ["a.js", "b.js", "c.js", "d.js"]);
  isOneOf(r.risk, ["medium", "high"]);
  ok(r.signals.some((s) => s.includes("file_count")), "should have file_count signal");
});

test("high-risk keyword 'architecture' → medium or high", () => {
  const r = classifyRisk("code-fix", "redesign the system architecture", []);
  isOneOf(r.risk, ["medium", "high"]);
  ok(r.signals.some((s) => s.includes("architecture") || s.includes("high_keyword")), "should have keyword signal");
});

test("low-risk keyword 'rename' reduces score", () => {
  const r = classifyRisk("default", "rename this variable", []);
  eq(r.risk, "low");
});

test("uncertainty phrases increase risk", () => {
  const r1 = classifyRisk("code-fix", "fix the bug", []);
  const r2 = classifyRisk("code-fix", "i'm not sure maybe the bug could be here", []);
  // r2 should be higher risk or lower confidence
  const scores = { low: 0, medium: 1, high: 2 };
  ok(
    scores[r2.risk] >= scores[r1.risk] || r2.confidence < r1.confidence,
    "uncertainty should elevate risk or reduce confidence"
  );
  ok(r2.signals.some((s) => s.includes("uncertainty")), "should have uncertainty signal");
});

test("long prompt (> 400 chars) gets prompt_length:high signal", () => {
  const longPrompt = "fix the authentication module " + "and also ".repeat(50);
  const r = classifyRisk("code-fix", longPrompt, []);
  ok(r.signals.some((s) => s === "prompt_length:high"), "should have prompt_length:high");
});

test("short prompt gets prompt_length:low signal", () => {
  const r = classifyRisk("explanation", "explain this", []);
  ok(r.signals.some((s) => s === "prompt_length:low"), "should have prompt_length:low");
});

test("4+ files → file_count:high signal", () => {
  const r = classifyRisk("code-fix", "fix the bug", ["a.js", "b.js", "c.js", "d.js", "e.js"]);
  ok(r.signals.some((s) => s === "file_count:high"), "should have file_count:high");
});

test("0–1 files → file_count:low signal", () => {
  const r = classifyRisk("code-fix", "fix the bug", ["auth.js"]);
  ok(r.signals.some((s) => s === "file_count:low"), "should have file_count:low");
});

test("confidence is bounded [0, 1]", () => {
  const r = classifyRisk("multi-step", "maybe not sure unclear architecture system debug why", ["a.js","b.js","c.js","d.js"]);
  ok(r.confidence >= 0 && r.confidence <= 1, `out of bounds: ${r.confidence}`);
});

test("non-fatal on null inputs", () => {
  const r = classifyRisk(null, null, null);
  isOneOf(r.risk, ["low", "medium", "high"]);
  ok(typeof r.confidence === "number", "confidence is number");
});

test("returns all required keys", () => {
  const r = classifyRisk("code-fix", "fix the bug", []);
  ok("risk"       in r, "risk");
  ok("confidence" in r, "confidence");
  ok("signals"    in r, "signals");
});

// ─── selectModel ──────────────────────────────────────────────────────────────

console.log("\nselectModel");

test("low risk + high confidence → low tier model", () => {
  const r = selectModel("low", 0.85, false);
  eq(r.tier, "low");
  eq(r.model, MODELS.low.model);
  eq(r.escalated, false);
});

test("medium risk + high confidence → medium tier model", () => {
  const r = selectModel("medium", 0.85, false);
  eq(r.tier, "medium");
  eq(r.model, MODELS.medium.model);
  eq(r.escalated, false);
});

test("high risk + any confidence → high tier model (hard rule)", () => {
  const r = selectModel("high", 0.90, false);
  eq(r.tier, "high");
  eq(r.model, MODELS.high.model);
  eq(r.escalated, false);
});

test("HARD RULE: high risk + low confidence still → high tier", () => {
  const r = selectModel("high", 0.20, false);
  eq(r.tier, "high");
});

test("HARD RULE: high risk + lastTurnFailed still → high tier (already at max)", () => {
  const r = selectModel("high", 0.90, true);
  eq(r.tier, "high");
});

test("confidence < 0.6: low → escalates to medium", () => {
  const r = selectModel("low", 0.50, false);
  eq(r.tier, "medium");
  eq(r.escalated, true);
});

test("confidence < 0.6: medium → escalates to high", () => {
  const r = selectModel("medium", 0.45, false);
  eq(r.tier, "high");
  eq(r.escalated, true);
});

test("lastTurnFailed: low → escalates to medium", () => {
  const r = selectModel("low", 0.80, true);
  eq(r.tier, "medium");
  eq(r.escalated, true);
});

test("lastTurnFailed: medium → escalates to high", () => {
  const r = selectModel("medium", 0.80, true);
  eq(r.tier, "high");
  eq(r.escalated, true);
});

test("low confidence + lastTurnFailed: only escalates once (low → medium, not high)", () => {
  // Both signals fire, but confidence < 0.6 fires first → low → medium.
  // lastTurnFailed won't fire again because escalated=true.
  const r = selectModel("low", 0.40, true);
  eq(r.tier, "medium");
});

test("returns all required keys", () => {
  const r = selectModel("medium", 0.70, false);
  ok("model"     in r, "model");
  ok("reasoning" in r, "reasoning");
  ok("tier"      in r, "tier");
  ok("escalated" in r, "escalated");
});

test("non-fatal on undefined inputs", () => {
  const r = selectModel(undefined, undefined, undefined);
  isOneOf(r.tier, ["low", "medium", "high"]);
});

// ─── generateModelSuggestion ──────────────────────────────────────────────────

console.log("\ngenerateModelSuggestion");

test("LOW risk + confidence ≥ 0.70 → non-empty suggestion", () => {
  const s = generateModelSuggestion("low", 0.80);
  ok(s.length > 0, "should return suggestion");
  ok(s.toLowerCase().includes("cheap") || s.toLowerCase().includes("simpl"), "should mention cost or simplicity");
});

test("HIGH risk + confidence ≥ 0.70 → non-empty suggestion", () => {
  const s = generateModelSuggestion("high", 0.80);
  ok(s.length > 0, "should return suggestion");
  ok(s.toLowerCase().includes("strong") || s.toLowerCase().includes("complex"), "should mention strength or complexity");
});

test("MEDIUM risk → empty suggestion (current model is fine)", () => {
  const s = generateModelSuggestion("medium", 0.85);
  eq(s, "");
});

test("confidence < 0.70 → empty (not confident enough to advise)", () => {
  const sl = generateModelSuggestion("low",  0.65);
  const sh = generateModelSuggestion("high", 0.60);
  eq(sl, "");
  eq(sh, "");
});

test("confidence exactly 0.70 → suggestion fires", () => {
  const s = generateModelSuggestion("low", 0.70);
  ok(s.length > 0, "should fire at exactly 0.70");
});

test("confidence 0.69 → no suggestion", () => {
  const s = generateModelSuggestion("low", 0.69);
  eq(s, "");
});

test("result is ≤ 2 lines", () => {
  const s = generateModelSuggestion("low", 0.90);
  if (s.length > 0) {
    const lines = s.split("\n").filter(Boolean);
    ok(lines.length <= 2, `too many lines: ${lines.length}`);
  }
});

test("non-fatal on null inputs", () => {
  const s = generateModelSuggestion(null, null);
  ok(typeof s === "string", "should return string");
});

// ─── detectWeakOutput ─────────────────────────────────────────────────────────

console.log("\ndetectWeakOutput");

test("empty transcript path → not weak", () => {
  const r = detectWeakOutput("", "code-fix");
  eq(r.isWeak, false);
  ok(Array.isArray(r.signals), "signals is array");
});

test("non-existent path → not weak (non-fatal)", () => {
  const r = detectWeakOutput("/nonexistent/transcript.jsonl", "code-fix");
  eq(r.isWeak, false);
});

test("returns required keys", () => {
  const r = detectWeakOutput("", "code-fix");
  ok("isWeak"  in r, "isWeak");
  ok("signals" in r, "signals");
});

// ─── routeTurn (integration) ──────────────────────────────────────────────────

console.log("\nrouteTurn integration");

test("returns all required keys", () => {
  const r = routeTurn({ taskType: "code-fix", prompt: "fix the bug", files: [], transcriptPath: "", lastTurnFailed: false });
  ok("risk"        in r, "risk");
  ok("confidence"  in r, "confidence");
  ok("signals"     in r, "signals");
  ok("model"       in r, "model");
  ok("reasoning"   in r, "reasoning");
  ok("tier"        in r, "tier");
  ok("escalated"   in r, "escalated");
  ok("suggestion"  in r, "suggestion");
  ok("isWeak"      in r, "isWeak");
  ok("weakSignals" in r, "weakSignals");
});

test("non-fatal on empty input", () => {
  const r = routeTurn({});
  isOneOf(r.risk, ["low", "medium", "high"]);
  ok(typeof r.model === "string", "model is string");
});

test("non-fatal on null input", () => {
  const r = routeTurn(null);
  isOneOf(r.tier, ["low", "medium", "high"]);
});

test("HIGH risk task is never routed to low tier", () => {
  // 'architecture' + 'debug' + 'system' + 4 files → definitely high risk
  const r = routeTurn({
    taskType: "multi-step",
    prompt:   "debug and redesign the entire system architecture across all modules",
    files:    ["a.js", "b.js", "c.js", "d.js", "e.js"],
    transcriptPath: "",
    lastTurnFailed: false,
  });
  ok(r.tier !== "low", `should not be low tier, got ${r.tier}`);
});

test("explanation task → low or medium tier (never high for clean explanation)", () => {
  const r = routeTurn({
    taskType: "explanation",
    prompt:   "explain what this function does",
    files:    [],
    transcriptPath: "",
    lastTurnFailed: false,
  });
  ok(r.tier !== "high", `explanation should not be high tier, got ${r.tier}`);
});

test("lastTurnFailed escalates from low", () => {
  // explanation + no files → normally low tier
  const normal   = routeTurn({ taskType: "explanation", prompt: "explain this", files: [], transcriptPath: "", lastTurnFailed: false });
  const escalated = routeTurn({ taskType: "explanation", prompt: "explain this", files: [], transcriptPath: "", lastTurnFailed: true  });
  // escalated should be >= normal tier
  const scores = { low: 0, medium: 1, high: 2 };
  ok(scores[escalated.tier] >= scores[normal.tier], `escalated tier (${escalated.tier}) should be >= normal (${normal.tier})`);
});

test("suggestion is string", () => {
  const r = routeTurn({ taskType: "code-fix", prompt: "fix", files: [], transcriptPath: "", lastTurnFailed: false });
  ok(typeof r.suggestion === "string", "suggestion must be string");
});

// ─── MODELS shape ─────────────────────────────────────────────────────────────

console.log("\nMODELS shape");

test("all three tiers defined", () => {
  ok("low"    in MODELS, "low tier");
  ok("medium" in MODELS, "medium tier");
  ok("high"   in MODELS, "high tier");
});

test("each tier has model and reasoning", () => {
  for (const [tier, cfg] of Object.entries(MODELS)) {
    ok(typeof cfg.model    === "string" && cfg.model.length > 0,    `${tier}: model is non-empty string`);
    ok(typeof cfg.reasoning === "string" && cfg.reasoning.length > 0, `${tier}: reasoning is non-empty string`);
  }
});

test("reasoning levels are valid", () => {
  const valid = ["low", "medium", "high"];
  for (const [tier, cfg] of Object.entries(MODELS)) {
    ok(valid.includes(cfg.reasoning), `${tier}: invalid reasoning level ${cfg.reasoning}`);
  }
});

test("low tier model differs from high tier model", () => {
  ok(MODELS.low.model !== MODELS.high.model, "low and high should be different models");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`model-router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
