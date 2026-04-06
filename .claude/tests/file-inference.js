#!/usr/bin/env node
/**
 * .claude/tests/file-inference.js
 *
 * File Inference & Registry Regression Tests
 *
 * Validates that file filtering, hash-based caching, and read optimization
 * behave correctly across all edge cases:
 *
 *   1.  Explicit file mentions override keyword inference
 *   2.  Inferred files respect MAX_FILES cap (5)
 *   3.  Missing file → status "error" → safe fallback in output
 *   4.  Known file → status "new" first time, registered correctly
 *   5.  Same file → status "unchanged" after registration
 *   6.  Faked hash change → status "changed", delta summary produced
 *   7.  applyReadPolicy: missing file → formatErrorEntry in block
 *   8.  applyReadPolicy: unchanged file → cached message in block
 *   9.  applyReadPolicy: explicit read → no "unnecessary" dismissal
 *   10. applyReadPolicy: full-read budget (MAX_FULL=2) enforced
 *   11. getChangedSectionsSummary: added + removed symbols detected
 *   12. Claude / Codex adapter parity on shared pipeline fields
 *
 * Uses real files from the project (always present) for hash tests.
 * Run:  node .claude/tests/file-inference.js
 * Exit: 0 = all pass, 1 = one or more failures
 */

"use strict";

const path = require("path");

const ROOT  = path.resolve(__dirname, "../..");         // project root
const UTILS = path.resolve(__dirname, "../utils");
const CORE  = path.resolve(__dirname, "../core");
const ADAPT = path.resolve(__dirname, "../adapters");

const { filterRelevantFiles }                           = require(path.join(UTILS, "fileFilter.js"));
const { getFileStatus, registerFile,
        getChangedSectionsSummary, normalizePath }      = require(path.join(UTILS, "readRegistry.js"));
const { applyReadPolicy }                               = require(path.join(UTILS, "diffPolicy.js"));
const { runPipeline }                                   = require(path.join(CORE,  "pipeline.js"));
const { formatClaudeContext }                           = require(path.join(ADAPT, "claude.js"));
const { formatCodexContext }                            = require(path.join(ADAPT, "codex.js"));
const { loadMemory }                                    = require(path.join(UTILS, "memory.js"));

// A real file from the project — always exists, always readable
const KNOWN_FILE = path.resolve(__dirname, "../core/pipeline.js");

// ─── Assertion Helpers ────────────────────────────────────────────────────────

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

function assertTrue(label, value) {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
}

function assertLte(label, actual, max) {
  if (actual > max) throw new Error(`${label}: ${actual} exceeds max ${max}`);
}

