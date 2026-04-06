/**
 * .claude/tests/smart-memory.js
 *
 * Tests for the Smart Memory Extraction Engine.
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
  dedupCap,
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

// ─── 1. Decision Extraction ───────────────────────────────────────────────────

section("1. Decision extraction");
{
  const prompt = "We decided to use PostgreSQL instead of SQLite. Going with TypeScript for the frontend. We'll use Redis for caching.";
  const decisions = extractDecisions(prompt);

  assert(decisions.length > 0, "extracts at least one decision");
  assert(decisions.some((d) => d.toLowerCase().includes("postgresql") || d.toLowerCase().includes("decided to")),
    "captures the PostgreSQL decision");
  assert(decisions.some((d) => d.toLowerCase().includes("typescript") || d.toLowerCase().includes("going with")),
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

// ─── 2. Constraint Extraction ─────────────────────────────────────────────────

section("4. Constraint extraction");
{
  const prompt = "Never use external APIs. Always keep backward compatibility. Do not add new dependencies.";
  const constraints = extractConstraints(prompt);

  assert(constraints.length > 0, "extracts at least one constraint");
  assert(constraints.some((c) => c.toLowerCase().includes("never") || c.toLowerCase().includes("external")),
    "captures the never-use-external-APIs constraint");
  assert(constraints.some((c) => c.toLowerCase().includes("do not") || c.toLowerCase().includes("dependencies")),
    "captures the no-new-dependencies constraint");
}

section("5. Constraint cap");
{
  const prompt = "never a. never b. never c. never d. never e. never f. never g. never h.";
  const constraints = extractConstraints(prompt);
  assert(constraints.length <= MAX_CONSTRAINTS,
    `constraint array capped at ${MAX_CONSTRAINTS}`, `got ${constraints.length}`);
}

// ─── 3. Known Issues Extraction ───────────────────────────────────────────────

section("6. Known issues extraction");
{
  const prompt = "There's a bug in the auth module. The login is failing when the token expires. Error: 401 Unauthorized.";
  const issues = extractKnownIssues(prompt);

  assert(issues.length > 0, "extracts at least one known issue");
  assert(issues.some((i) => i.toLowerCase().includes("bug in") || i.toLowerCase().includes("auth")),
    "captures the auth bug");
  assert(issues.some((i) => i.toLowerCase().includes("failing") || i.toLowerCase().includes("token")),
    "captures the failing login");
}

section("7. Known issues cap");
{
  const prompt = "bug in a. bug in b. bug in c. bug in d. bug in e. bug in f.";
  const issues = extractKnownIssues(prompt);
  assert(issues.length <= MAX_KNOWN_ISSUES,
    `issues array capped at ${MAX_KNOWN_ISSUES}`, `got ${issues.length}`);
}

// ─── 4. Important Files Extraction ───────────────────────────────────────────

section("8. Important files extraction");
{
  const prompt = "Please update pipeline.js and memory.js. Also check the tests in savings-aggregation.js.";
  const files = extractImportantFiles(prompt);

  assert(files.length >= 2, `extracts at least 2 files (got ${files.length})`);
  assert(files.some((f) => f.includes("pipeline.js")), "captures pipeline.js");
  assert(files.some((f) => f.includes("memory.js")),   "captures memory.js");
}

section("9. Important files deduplication");
{
  const prompt = "Fix pipeline.js. Then update pipeline.js again. Check pipeline.js one more time.";
  const files = extractImportantFiles(prompt);
  const pipelineCount = files.filter((f) => f.includes("pipeline.js")).length;
  assert(pipelineCount === 1, "pipeline.js deduplicated to 1 entry", `got ${pipelineCount}`);
}

section("10. Important files cap");
{
  const prompt = "a.js b.ts c.py d.go e.rs f.java g.cs h.rb i.php j.json k.yaml l.md";
  const files = extractImportantFiles(prompt);
  assert(files.length <= MAX_IMPORTANT_FILES,
    `files array capped at ${MAX_IMPORTANT_FILES}`, `got ${files.length}`);
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

section("12. extractSmartMemory — non-fatal on empty input");
{
  const result = extractSmartMemory("");
  assert(Array.isArray(result.decisions),       "decisions is array");
  assert(Array.isArray(result.constraints),     "constraints is array");
  assert(Array.isArray(result.known_issues),    "known_issues is array");
  assert(Array.isArray(result.important_files), "important_files is array");
}

// ─── 6. buildStructuredRebuildContext ────────────────────────────────────────

section("13. buildStructuredRebuildContext — uses structured fields");
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

section("14. buildStructuredRebuildContext — handles empty memory gracefully");
{
  const ctx = buildStructuredRebuildContext({});
  assert(ctx.includes("[SESSION REBUILD]"), "still outputs rebuild header");
  assert(ctx.length > 10,                  "non-empty output");
}

section("15. dedupCap helper");
{
  const result = dedupCap(["a", "b", "A", "c", "b", "d"], 3);
  assert(result.length <= 3,                              "capped at 3");
  assert(!result.map((x) => x.toLowerCase()).includes("a") || result.indexOf("A") === -1,
    "case-insensitive dedup (A and a merged)");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Smart Memory: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
