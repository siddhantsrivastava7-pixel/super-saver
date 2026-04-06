/**
 * .claude/tests/smart-memory.js
 *
 * Tests for the Smart Memory Extraction Engine (V3).
 *
 * V3 change: extraction functions now return MemoryItem[] — tests access
 * the `.value` property of each item for string comparisons.
 *
 * Run: node .claude/tests/smart-memory.js
 */

"use strict";

const path = require("path");
const {
  extractSmartMemory,
  buildStructuredRebuildContext,
  extractDecisions,
  extractConstraints,
  extractKnownIssues,
  extractImportantFiles,
  isConfidentDecision,
  dedupStrings,
  MAX_DECISIONS,
  MAX_CONSTRAINTS,
  MAX_KNOWN_ISSUES,
  MAX_IMPORTANT_FILES,
} = require(path.resolve(__dirname, "../utils/smartMemory.js"));

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

// Helper: get the value string from a MemoryItem or raw string (backward compat)
function val(item) {
  return typeof item === "string" ? item : (item.value ?? "");
}

// ─── 1. Decision Extraction ───────────────────────────────────────────────────

section("1. Decision extraction");
{
  const prompt = "We decided to use PostgreSQL instead of SQLite. Going with TypeScript for the frontend. We'll use Redis for caching.";
  const decisions = extractDecisions(prompt);

  assert(decisions.length > 0, "extracts at least one decision");
  assert(decisions.some((d) => val(d).toLowerCase().includes("postgresql") || val(d).toLowerCase().includes("decided to")),
    "captures the PostgreSQL decision");
  assert(decisions.some((d) => val(d).toLowerCase().includes("typescript") || val(d).toLowerCase().includes("going with")),
    "captures the TypeScript decision");
}

section("2. Decision deduplication");
{
  const prompt = "decided to use postgres. decided to use postgres. decided to use postgres.";
  const decisions = extractDecisions(prompt);
  assert(decisions.length === 1, "deduplicates identical decisions", `got ${decisions.length}`);
}

section("3. Decision cap");
{
  const triggers = ["decided to a", "decided to b", "decided to c", "decided to d",
                    "decided to e", "decided to f", "decided to g", "decided to h",
                    "decided to i", "decided to j"];
  const prompt = triggers.join(". ");
  const decisions = extractDecisions(prompt);
  assert(decisions.length <= MAX_DECISIONS,
    `decision array capped at ${MAX_DECISIONS}`, `got ${decisions.length}`);
}

section("3b. Decision items have MemoryItem schema (V3)");
{
  const prompt = "We decided to use PostgreSQL.";
  const decisions = extractDecisions(prompt, 5);
  assert(decisions.length > 0, "at least one decision extracted");
  if (decisions.length > 0) {
    const item = decisions[0];
    assert(typeof item.value      === "string",  "item.value is string");
    assert(typeof item.type       === "string",  "item.type is string");
    assert(typeof item.confidence === "number",  "item.confidence is number");
    assert(item.confidence >= 0.5,               "item.confidence >= 0.5");
    assert(item.turn              === 5,          "item.turn matches currentTurn");
    assert(item.superseded        === false,      "new item not superseded");
  }
}

// ─── 2. Constraint Extraction ─────────────────────────────────────────────────

section("4. Constraint extraction");
{
  const prompt = "Never use external APIs. Always keep backward compatibility. Do not add new dependencies.";
  const constraints = extractConstraints(prompt);

  assert(constraints.length > 0, "extracts at least one constraint");
  assert(constraints.some((c) => val(c).toLowerCase().includes("never") || val(c).toLowerCase().includes("external")),
    "captures the never-use-external-APIs constraint");
  assert(constraints.some((c) => val(c).toLowerCase().includes("do not") || val(c).toLowerCase().includes("dependencies")),
    "captures the no-new-dependencies constraint");
}

section("5. Constraint cap");
{
  const prompt = "never a. never b. never c. never d. never e. never f. never g. never h.";
  const constraints = extractConstraints(prompt);
  assert(constraints.length <= MAX_CONSTRAINTS,
    `constraint array capped at ${MAX_CONSTRAINTS}`, `got ${constraints.length}`);
}

section("5b. Constraint confidence — hard triggers get 0.9");
{
  const hardPrompt = "Never use external APIs.";
  const softPrompt = "avoid adding too many dependencies.";
  const hardItems  = extractConstraints(hardPrompt, 1);
  const softItems  = extractConstraints(softPrompt, 1);
  if (hardItems.length > 0) {
    assert(hardItems[0].confidence === 0.9, "hard constraint (never) gets confidence 0.9");
  }
  if (softItems.length > 0) {
    assert(softItems[0].confidence === 0.75, "soft constraint (avoid) gets confidence 0.75");
  }
}

// ─── 3. Known Issues Extraction ───────────────────────────────────────────────

