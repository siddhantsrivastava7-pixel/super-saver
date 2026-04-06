#!/usr/bin/env node
/**
 * .claude/tests/cache-hit.js
 *
 * Cache Hit Regression Tests
 *
 * Proves that the read registry correctly produces cache hits on
 * repeated file references within a session:
 *
 *   1. Turn 1: explicit file mention → status "new", registered
 *   2. Turn 2: same file mention → status "unchanged", cacheHits = 1
 *   3. Path normalization: Windows backslash keys still hit forward-slash registry
 *   4. resolveExplicitFile: bare "pipeline.js" resolves to actual project path
 *   5. Full pipeline two-turn: cacheHits accumulate in updatedSavings
 *   6. Telemetry breakdown: read_cache_saved_tokens > 0 after a cache hit
 *
 * Run:  node .claude/tests/cache-hit.js
 * Exit: 0 = all pass, 1 = one or more failures
 */

"use strict";

const path = require("path");

const ROOT  = path.resolve(__dirname, "../..");
const UTILS = path.resolve(__dirname, "../utils");
const CORE  = path.resolve(__dirname, "../core");

const { applyReadPolicy }                     = require(path.join(UTILS, "diffPolicy.js"));
const { getFileStatus, registerFile,
        normalizePath }                        = require(path.join(UTILS, "readRegistry.js"));
const { extractMentionedFiles,
        filterRelevantFiles }                  = require(path.join(UTILS, "fileFilter.js"));
const { runPipeline }                         = require(path.join(CORE,  "pipeline.js"));
const { loadMemory }                          = require(path.join(UTILS, "memory.js"));
const { updateSavings }                       = require(path.join(UTILS, "savings.js"));

// A real file guaranteed to exist — used as the "cached" target
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

function assertGt(label, actual, min) {
  if (actual <= min) throw new Error(`${label}: ${actual} should be > ${min}`);
}

function assertContains(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected "${needle}" in output\n  Got: "${haystack.slice(0, 200)}"`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TESTS = [

  {
    name: "Turn 1: explicit file → status=new, registered in registry",
    run() {
      const registry = {};
      const { block, updatedRegistry, cacheHits } = applyReadPolicy(
        [KNOWN_FILE], registry, ROOT, 1, true
      );

      assertEq("cacheHits is 0 on first turn", cacheHits, 0);
      assertTrue("file registered after turn 1",
        !!updatedRegistry[normalizePath(KNOWN_FILE)]
      );
      assertContains("block mentions first seen", block, "first seen");
    },
  },

  {
    name: "Turn 2: same file → status=unchanged, cacheHits=1",
    run() {
      const registry = {};

      // Turn 1 — register
      const { updatedRegistry: reg1 } = applyReadPolicy(
        [KNOWN_FILE], registry, ROOT, 1, true
      );

      // Turn 2 — should be a cache hit
      const { block, cacheHits } = applyReadPolicy(
        [KNOWN_FILE], reg1, ROOT, 2, true
      );

      assertEq("cacheHits is 1 on second turn", cacheHits, 1);
      assertContains("block mentions cached", block, "cached");
    },
  },

  {
    name: "Path normalization: Windows-style key still hits registry",
    run() {
      // Manually insert entry with forward-slash key (normalized form)
      const registry = {};
      const { content, hash, sizeBytes } = getFileStatus(KNOWN_FILE, registry);
      const normalKey = normalizePath(KNOWN_FILE);
      registerFile(KNOWN_FILE, content, hash, registry, 1, sizeBytes);

      // Verify the key stored is normalized (forward slashes)
      assertTrue("registry key uses forward slashes",
        Object.keys(registry).every((k) => !k.includes("\\"))
      );

      // Re-check status — should be "unchanged"
      const { status } = getFileStatus(KNOWN_FILE, registry);
      assertEq("status is unchanged after normalized registration", status, "unchanged");
    },
  },

  {
    name: "resolveExplicitFile: bare 'pipeline.js' resolves to real path in .claude/",
    run() {
      // filterRelevantFiles with an explicit bare filename should now resolve it
      const result = filterRelevantFiles("look at pipeline.js", ROOT);
      assertEq("source is explicit", result.source, "explicit");
      assertTrue("resolved file exists under .claude/",
        result.files.some((f) => f.includes("pipeline"))
      );
      // The resolved path should NOT be a bare "pipeline.js" (old broken behavior)
      assertTrue("file is not bare 'pipeline.js'",
        result.files.every((f) => f !== "pipeline.js")
      );
    },
  },

  {
    name: "applyReadPolicy: two consecutive turns produce cache hit on third reference",
    run() {
      const registry = {};

      // Turn 1
      const { updatedRegistry: r1 } = applyReadPolicy([KNOWN_FILE], registry, ROOT, 1, false);
      // Turn 2
      const { updatedRegistry: r2, cacheHits: hits2 } = applyReadPolicy([KNOWN_FILE], r1, ROOT, 2, false);
      // Turn 3
      const { cacheHits: hits3 } = applyReadPolicy([KNOWN_FILE], r2, ROOT, 3, false);

      assertGt("cacheHits > 0 by turn 2", hits2, 0);
      assertGt("cacheHits > 0 by turn 3", hits3, 0);
    },
  },

  {
    name: "Full pipeline two-turn: cacheHits accumulate in updatedSavings",
    async run() {
      const memory = loadMemory();
      // Ensure the registry starts empty for this test
      memory.read_registry = {};
      memory.savings = undefined;

      // Turn 1
      const r1 = await runPipeline({
        prompt:         "look at pipeline.js to understand the hook flow",
        transcriptPath: "",
        cwd:            ROOT,
        memory:         { ...memory },
        currentTurn:    50,
      });

      // Carry registry forward to turn 2
      const memT2 = {
        ...memory,
        read_registry: r1.updatedRegistry,
        savings:       r1.updatedSavings,
      };

      // Turn 2 — same file referenced again
      const r2 = await runPipeline({
        prompt:         "look at pipeline.js to understand the hook flow",
        transcriptPath: "",
        cwd:            ROOT,
        memory:         memT2,
        currentTurn:    51,
      });

      assertGt("turn 2 cacheHits > 0", r2.cacheHits, 0);
      assertGt("read_cache_saved_tokens > 0 in savings",
        r2.updatedSavings?.read_cache_saved_tokens || 0,
        0
      );
    },
  },

  {
    name: "savings.js breakdown: updateSavings with cacheHits=1 sets read_cache_saved_tokens",
    run() {
      const s1 = updateSavings(undefined, {
        originalChars: 100, optimizedChars: 90,
        messagesCompressed: 0, cacheHits: 0, taskType: "default",
      });
      const s2 = updateSavings(s1, {
        originalChars: 100, optimizedChars: 90,
        messagesCompressed: 0, cacheHits: 1, taskType: "code-fix",
      });

      assertGt("read_cache_saved_tokens > 0 after cache hit",
        s2.read_cache_saved_tokens, 0
      );
      assertGt("output_policy_saved_tokens > 0 for non-default task",
        s2.output_policy_saved_tokens, 0
      );
      // Turn 1 has no cache hits so first round should be 0
      assertEq("turn 1 read_cache_saved_tokens is 0", s1.read_cache_saved_tokens, 0);
    },
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTests() {
  const LINE = "═".repeat(60);
  const DASH = "─".repeat(60);

  console.log(LINE);
  console.log("SUPER SAVER — Cache Hit Regression Tests");
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
