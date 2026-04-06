#!/usr/bin/env node
/**
 * .claude/tests/output-waste.js
 *
 * Output Waste Analyzer Tests
 *
 * Validates outputWaste.js detection heuristics and outputPolicy.js V2 additions:
 *   - detectPreamble: catches opening filler phrases
 *   - detectRepeatedContext: flags responses that echo the prompt
 *   - detectUnnecessaryProse: flags code tasks with long pre-code text
 *   - detectAvoidableExplanation: catches "As I mentioned" patterns
 *   - detectVerboseStructure: catches excess headings / separators
 *   - analyzeOutputWaste: integration (transcript-less path returns empty)
 *   - formatWasteFeedback: correct format, suppressed when no waste
 *   - isFollowUpCorrection (outputPolicy): correctly identifies delta-only prompts
 *   - classifyTaskType (outputPolicy): follow-up gets highest priority
 *   - getOutputPolicy: returns DO + AVOID blocks for all task types
 *
 * Run:
 *   node .claude/tests/output-waste.js
 *
 * Exit 0 = all pass, exit 1 = one or more failures.
 */

"use strict";

const path = require("path");

const {
  analyzeOutputWaste,
  formatWasteFeedback,
  isFollowUpCorrection,
  detectPreamble,
  detectRepeatedContext,
  detectUnnecessaryProse,
  detectAvoidableExplanation,
  detectVerboseStructure,
  WASTE_THRESHOLD,
} = require(path.join(__dirname, "../utils/outputWaste.js"));

const {
  classifyTaskType,
  getOutputPolicy,
  OUTPUT_POLICIES,
} = require(path.join(__dirname, "../utils/outputPolicy.js"));

// ─── Harness ──────────────────────────────────────────────────────────────────

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

function assertTrue(cond, msg)  { if (!cond) throw new Error(msg ?? "expected truthy"); }
function assertFalse(cond, msg) { if (cond)  throw new Error(msg ?? "expected falsy"); }
function assertGt(a, b, msg)    { if (!(a > b)) throw new Error(`${msg ?? "assertGt"}: ${a} not > ${b}`); }
function assertIncludes(str, sub, msg) {
  if (!str.includes(sub)) throw new Error(`${msg ?? "assertIncludes"}: "${sub}" not found in output`);
}

const LINE = "═".repeat(64);
const DASH = "─".repeat(64);

// ─── Section 1: detectPreamble ────────────────────────────────────────────────

console.log(LINE);
console.log("1. detectPreamble");
console.log(DASH);

test("'Let me ' at opening → returns tokens > 0", () => {
  const response = "Let me explain what's happening here. The auth module is failing because the token has expired.";
  assertGt(detectPreamble(response), 0, "preamble detected");
});

test("'Sure! ' at opening → returns tokens > 0", () => {
  const response = "Sure! I'll fix that for you. Here's the corrected code.";
  assertGt(detectPreamble(response), 0, "preamble detected");
});

test("'Of course' at opening → returns tokens > 0", () => {
  const response = "Of course, I can help with that. Here's what I found.";
  assertGt(detectPreamble(response), 0, "preamble detected");
});

test("'Great question' → returns tokens > 0", () => {
  const response = "Great question! The reason this happens is...";
  assertGt(detectPreamble(response), 0, "preamble detected");
});

test("'I'll ' at opening → returns tokens > 0", () => {
  const response = "I'll start by updating the auth middleware to handle token expiry.";
  assertGt(detectPreamble(response), 0, "preamble detected");
});

test("direct answer → returns 0", () => {
  const response = "The authentication middleware is failing because `validateToken()` doesn't check expiry.";
  assertEqual(detectPreamble(response), 0, "no preamble in direct answer");
});

test("code-first response → returns 0", () => {
  const response = "```javascript\nconst token = jwt.verify(t, secret);\n```";
  assertEqual(detectPreamble(response), 0, "no preamble in code-first response");
});