section("6. Known issues extraction");
{
  const prompt = "There's a bug in the auth module. The login is failing when the token expires. Error: 401 Unauthorized.";
  const issues = extractKnownIssues(prompt);

  assert(issues.length > 0, "extracts at least one known issue");
  assert(issues.some((i) => val(i).toLowerCase().includes("bug in") || val(i).toLowerCase().includes("auth")),
    "captures the auth bug");
  assert(issues.some((i) => val(i).toLowerCase().includes("failing") || val(i).toLowerCase().includes("token")),
    "captures the failing login");
}

section("7. Known issues cap");
{
  const prompt = "bug in a. bug in b. bug in c. bug in d. bug in e. bug in f.";
  const issues = extractKnownIssues(prompt);
  assert(issues.length <= MAX_KNOWN_ISSUES,
    `issues array capped at ${MAX_KNOWN_ISSUES}`, `got ${issues.length}`);
}

section("7b. Issue confidence — explicit gets 0.8, implicit gets 0.65");
{
  const explicitPrompt = "Error: 401 Unauthorized";
  const implicitPrompt = "the login is failing now";
  const explicitItems  = extractKnownIssues(explicitPrompt, 1);
  const implicitItems  = extractKnownIssues(implicitPrompt, 1);
  if (explicitItems.length > 0) {
    assert(explicitItems[0].confidence === 0.8,  "explicit (error:) gets confidence 0.8");
  }
  if (implicitItems.length > 0) {
    assert(implicitItems[0].confidence === 0.65, "implicit (failing) gets confidence 0.65");
  }
}

// ─── 4. Important Files Extraction ───────────────────────────────────────────

section("8. Important files extraction");
{
  const prompt = "Please update pipeline.js and memory.js. Also check the tests in savings-aggregation.js.";
  const files = extractImportantFiles(prompt);

  assert(files.length >= 2, `extracts at least 2 files (got ${files.length})`);
  assert(files.some((f) => val(f).includes("pipeline.js")), "captures pipeline.js");
  assert(files.some((f) => val(f).includes("memory.js")),   "captures memory.js");
}

section("9. Important files deduplication");
{
  const prompt = "Fix pipeline.js. Then update pipeline.js again. Check pipeline.js one more time.";
  const files = extractImportantFiles(prompt);
  const pipelineCount = files.filter((f) => val(f).includes("pipeline.js")).length;
  assert(pipelineCount === 1, "pipeline.js deduplicated to 1 entry", `got ${pipelineCount}`);
}

section("10. Important files cap");
{
  const prompt = "a.js b.ts c.py d.go e.rs f.java g.cs h.rb i.php j.json k.yaml l.md";
  const files = extractImportantFiles(prompt);
  assert(files.length <= MAX_IMPORTANT_FILES,
    `files array capped at ${MAX_IMPORTANT_FILES}`, `got ${files.length}`);
}

section("10b. File items have uniform confidence 0.8");
{
  const prompt = "Update auth.js for the fix.";
  const files  = extractImportantFiles(prompt, 3);
  if (files.length > 0) {
    assert(files[0].confidence === 0.8, "file item confidence is 0.8");
    assert(files[0].turn       === 3,   "file item turn matches currentTurn");
  }
}

// ─── 5. extractSmartMemory (combined) ────────────────────────────────────────

section("11. extractSmartMemory — combined extraction");
{
  const prompt = [
    "Fix the bug in auth.js where login is failing.",
    "We decided to use JWT tokens. Never use sessions.",
    "Check pipeline.js for the issue.",
  ].join(" ");

  const result = extractSmartMemory(prompt);
  assert(result.decisions.length > 0,       "decisions extracted");
  assert(result.constraints.length > 0,     "constraints extracted");
  assert(result.known_issues.length > 0,    "known issues extracted");
  assert(result.important_files.length > 0, "important files extracted");
}

section("11b. extractSmartMemory — items are MemoryItem[] (V3)");
{
  const prompt = "decided to use JWT. bug in auth.js.";
  const result = extractSmartMemory(prompt, 7);

  if (result.decisions.length > 0) {
    const d = result.decisions[0];
    assert(typeof d.value      === "string",  "decision.value is string");
    assert(typeof d.confidence === "number",  "decision.confidence is number");
    assert(d.turn              === 7,         "decision.turn matches currentTurn");
  }
  if (result.known_issues.length > 0) {
    const i = result.known_issues[0];
    assert(typeof i.value === "string", "issue.value is string");
    assert(i.type === "known_issue",    "issue.type is 'known_issue'");
  }
}

section("12. extractSmartMemory — non-fatal on empty input");
{
  const result = extractSmartMemory("");
  assert(Array.isArray(result.decisions),       "decisions is array");
  assert(Array.isArray(result.constraints),     "constraints is array");
  assert(Array.isArray(result.known_issues),    "known_issues is array");
  assert(Array.isArray(result.important_files), "important_files is array");
}

// ─── 6. buildStructuredRebuildContext ────────────────────────────────────────