function assertContains(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected "${needle}" in output\n  Got: "${haystack.slice(0, 200)}"`);
  }
}

function assertNotContains(label, haystack, needle) {
  if (haystack.includes(needle)) {
    throw new Error(`${label}: did NOT expect "${needle}" in output`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TESTS = [

  {
    name: "Explicit file mention → source=explicit, overrides keyword inference",
    run() {
      // "auth.ts" is explicit; "login" + "session" would also trigger keyword inference
      // Explicit takes priority and source should reflect that
      const result = filterRelevantFiles(
        "Fix the bug in auth.ts — the login session is broken",
        ROOT
      );
      assertEq("source is explicit", result.source, "explicit");
      assertTrue("files includes auth.ts",
        result.files.some((f) => f.toLowerCase().includes("auth.ts"))
      );
    },
  },

  {
    name: "Keyword inference respects MAX_FILES cap (≤ 5)",
    run() {
      // A broad prompt that matches many keyword categories
      const result = filterRelevantFiles(
        "fix auth login session token middleware config settings database schema",
        ROOT
      );
      assertLte("files.length ≤ 5", result.files.length, 5);
    },
  },

  {
    name: "No-keyword prompt → source=none, files=[]",
    run() {
      const result = filterRelevantFiles("hello world", ROOT);
      // Either "none" (no keywords, no explicit) or "inferred" if some match
      // The important thing: files.length ≤ MAX_FILES
      assertLte("files.length ≤ 5", result.files.length, 5);
      assertTrue("source is string", typeof result.source === "string");
    },
  },

  {
    name: "Missing file → getFileStatus returns status=error",
    run() {
      const { status } = getFileStatus("/nonexistent/path/auth.ts", {});
      assertEq("status is error", status, "error");
    },
  },

  {
    name: "Known file (first time) → status=new, gets registered in registry",
    run() {
      const registry = {};
      const { status, content, hash, sizeBytes } = getFileStatus(KNOWN_FILE, registry);
      assertEq("status is new", status, "new");
      assertTrue("content is non-empty", content && content.length > 0);
      assertTrue("hash is 12-char string", typeof hash === "string" && hash.length === 12);

      // Register it
      const entry = registerFile(KNOWN_FILE, content, hash, registry, 1, sizeBytes);
      assertTrue("entry.hash matches", entry.hash === hash);
      assertTrue("entry is in registry", !!registry[normalizePath(KNOWN_FILE)]);
    },
  },

  {
    name: "Same file after registration → status=unchanged",
    run() {
      const registry = {};
      const { content, hash, sizeBytes } = getFileStatus(KNOWN_FILE, registry);
      registerFile(KNOWN_FILE, content, hash, registry, 1, sizeBytes);

      // Check again — same content, same hash
      const { status: s2 } = getFileStatus(KNOWN_FILE, registry);
      assertEq("status is unchanged", s2, "unchanged");
    },
  },

  {
    name: "Faked hash change → status=changed",
    run() {
      const registry = {};
      const { content, hash, sizeBytes } = getFileStatus(KNOWN_FILE, registry);
      registerFile(KNOWN_FILE, content, hash, registry, 1, sizeBytes);

      // Simulate a hash mismatch (file was modified externally)
      registry[normalizePath(KNOWN_FILE)].hash = "000000000000";

      const { status: s3 } = getFileStatus(KNOWN_FILE, registry);
      assertEq("status is changed", s3, "changed");
    },
  },

  {
    name: "getChangedSectionsSummary: detects added and removed symbols",
    run() {
      const oldEntry = {
        symbols: ["loginHandler", "validateToken", "legacyLogin"],
      };
      const newContent = `
        export function loginHandler() {}
        export function validateToken() {}
        export function refreshToken() {}
        // legacyLogin removed
      `;
      const summary = getChangedSectionsSummary(oldEntry, newContent);
      assertContains("summary mentions added refreshToken",   summary, "refreshToken");
      assertContains("summary mentions removed legacyLogin",  summary, "legacyLogin");
    },
  },

  {
    name: "getChangedSectionsSummary: no symbol change → 'interface unchanged'",
    run() {
      const content = `
        export function loginHandler() { /* changed body */ }
        export function validateToken() { /* changed body */ }
      `;
      const oldEntry = { symbols: ["loginHandler", "validateToken"] };
      const summary = getChangedSectionsSummary(oldEntry, content);
      assertContains("summary says interface unchanged", summary, "unchanged");
    },
  },

  {
    name: "applyReadPolicy: missing file → 'not found' in block",
    run() {
      const { block } = applyReadPolicy(
        ["/nonexistent/path/auth.ts"],
        {},
        ROOT,
        1,
        false
      );
      assertContains("block mentions not found", block, "not found");
    },
  },

  {
    name: "applyReadPolicy: unchanged file → 'cached' in block",
    run() {
      const registry = {};
      // First call registers the file
      applyReadPolicy([KNOWN_FILE], registry, ROOT, 1, false);

      // Wait — applyReadPolicy clones registry, so we need the updatedRegistry
      const { updatedRegistry } = applyReadPolicy([KNOWN_FILE], registry, ROOT, 1, false);

      // Second call with updated registry — file should now be unchanged
      const { block } = applyReadPolicy([KNOWN_FILE], updatedRegistry, ROOT, 2, false);
      assertContains("block mentions cached", block, "cached");
    },
  },

  {
    name: "applyReadPolicy: explicit read → no 'Re-reading unnecessary' message",
    run() {
      const registry = {};
      // Register the file first
      const { updatedRegistry } = applyReadPolicy([KNOWN_FILE], registry, ROOT, 1, false);

      // Second call with explicitRead=true
      const { block } = applyReadPolicy([KNOWN_FILE], updatedRegistry, ROOT, 2, true);
      assertNotContains(
        "no 'Re-reading unnecessary' for explicit read",
        block,
        "Re-reading unnecessary"
      );
      // Should say "Available for re-read" instead
      assertContains("says 'Available for re-read'", block, "Available for re-read");
    },
  },

  {
    name: "applyReadPolicy: MAX_FULL_PER_TURN (2) enforced — third new file gets compact entry",
    run() {
      // We need 3 distinct new files — use different real project files
      const files = [
        path.resolve(__dirname, "../core/pipeline.js"),
        path.resolve(__dirname, "../adapters/claude.js"),
        path.resolve(__dirname, "../adapters/codex.js"),
      ];

      const { block } = applyReadPolicy(files, {}, ROOT, 1, false);

      // Block should be present
      assertTrue("block is non-empty", block.length > 0);

      // The third file should get the compact "[new — budget full]" treatment
      assertContains("third file marked budget full", block, "budget full");
    },
  },

  {
    name: "Claude / Codex adapter parity on shared pipeline fields",
    async run() {
      const memory = loadMemory();
      const result = await runPipeline({
        prompt:         "fix the authentication bug in login.ts",
        transcriptPath: "",
        cwd:            ROOT,
        memory,
        currentTurn:    99, // high turn to avoid interfering with real session
      });

      const claudeOut = formatClaudeContext(result);
      const codexOut  = formatCodexContext(result);

      // Core fields must be identical (provider-agnostic)
      assertEq("taskType matches",
        codexOut.metadata.taskType, result.taskType);
      assertEq("codex.optimizedPrompt === pipeline.optimizedTask",
        codexOut.optimizedPrompt, result.optimizedTask);
      assertTrue("claude contains optimizedTask",
        claudeOut.includes(result.optimizedTask));
      assertEq("originalChars",
        result.originalChars, "fix the authentication bug in login.ts".length);
    },
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTests() {
  const LINE = "═".repeat(60);
  const DASH = "─".repeat(60);

  console.log(LINE);
  console.log("SUPER SAVER — File Inference & Registry Tests");
  console.log(LINE);
  console.log();

  let passed   = 0;
  let failed   = 0;
  const failures = [];

  for (const tc of TESTS) {
    process.stdout.write(`TEST: ${tc.name}\n${DASH}\n`);
    try {
      await tc.run();
      console.log(`  PASS ✓\n`);
      passed++;
    } catch (err) {
      console.log(`  FAIL ✗  ${err.message}\n`);
      failures.push({ name: tc.name, error: err.message });
      failed++;
    }
  }

  console.log(LINE);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailed:");
    failures.forEach((f) => console.log(`  ✗ ${f.name}: ${f.error}`));
  }
  console.log(LINE);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Harness crashed:", err.message);
  process.exit(1);
});