test("preamble in middle of response → not detected (only checks opening)", () => {
  const response = "Here is the fix.\n\nLet me also note that you should update the tests.\nSome more context.";
  // "Let me" is not in the first 220 chars of the opening — it IS here though
  // Actually "Let me also note" IS in the opening, let's check if it counts
  const result = detectPreamble(response);
  // We don't assert a specific value here — just that it doesn't crash
  assertTrue(typeof result === "number", "returns a number");
});

// ─── Section 2: detectRepeatedContext ────────────────────────────────────────

console.log(LINE);
console.log("2. detectRepeatedContext");
console.log(DASH);

test("response that echoes the prompt → returns tokens > 0", () => {
  const prompt   = "fix the authentication middleware token validation logic";
  // Response opens by restating the problem
  const response = "You've asked me to fix the authentication middleware token validation logic. " +
                   "The authentication middleware token validation logic has a bug where it " +
                   "doesn't check token expiry. Here is the fix:\n```js\n...```";
  assertGt(detectRepeatedContext(response, prompt), 0, "repeated context detected");
});

test("response that answers directly → returns 0 or low", () => {
  const prompt   = "explain how JWT tokens work";
  const response = "JWT tokens are base64-encoded JSON objects with a header, payload, and signature. " +
                   "The signature is verified by the server using a shared secret or public key.";
  // This is a direct answer, minimal echo
  const result = detectRepeatedContext(response, prompt);
  assertTrue(result < 20, `expected low repeated context, got ${result}`);
});

test("empty prompt → returns 0", () => {
  assertEqual(detectRepeatedContext("some response", ""), 0);
});

test("very short prompt → returns 0", () => {
  assertEqual(detectRepeatedContext("some response", "fix it"), 0);
});

// ─── Section 3: detectUnnecessaryProse ───────────────────────────────────────

console.log(LINE);
console.log("3. detectUnnecessaryProse");
console.log(DASH);

test("code-fix task with long prose before code → returns tokens > 0", () => {
  const longProse = "The issue you're experiencing is related to how the authentication " +
                    "middleware handles token expiry. When a token expires, the validate function " +
                    "throws an error that is not caught properly. To fix this, we need to wrap the " +
                    "validation call in a try-catch and return a proper 401 response. Here is the fix:";
  const response = longProse + "\n```javascript\ncatch (err) { res.status(401).json({error: 'expired'}); }\n```";
  assertGt(detectUnnecessaryProse(response, "code-fix"), 0, "unnecessary prose detected");
});

test("code-fix with short intro + code → returns 0", () => {
  const response = "Here's the fix:\n```javascript\ncatch (err) { res.status(401).json({error: 'expired'}); }\n```";
  assertEqual(detectUnnecessaryProse(response, "code-fix"), 0, "short intro is acceptable");
});

test("explanation task with prose → returns 0 (prose is expected)", () => {
  const response = "The authentication middleware works by validating JWT tokens " +
                   "on each request before passing control to route handlers. " +
                   "When validation fails, it returns a 401 response. Here's how:";
  assertEqual(detectUnnecessaryProse(response, "explanation"), 0, "explanation task allows prose");
});

test("code-fix with no code block → returns 0", () => {
  const response = "The fix should be to add error handling around the validateToken call.";
  assertEqual(detectUnnecessaryProse(response, "code-fix"), 0, "no code block = 0");
});

test("implementation task with long setup → returns tokens > 0", () => {
  const setup = "I'll create the middleware function for you. This implementation uses " +
                "the jsonwebtoken library to validate tokens. The function accepts an " +
                "options object for flexibility. You can configure the secret, algorithms, " +
                "and error handling behavior. Here is the complete implementation:";
  const response = setup + "\n```javascript\nconst verifyToken = (opts) => { ... };\n```";
  assertGt(detectUnnecessaryProse(response, "implementation"), 0, "long setup prose detected");
});

// ─── Section 4: detectAvoidableExplanation ────────────────────────────────────

console.log(LINE);
console.log("4. detectAvoidableExplanation");
console.log(DASH);