section("13. buildStructuredRebuildContext — uses structured fields (string[] legacy)");
{
  const memory = {
    goal:            "Migrate auth system to JWT",
    current_task:    "Fix token expiry bug",
    decisions:       ["use JWT instead of sessions", "going with PostgreSQL"],
    constraints:     ["never store passwords in plaintext", "always use HTTPS"],
    known_issues:    ["bug in token validation", "session not clearing on logout"],
    important_files: ["auth.js", "middleware.js"],
    recent_files:    ["pipeline.js"],
    last_summary:    "Completed JWT setup, now fixing expiry handling",
  };

  const ctx = buildStructuredRebuildContext(memory);

  assert(ctx.includes("[SESSION REBUILD]"),        "contains SESSION REBUILD header");
  assert(ctx.includes("Goal:"),                    "contains Goal");
  assert(ctx.includes("Key Decisions:"),           "contains Key Decisions section");
  assert(ctx.includes("use JWT instead of sessions"), "includes decision content");
  assert(ctx.includes("Constraints:"),             "contains Constraints section");
  assert(ctx.includes("never store"),              "includes constraint content");
  assert(ctx.includes("Known Issues:"),            "contains Known Issues section");
  assert(ctx.includes("bug in token"),             "includes issue content");
  assert(ctx.includes("Important Files:"),         "contains Important Files section");
  assert(ctx.includes("auth.js"),                  "includes file");
}

section("13b. buildStructuredRebuildContext — filters decayed MemoryItems (V3)");
{
  const { createMemoryItem } = require(path.resolve(__dirname, "../utils/memoryDecay.js"));
  const memory = {
    goal:            "auth system",
    current_task:    "fix login",
    // High confidence item — should appear in context
    decisions:       [createMemoryItem("decided to use JWT", "decision", 0.9, 28)],
    // Very old low-confidence item — should be filtered by decay
    constraints:     [createMemoryItem("old constraint detail", "constraint", 0.2, 0)],
    known_issues:    [],
    important_files: [],
    recent_files:    [],
  };

  const ctx = buildStructuredRebuildContext(memory, 30);

  assert(ctx.includes("decided to use JWT"),       "active decision appears in context");
  // Old constraint: effectiveConf = max(0.10, 0.2 - 30*0.03) = 0.10 < 0.15 → filtered
  assert(!ctx.includes("old constraint detail"),   "decayed constraint is filtered out");
}

section("14. buildStructuredRebuildContext — handles empty memory gracefully");
{
  const ctx = buildStructuredRebuildContext({});
  assert(ctx.includes("[SESSION REBUILD]"), "still outputs rebuild header");
  assert(ctx.length > 10,                  "non-empty output");
}

// ─── 7. Confidence Filter ─────────────────────────────────────────────────────

section("15. Confidence filter — hedged phrases rejected");
{
  const hedgedPrompts = [
    "maybe we should try JWT",
    "perhaps we could use Redis",
    "I'm thinking about switching to postgres",
    "what if we used TypeScript instead",
    "we might try using GraphQL",
  ];
  for (const prompt of hedgedPrompts) {
    const decisions = extractDecisions(prompt);
    assert(decisions.length === 0,
      `hedged phrase not stored: "${prompt.slice(0, 40)}"`,
      `got: ${JSON.stringify(decisions.map((d) => d.value ?? d))}`);
  }
}

section("16. Confidence filter — strong decisions accepted");
{
  const strongPrompts = [
    "We decided to use JWT for authentication",
    "Going with PostgreSQL instead of SQLite",
    "We'll use TypeScript for the whole project",
    "Switched to Redis for the cache layer",
  ];
  for (const prompt of strongPrompts) {
    const decisions = extractDecisions(prompt);
    assert(decisions.length > 0,
      `strong decision stored: "${prompt.slice(0, 40)}"`,
      `got: ${JSON.stringify(decisions.map((d) => d.value ?? d))}`);
  }
}

section("16b. Strong decisions get confidence 0.9");
{
  const decisions = extractDecisions("We decided to use PostgreSQL.");
  if (decisions.length > 0) {
    assert(decisions[0].confidence === 0.9, "strong decision confidence is 0.9");
  }
}

section("17. isConfidentDecision — direct API");
{
  assert(isConfidentDecision("decided to use postgres") === true,  "'decided to' is confident");
  assert(isConfidentDecision("going with TypeScript")   === true,  "'going with' is confident");
  assert(isConfidentDecision("maybe try jwt")           === false, "'maybe try' is hedged");
  assert(isConfidentDecision("perhaps we could use X")  === false, "'perhaps could' is hedged");
  // Strong + weak together → strong wins
  assert(isConfidentDecision("decided to maybe use postgres") === true,
    "'decided to' overrides 'maybe'");
}

section("18. dedupStrings helper (V3 renamed from dedupCap)");
{
  const result = dedupStrings(["a", "b", "A", "c", "b", "d"], 3);
  assert(result.length <= 3,                              "capped at 3");
  assert(!result.map((x) => x.toLowerCase()).includes("a") || result.indexOf("A") === -1,
    "case-insensitive dedup (A and a merged)");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Smart Memory: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
