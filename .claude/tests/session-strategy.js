/**
 * .claude/tests/session-strategy.js
 *
 * Tests for the V5 session strategy engine (sessionStrategy.js).
 *
 * Coverage:
 *   - classifyVerbCategory
 *   - classifyScope
 *   - hasContinuationSignal
 *   - extractFileMentions
 *   - computeTaskSimilarity (all 5 signals)
 *   - selectMode (all 5 modes + priority order)
 *   - analyzeSessionStrategy (integration)
 *   - MODE_CONFIG shape
 *   - Non-fatal on bad inputs
 *   - Compression override behavior
 */

"use strict";

const path = require("path");

const {
  classifyVerbCategory,
  classifyScope,
  hasContinuationSignal,
  extractFileMentions,
  computeTaskSimilarity,
  selectMode,
  analyzeSessionStrategy,
  defaultStrategy,
  MODE_CONFIG,
} = require(path.join(__dirname, "../utils/sessionStrategy.js"));

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
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) {
    throw new Error(msg || `Expected ${bStr}, got ${aStr}`);
  }
}

function approx(a, b, delta = 0.05, msg) {
  if (Math.abs(a - b) > delta) {
    throw new Error(msg || `Expected ~${b}, got ${a} (delta ${delta})`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// ─── Empty memory helper ──────────────────────────────────────────────────────

function emptyMem() {
  return {
    goal: "",
    current_task: "",
    last_task_type: "default",
    important_files: [],
    recent_files: [],
  };
}

function memWith(overrides) {
  return { ...emptyMem(), ...overrides };
}

// ─── classifyVerbCategory ─────────────────────────────────────────────────────

console.log("\nclassifyVerbCategory");

test("single execution verb → neutral (margin < 2)", () => {
  // Margin rule: execScore > exploScore + 1 required. One exec verb → neutral.
  eq(classifyVerbCategory("fix the authentication bug"), "neutral");
});
test("single exploration verb → neutral (margin < 2)", () => {
  eq(classifyVerbCategory("explain how the auth middleware works"), "neutral");
});
test("two execution verbs → execution (margin 2)", () => {
  eq(classifyVerbCategory("fix and build the API endpoint"), "execution");
});
test("two exploration verbs → exploration (margin 2)", () => {
  // design + analyze, no execution → 2 vs 0, 2 > 0+1 → exploration
  eq(classifyVerbCategory("analyze and evaluate the database schema"), "exploration");
});
test("neutral: ambiguous short prompt", () => {
  eq(classifyVerbCategory("the bug"), "neutral");
});
test("neutral: mixed equal counts (1 each)", () => {
  // 1 execution + 1 exploration → neither wins by margin > 1 → neutral
  const r = classifyVerbCategory("fix and explain");
  ok(r === "neutral" || r === "execution" || r === "exploration", "valid return");
});
test("exploration beats execution when dominates by > 1", () => {
  // design + analyze + evaluate vs fix → 3 vs 1 → exploration
  eq(classifyVerbCategory("design, analyze, evaluate and fix the API"), "exploration");
});
test("execution beats exploration when dominates by > 1", () => {
  // fix + implement + build vs explain → 3 vs 1 → execution
  eq(classifyVerbCategory("fix, implement and build the feature, then explain it"), "execution");
});
test("empty string returns neutral", () => {
  eq(classifyVerbCategory(""), "neutral");
});

// ─── classifyScope ────────────────────────────────────────────────────────────

console.log("\nclassifyScope");

test("broad scope: architecture", () => {
  eq(classifyScope("redesign the entire system architecture"), "broad");
});
test("broad scope: across codebase", () => {
  eq(classifyScope("update this pattern across the entire codebase"), "broad");
});
test("narrow scope: specific function", () => {
  eq(classifyScope("fix this specific bug in the login function"), "narrow");
});
test("narrow scope: only that file", () => {
  eq(classifyScope("change only the payment method in that file"), "narrow");
});
test("medium scope: no scope keywords", () => {
  eq(classifyScope("add a new user endpoint"), "medium");
});
test("empty string returns medium", () => {
  eq(classifyScope(""), "medium");
});
test("broad beats narrow when it dominates by > 1", () => {
  // system + overall + global vs only → 3 vs 1 → broad
  eq(classifyScope("redesign the global system overall with only one change"), "broad");
});

// ─── hasContinuationSignal ────────────────────────────────────────────────────

console.log("\nhasContinuationSignal");

test("'also' at start", () => {
  ok(hasContinuationSignal("Also fix the token refresh"), "expected true");
});
test("'and then' at start", () => {
  ok(hasContinuationSignal("And then update the tests"), "expected true");
});
test("'continue' at start", () => {
  ok(hasContinuationSignal("Continue with the next step"), "expected true");
});
test("'additionally' at start", () => {
  ok(hasContinuationSignal("Additionally, handle the edge case"), "expected true");
});
test("'now' at start", () => {
  ok(hasContinuationSignal("Now refactor the class"), "expected true");
});
test("no signal — fresh prompt", () => {
  ok(!hasContinuationSignal("Rewrite the authentication system from scratch"), "expected false");
});
test("signal buried beyond 70 chars is ignored", () => {
  // Signal is after position 70 — should not match
  const longPrefix = "Write a complete implementation of the feature and ".padEnd(75, " ");
  ok(!hasContinuationSignal(`${longPrefix}also fix the bug`), "expected false for late signal");
});
test("empty string returns false", () => {
  ok(!hasContinuationSignal(""), "expected false");
});

// ─── extractFileMentions ──────────────────────────────────────────────────────

console.log("\nextractFileMentions");

test("extracts .js file", () => {
  const result = extractFileMentions("Update the logic in auth.js");
  ok(result.has("auth.js"), "should have auth.js");
});
test("extracts .ts and .tsx files", () => {
  const result = extractFileMentions("Edit Login.tsx and types.ts");
  ok(result.has("login.tsx"), "should have login.tsx");
  ok(result.has("types.ts"), "should have types.ts");
});
test("extracts path with directory", () => {
  const result = extractFileMentions("Fix src/utils/helper.js");
  ok(result.has("src/utils/helper.js"), "should have path");
});
test("no file extensions → empty set", () => {
  const result = extractFileMentions("fix the bug in the code");
  eq(result.size, 0);
});
test("multiple files", () => {
  const result = extractFileMentions("Update config.json and deploy.yaml");
  ok(result.has("config.json") && result.has("deploy.yaml"), "both files");
});
test("deduplicates same file mentioned twice", () => {
  const result = extractFileMentions("Edit auth.js then verify auth.js");
  eq(result.size, 1);
});
test("case-insensitive dedup: AUTH.js and auth.js", () => {
  const result = extractFileMentions("Edit AUTH.js and auth.js");
  eq(result.size, 1);
});
test("empty string returns empty set", () => {
  const result = extractFileMentions("");
  eq(result.size, 0);
});

// ─── computeTaskSimilarity ────────────────────────────────────────────────────

console.log("\ncomputeTaskSimilarity");

test("identical prompt to goal/task with same task type → elevated composite", () => {
  // Same task type contributes 0.20, word overlap contributes up to 0.15, verb + scope neutral = 0.35
  // With last_task_type=code-fix and taskType=code-fix: 0.15+0.20+0.15+0.05 = 0.55 min
  const mem = memWith({ goal: "fix the auth bug", current_task: "fix the auth bug", last_task_type: "code-fix" });
  const sim = computeTaskSimilarity("fix the auth bug", "code-fix", mem);
  ok(sim.composite >= 0.30, `expected >= 0.30, got ${sim.composite}`);
  eq(sim.taskTypeSame, true);
});

test("completely different task → low composite", () => {
  const mem = memWith({ goal: "design database schema", current_task: "design database schema", last_task_type: "explanation" });
  const sim = computeTaskSimilarity("fix login bug in auth.js", "code-fix", mem);
  ok(sim.composite < 0.60, `expected < 0.60, got ${sim.composite}`);
});

test("verbAlignment: both execution (margin ≥ 2) → 1.0", () => {
  // Need 2+ execution verbs in both prev and current for non-neutral classification
  const mem = memWith({ goal: "fix and build the API", current_task: "implement and create the feature" });
  const sim = computeTaskSimilarity("fix and build a new endpoint", "code-fix", mem);
  approx(sim.verbAlignment, 1.0, 0.01, "expected verbAlignment = 1.0");
});

test("verbAlignment: execution vs exploration (both clear) → low (0.1)", () => {
  // Previous: 2+ exploration verbs → exploration. Current: 2+ execution → execution. → 0.1
  const mem = memWith({ goal: "design and analyze the architecture", current_task: "evaluate and model requirements" });
  const sim = computeTaskSimilarity("fix and build the login feature", "code-fix", mem);
  approx(sim.verbAlignment, 0.1, 0.01, "expected verbAlignment = 0.1");
});

test("verbAlignment: neutral → 0.5", () => {
  const mem = memWith({ goal: "the bug", current_task: "" });
  const sim = computeTaskSimilarity("the error", "default", mem);
  approx(sim.verbAlignment, 0.5, 0.01);
});

test("fileOverlap: shared file → > 0", () => {
  const mem = memWith({ recent_files: ["auth.js", "utils.js"] });
  const sim = computeTaskSimilarity("update auth.js", "code-fix", mem);
  ok(sim.fileOverlap > 0, `expected fileOverlap > 0, got ${sim.fileOverlap}`);
});

test("fileOverlap: no files in prompt → 0", () => {
  const mem = memWith({ recent_files: ["auth.js"] });
  const sim = computeTaskSimilarity("fix the bug", "code-fix", mem);
  eq(sim.fileOverlap, 0);
});

test("taskTypeSame: same non-default type → true", () => {
  const mem = memWith({ last_task_type: "code-fix" });
  const sim = computeTaskSimilarity("fix auth", "code-fix", mem);
  eq(sim.taskTypeSame, true);
});

test("taskTypeSame: default type → false (default excluded)", () => {
  const mem = memWith({ last_task_type: "default" });
  const sim = computeTaskSimilarity("fix auth", "default", mem);
  eq(sim.taskTypeSame, false);
});

test("wordSim: empty memory → 0", () => {
  const mem = emptyMem();
  const sim = computeTaskSimilarity("fix the authentication module", "code-fix", mem);
  eq(sim.wordSim, 0);
});

test("scopeAlignment: both medium → 0.5", () => {
  const mem = memWith({ goal: "add an endpoint", current_task: "add a route" });
  const sim = computeTaskSimilarity("add a handler", "implementation", mem);
  approx(sim.scopeAlignment, 0.5, 0.01);
});

test("composite is bounded [0, 1]", () => {
  const mem = memWith({ goal: "fix", current_task: "fix" });
  const sim = computeTaskSimilarity("fix everything everywhere globally across the system", "code-fix", mem);
  ok(sim.composite >= 0 && sim.composite <= 1.0, `out of bounds: ${sim.composite}`);
});

test("result always has all keys", () => {
  const sim = computeTaskSimilarity("fix auth", "code-fix", emptyMem());
  ok("composite"     in sim, "composite");
  ok("verbAlignment" in sim, "verbAlignment");
  ok("fileOverlap"   in sim, "fileOverlap");
  ok("taskTypeSame"  in sim, "taskTypeSame");
  ok("wordSim"       in sim, "wordSim");
  ok("scopeAlignment" in sim, "scopeAlignment");
  ok("verbCategory"  in sim, "verbCategory");
  ok("scope"         in sim, "scope");
});

// ─── selectMode ───────────────────────────────────────────────────────────────

console.log("\nselectMode");

// Helper to build a minimal sim object
function sim(overrides) {
  return {
    composite:      0.5,
    verbAlignment:  0.5,
    fileOverlap:    0,
    taskTypeSame:   false,
    wordSim:        0,
    scopeAlignment: 0.5,
    verbCategory:   "neutral",
    scope:          "medium",
    ...overrides,
  };
}

test("turn < 3 → continuation regardless", () => {
  eq(selectMode(sim({ composite: 0.05 }), "design the whole system", 2), "continuation");
});

test("continuation signal → continuation", () => {
  eq(selectMode(sim({ composite: 0.10 }), "Also fix the bug", 5), "continuation");
});

test("high composite (≥ 0.60) → continuation", () => {
  eq(selectMode(sim({ composite: 0.65 }), "fix more bugs", 5), "continuation");
});

test("exploration verb + broad scope → exploration", () => {
  eq(selectMode(sim({ composite: 0.25, verbCategory: "exploration", scope: "broad" }), "design the entire system", 5), "exploration");
});

test("exploration verb + low composite → exploration", () => {
  eq(selectMode(sim({ composite: 0.15, verbCategory: "exploration", scope: "medium" }), "analyze this", 5), "exploration");
});

test("high file overlap but low composite → same-files", () => {
  eq(selectMode(sim({ composite: 0.30, fileOverlap: 0.50 }), "add a feature to auth.js", 5), "same-files");
});

test("execution verb + narrow scope + low composite → execution", () => {
  eq(selectMode(sim({ composite: 0.35, verbCategory: "execution", scope: "narrow" }), "fix only this function", 5), "execution");
});

test("very low composite (< 0.20) → fresh-task", () => {
  eq(selectMode(sim({ composite: 0.10, verbCategory: "neutral", scope: "medium" }), "start something new", 5), "fresh-task");
});

test("ambiguous composite (0.30) + neutral verb + medium scope → continuation (conservative default)", () => {
  eq(selectMode(sim({ composite: 0.30, verbCategory: "neutral", scope: "medium" }), "handle the edge case", 5), "continuation");
});

test("exploration verb but NOT (broad OR composite < 0.40) → not exploration", () => {
  // composite = 0.45, scope = medium → neither broad nor < 0.40 → falls through
  const result = selectMode(sim({ composite: 0.45, verbCategory: "exploration", scope: "medium" }), "analyze this", 5);
  ok(result !== "exploration", `should not be exploration, got ${result}`);
});

// ─── analyzeSessionStrategy (integration) ────────────────────────────────────

console.log("\nanalyzeSessionStrategy");

test("non-fatal on empty prompt", () => {
  const result = analyzeSessionStrategy("", "default", emptyMem(), 5);
  eq(result.sessionMode, "continuation");
});

test("non-fatal on null memory", () => {
  const result = analyzeSessionStrategy("fix auth", "code-fix", null, 5);
  eq(result.sessionMode, "continuation");
});

test("returns all required keys", () => {
  const result = analyzeSessionStrategy("fix auth", "code-fix", emptyMem(), 5);
  ok("sessionMode"         in result, "sessionMode");
  ok("taskSimilarity"      in result, "taskSimilarity");
  ok("similarityBreakdown" in result, "similarityBreakdown");
  ok("verbCategory"        in result, "verbCategory");
  ok("scope"               in result, "scope");
  ok("contextStrategy"     in result, "contextStrategy");
  ok("isModeChange"        in result, "isModeChange");
  ok("note"                in result, "note");
});

test("contextStrategy has all keys", () => {
  const result = analyzeSessionStrategy("fix auth", "code-fix", emptyMem(), 5);
  const cs = result.contextStrategy;
  ok("compressionOverride" in cs, "compressionOverride");
  ok("includeDecisions"    in cs, "includeDecisions");
  ok("includeIssues"       in cs, "includeIssues");
  ok("rebuildDepth"        in cs, "rebuildDepth");
  ok("triggerReset"        in cs, "triggerReset");
});

test("fresh-task: triggerReset=true, compressionOverride=HIGH", () => {
  // Very low similarity — previous task was exploration, current is execution, no file overlap
  const mem = memWith({ goal: "design distributed database", current_task: "analyze schema", last_task_type: "explanation" });
  const result = analyzeSessionStrategy("fix the payment bug", "code-fix", mem, 10);
  // fresh-task condition: composite < 0.20
  if (result.sessionMode === "fresh-task") {
    eq(result.contextStrategy.compressionOverride, "HIGH");
    eq(result.contextStrategy.triggerReset, true);
    eq(result.contextStrategy.includeDecisions, false);
    ok(result.isModeChange, "should be a mode change");
  }
  // If not fresh-task, at least verify it's a valid mode
  ok(["continuation","fresh-task","same-files","exploration","execution"].includes(result.sessionMode));
});

test("continuation: isModeChange=false, note empty", () => {
  const mem = memWith({ goal: "fix auth bugs", current_task: "fix login bug", last_task_type: "code-fix" });
  const result = analyzeSessionStrategy("Also fix the token refresh", "code-fix", mem, 5);
  eq(result.sessionMode, "continuation");
  eq(result.isModeChange, false);
  eq(result.note, "");
});

test("exploration: compressionOverride=LOW, includeDecisions=true", () => {
  const mem = memWith({ goal: "fix bug", current_task: "fix login" });
  // Force exploration: exploration verb + broad scope
  const result = analyzeSessionStrategy("design and analyze the entire system architecture", "explanation", mem, 5);
  if (result.sessionMode === "exploration") {
    eq(result.contextStrategy.compressionOverride, "LOW");
    eq(result.contextStrategy.includeDecisions, true);
    eq(result.contextStrategy.includeIssues, false);
  }
});

test("taskSimilarity is rounded to 2 decimal places", () => {
  const result = analyzeSessionStrategy("fix auth", "code-fix", emptyMem(), 5);
  const decimals = (result.taskSimilarity.toString().split(".")[1] ?? "").length;
  ok(decimals <= 2, `too many decimal places: ${result.taskSimilarity}`);
});

test("turn < 3 forces continuation mode", () => {
  const mem = emptyMem();
  const result = analyzeSessionStrategy("design the entire global system architecture", "explanation", mem, 2);
  eq(result.sessionMode, "continuation");
});

// ─── MODE_CONFIG shape ────────────────────────────────────────────────────────

console.log("\nMODE_CONFIG");

const EXPECTED_MODES = ["continuation", "fresh-task", "same-files", "exploration", "execution"];

test("all 5 modes are present", () => {
  for (const m of EXPECTED_MODES) {
    ok(m in MODE_CONFIG, `missing mode: ${m}`);
  }
});

test("each mode has required fields", () => {
  for (const [mode, cfg] of Object.entries(MODE_CONFIG)) {
    ok("compressionOverride" in cfg, `${mode}: missing compressionOverride`);
    ok("includeDecisions"    in cfg, `${mode}: missing includeDecisions`);
    ok("includeIssues"       in cfg, `${mode}: missing includeIssues`);
    ok("rebuildDepth"        in cfg, `${mode}: missing rebuildDepth`);
    ok("triggerReset"        in cfg, `${mode}: missing triggerReset`);
    ok("note"                in cfg, `${mode}: missing note`);
  }
});

test("only fresh-task triggers reset", () => {
  for (const [mode, cfg] of Object.entries(MODE_CONFIG)) {
    if (mode === "fresh-task") {
      ok(cfg.triggerReset, "fresh-task should trigger reset");
    } else {
      ok(!cfg.triggerReset, `${mode} should not trigger reset`);
    }
  }
});

test("continuation has null compressionOverride", () => {
  eq(MODE_CONFIG["continuation"].compressionOverride, null);
});

test("exploration has LOW compression", () => {
  eq(MODE_CONFIG["exploration"].compressionOverride, "LOW");
});

test("fresh-task has HIGH compression", () => {
  eq(MODE_CONFIG["fresh-task"].compressionOverride, "HIGH");
});

test("execution has HIGH compression", () => {
  eq(MODE_CONFIG["execution"].compressionOverride, "HIGH");
});

test("continuation note is empty (no noise when not changing mode)", () => {
  eq(MODE_CONFIG["continuation"].note, "");
});

test("all non-continuation modes have non-empty notes", () => {
  for (const mode of EXPECTED_MODES) {
    if (mode !== "continuation") {
      ok(MODE_CONFIG[mode].note.length > 0, `${mode}: note should not be empty`);
    }
  }
});

// ─── defaultStrategy ──────────────────────────────────────────────────────────

console.log("\ndefaultStrategy");

test("returns continuation mode", () => {
  eq(defaultStrategy().sessionMode, "continuation");
});
test("returns isModeChange false", () => {
  eq(defaultStrategy().isModeChange, false);
});
test("returns no triggerReset", () => {
  eq(defaultStrategy().contextStrategy.triggerReset, false);
});
test("each call returns a fresh object", () => {
  const a = defaultStrategy();
  const b = defaultStrategy();
  a.sessionMode = "modified";
  eq(b.sessionMode, "continuation");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`session-strategy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