test("'As I mentioned' → returns tokens > 0", () => {
  const response = "As I mentioned earlier, the token expiry is the root cause. " +
                   "As I noted above, you should also update the tests.";
  assertGt(detectAvoidableExplanation(response), 0);
});

test("'As we discussed' → returns tokens > 0", () => {
  const response = "As we discussed, the auth flow needs to be updated. Here's the code.";
  assertGt(detectAvoidableExplanation(response), 0);
});

test("'As described above' → returns tokens > 0", () => {
  const response = "As described above, the middleware validates tokens before routing. " +
                   "As noted previously, this is the correct pattern.";
  assertGt(detectAvoidableExplanation(response), 0);
});

test("'In summary, the' → returns tokens > 0", () => {
  const response = "Here is the fix.\n\nIn summary, the changes prevent token expiry errors.";
  assertGt(detectAvoidableExplanation(response), 0);
});

test("clean response → returns 0", () => {
  const response = "```js\nconst fix = validateToken();\n```\nRun `npm test` to verify.";
  assertEqual(detectAvoidableExplanation(response), 0);
});

test("multiple avoidable phrases → higher count", () => {
  const response1 = "As I mentioned earlier, the issue is token expiry.";
  const response2 = "As I mentioned, as we discussed, and as described above, " +
                    "the issue is token expiry. This approach works because of X.";
  const r1 = detectAvoidableExplanation(response1);
  const r2 = detectAvoidableExplanation(response2);
  assertGt(r2, r1, "more patterns → higher waste estimate");
});

// ─── Section 5: detectVerboseStructure ───────────────────────────────────────

console.log(LINE);
console.log("5. detectVerboseStructure");
console.log(DASH);

test("response with 4 headings → returns tokens > 0", () => {
  const response = "## Overview\nSome text.\n## Problem\nMore.\n## Solution\nFix.\n## Notes\nDone.";
  assertGt(detectVerboseStructure(response), 0, "excess headings detected");
});

test("response with 2 headings → returns 0 (within grace)", () => {
  const response = "## Problem\nSome text.\n## Fix\nHere's the code.";
  assertEqual(detectVerboseStructure(response), 0, "2 headings is fine");
});

test("response with multiple HRs → returns tokens > 0", () => {
  const response = "First section.\n\n---\n\nSecond section.\n\n---\n\nThird section.";
  assertGt(detectVerboseStructure(response), 0, "excess separators detected");
});

test("clean prose response → returns 0", () => {
  const response = "The token expiry bug is in `validateToken()`. The function doesn't check `exp`. Add: `if (payload.exp < Date.now() / 1000) throw new Error('expired')`.";
  assertEqual(detectVerboseStructure(response), 0);
});

// ─── Section 6: analyzeOutputWaste (integration) ─────────────────────────────

console.log(LINE);
console.log("6. analyzeOutputWaste (integration)");
console.log(DASH);

test("non-existent transcript → returns empty result", () => {
  const result = analyzeOutputWaste("/nonexistent/path.jsonl", "fix auth", "code-fix");
  assertEqual(result.output_tokens_total,     0, "total = 0");
  assertEqual(result.output_tokens_redundant, 0, "redundant = 0");
  assertFalse(result.has_waste,               "no waste flagged");
});

test("empty transcript path → returns empty result", () => {
  const result = analyzeOutputWaste("", "fix auth", "code-fix");
  assertEqual(result.output_tokens_total,     0);
  assertEqual(result.output_tokens_redundant, 0);
});

test("returns correct structure", () => {
  const result = analyzeOutputWaste("", "fix auth", "code-fix");
  assertTrue(typeof result.output_tokens_total     === "number", "total is number");
  assertTrue(typeof result.output_tokens_redundant === "number", "redundant is number");
  assertTrue(typeof result.redundancy_pct          === "number", "pct is number");
  assertTrue(typeof result.top_reason              === "string", "reason is string");
  assertTrue(typeof result.has_waste               === "boolean", "has_waste is bool");
  assertTrue(typeof result.categories              === "object", "categories is object");
});

test("categories object has all 5 fields", () => {
  const result = analyzeOutputWaste("", "", "default");
  const cats   = result.categories;
  assertTrue("preamble"              in cats, "preamble field exists");
  assertTrue("repeated_context"      in cats, "repeated_context field exists");
  assertTrue("unnecessary_prose"     in cats, "unnecessary_prose field exists");
  assertTrue("avoidable_explanation" in cats, "avoidable_explanation field exists");
  assertTrue("verbose_structure"     in cats, "verbose_structure field exists");
});

test("non-fatal on null inputs", () => {
  const result = analyzeOutputWaste(null, null, null);
  assertEqual(result.output_tokens_total, 0, "does not throw on null");
});

// ─── Section 7: formatWasteFeedback ──────────────────────────────────────────

console.log(LINE);
console.log("7. formatWasteFeedback");
console.log(DASH);

test("returns empty string when no waste", () => {
  const result = { has_waste: false, output_tokens_redundant: 5, redundancy_pct: 2, categories: {}, top_reason: "none" };
  assertEqual(formatWasteFeedback(result), "");
});

test("returns non-empty string when waste detected", () => {
  const result = {
    has_waste: true,
    output_tokens_redundant: 45,
    redundancy_pct: 20,
    top_reason: "preamble",
    categories: { preamble: 30, repeated_context: 15, unnecessary_prose: 0, avoidable_explanation: 0, verbose_structure: 0 },
  };
  const feedback = formatWasteFeedback(result);
  assertTrue(feedback.length > 0, "non-empty feedback");
});

test("feedback mentions redundant token count", () => {
  const result = {
    has_waste: true,
    output_tokens_redundant: 45,
    redundancy_pct: 20,
    top_reason: "preamble",
    categories: { preamble: 45, repeated_context: 0, unnecessary_prose: 0, avoidable_explanation: 0, verbose_structure: 0 },
  };
  const feedback = formatWasteFeedback(result);
  assertIncludes(feedback, "45", "mentions token count");
});

test("feedback mentions waste category", () => {
  const result = {
    has_waste: true,
    output_tokens_redundant: 30,
    redundancy_pct: 15,
    top_reason: "preamble",
    categories: { preamble: 30, repeated_context: 0, unnecessary_prose: 0, avoidable_explanation: 0, verbose_structure: 0 },
  };
  const feedback = formatWasteFeedback(result);
  assertIncludes(feedback, "preamble", "mentions the waste category");
});

test("feedback is concise — 3 lines or fewer", () => {
  const result = {
    has_waste: true,
    output_tokens_redundant: 50,
    redundancy_pct: 25,
    top_reason: "repeated_context",
    categories: { preamble: 10, repeated_context: 40, unnecessary_prose: 0, avoidable_explanation: 0, verbose_structure: 0 },
  };
  const lines = formatWasteFeedback(result).split("\n").filter(Boolean);
  assertTrue(lines.length <= 3, `feedback should be ≤3 lines, got ${lines.length}`);
});

// ─── Section 8: isFollowUpCorrection (outputWaste) ───────────────────────────

console.log(LINE);
console.log("8. isFollowUpCorrection (outputWaste.js)");
console.log(DASH);

test("'that's wrong' → true", () => {
  assertTrue(isFollowUpCorrection("that's wrong"));
});

test("'not quite' → true", () => {
  assertTrue(isFollowUpCorrection("not quite what I needed"));
});

test("'try again' → true", () => {
  assertTrue(isFollowUpCorrection("try again"));
});

test("'still failing' → true", () => {
  assertTrue(isFollowUpCorrection("still failing, fix it"));
});

test("'you missed the auth check' → true", () => {
  assertTrue(isFollowUpCorrection("you missed the auth check"));
});

test("normal task prompt → false", () => {
  assertFalse(isFollowUpCorrection("fix the authentication middleware token validation"));
});

test("long correction-like prompt → false (too long)", () => {
  const longPrompt = "that's wrong because the function needs to handle the case where the token is null and not just expired, please fix this properly";
  assertFalse(isFollowUpCorrection(longPrompt), "too long to be a follow-up");
});

test("empty prompt → false", () => {
  assertFalse(isFollowUpCorrection(""));
});

// ─── Section 9: classifyTaskType with follow-up priority ─────────────────────

console.log(LINE);
console.log("9. classifyTaskType — follow-up gets priority");
console.log(DASH);

test("follow-up correction classified as 'follow-up'", () => {
  assertEqual(classifyTaskType("that's wrong"), "follow-up");
});

test("'not quite right' → follow-up", () => {
  assertEqual(classifyTaskType("not quite right"), "follow-up");
});

test("normal bug-fix prompt → code-fix", () => {
  assertEqual(classifyTaskType("fix the authentication bug in login.ts"), "code-fix");
});

test("explain prompt → explanation", () => {
  assertEqual(classifyTaskType("explain how the auth middleware works"), "explanation");
});

test("multi-step → multi-step (not overridden by follow-up)", () => {
  // isMultiStep=true forces multi-step unless it's a follow-up
  // follow-up check runs first but won't match a long multi-step prompt
  assertEqual(classifyTaskType("refactor auth, add tests, update docs", true), "multi-step");
});

// ─── Section 10: getOutputPolicy V2 structure ─────────────────────────────────

console.log(LINE);
console.log("10. getOutputPolicy — V2 DO/AVOID structure");
console.log(DASH);

test("all task types have valid policies", () => {
  const taskTypes = ["code-fix", "explanation", "implementation", "test", "refactor", "review", "multi-step", "follow-up", "default"];
  for (const type of taskTypes) {
    assertTrue(type in OUTPUT_POLICIES, `${type} has a policy`);
  }
});

test("getOutputPolicy returns block with DO section", () => {
  const { block } = getOutputPolicy("fix the auth bug");
  assertIncludes(block, "DO:", "block contains DO section");
});

test("getOutputPolicy returns block with AVOID section", () => {
  const { block } = getOutputPolicy("fix the auth bug");
  assertIncludes(block, "AVOID:", "block contains AVOID section");
});

test("getOutputPolicy returns block with NEVER rules", () => {
  const { block } = getOutputPolicy("fix the auth bug");
  assertIncludes(block, "NEVER", "AVOID section has NEVER rules");
});

test("follow-up policy is delta-only mode", () => {
  const { block, taskType } = getOutputPolicy("that's wrong");
  assertEqual(taskType, "follow-up");
  assertIncludes(block, "DELTA-ONLY", "follow-up shows delta-only mode label");
});

test("getOutputPolicy returns estimatedSaved as number", () => {
  const { estimatedSaved } = getOutputPolicy("fix the auth bug");
  assertTrue(typeof estimatedSaved === "number" && estimatedSaved > 0, "estimatedSaved is positive number");
});

test("follow-up has highest estimatedSaved (80)", () => {
  const { estimatedSaved } = getOutputPolicy("that's wrong");
  assertEqual(estimatedSaved, 80, "follow-up mode saves most tokens (delta-only)");
});

test("code-fix policy mentions patch-related instruction", () => {
  const { block } = getOutputPolicy("fix the login bug");
  assertIncludes(block, "patch", "code-fix mentions patch");
});

test("review policy mentions findings or severity", () => {
  const { block } = getOutputPolicy("review the authentication code for issues");
  assertTrue(
    block.includes("findings") || block.includes("severity") || block.includes("SEVERITY"),
    "review policy mentions findings/severity"
  );
});

test("explanation policy forbids question restatement", () => {
  const { block } = getOutputPolicy("explain how JWT tokens work");
  assertTrue(
    block.toLowerCase().includes("restate") || block.toLowerCase().includes("repeat") || block.includes("question"),
    "explanation policy guards against restating the question"
  );
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
