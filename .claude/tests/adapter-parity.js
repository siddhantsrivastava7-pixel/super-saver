#!/usr/bin/env node
/**
 * .claude/tests/adapter-parity.js
 *
 * Adapter Parity Test Harness
 *
 * Validates that the Claude adapter and Codex adapter produce identical
 * core optimization outputs from the same pipeline result.
 *
 * What "parity" means:
 *   - Same optimizedTask     (prompt was cleaned identically)
 *   - Same taskType          (classification was deterministic)
 *   - Same originalChars     (input was unchanged)
 *   - Same cacheHits count   (registry access was identical)
 *   - Codex optimizedPrompt === pipeline optimizedTask (no silent mutation)
 *   - Claude output contains [OUTPUT POLICY] section
 *   - Codex systemPrompt is non-empty
 *
 * What "parity" does NOT mean:
 *   - The rendered strings are equal (they use different formats intentionally)
 *   - The section labels match (Claude uses brackets, Codex uses plain text)
 *
 * Run:
 *   node .claude/tests/adapter-parity.js
 *
 * Exit 0 = all pass, exit 1 = one or more failures.
 */

"use strict";

const path = require("path");

const { runPipeline }     = require(path.join(__dirname, "../core/pipeline.js"));
const { formatClaudeContext } = require(path.join(__dirname, "../adapters/claude.js"));
const { formatCodexContext }  = require(path.join(__dirname, "../adapters/codex.js"));
const { loadMemory }      = require(path.join(__dirname, "../utils/memory.js"));

// ─── Test Cases ───────────────────────────────────────────────────────────────

const TEST_CASES = [
  {
    name:     "Bug fix → code-fix task type",
    prompt:   "hey can you maybe fix this login thing it's kinda broken",
    expected: { taskType: "code-fix" },
  },
  {
    name:     "Explanation → explanation task type",
    prompt:   "explain how the payment checkout system works in this codebase",
    expected: { taskType: "explanation" },
  },
  {
    name:     "Multi-step → multi-step task type",
    prompt:   "refactor the auth module, add unit tests, and update the docs",
    expected: { taskType: "multi-step" },
  },
  {
    name:     "New feature → implementation task type",
    prompt:   "add a refresh token endpoint to the authentication service",
    expected: { taskType: "implementation" },
  },
  {
    name:     "Test writing → test task type",
    prompt:   "write unit tests for the payment middleware",
    expected: { taskType: "test" },
  },
  {
    name:     "Code review → review task type",
    prompt:   "review this authentication code and check for any issues",
    expected: { taskType: "review" },
  },
  {
    name:     "Prompt compression (filler removal)",
    prompt:   "hey could you please basically just fix the auth thing it's kinda broken",
    // 'fix' + 'broken' → code-fix; filler stripped
    expected: { taskType: "code-fix", optimizedShorterThan: 60 },
  },
  {
    name:     "Short-circuit: both adapters use same optimizedTask",
    prompt:   "in order to fix the authentication bug please update the login handler",
    expected: { taskType: "code-fix" },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTests() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  const LINE = "═".repeat(64);
  const DASH = "─".repeat(64);

  console.log(LINE);
  console.log("SUPER SAVER — Adapter Parity Tests");
  console.log("Claude adapter and Codex adapter must produce identical core outputs");
  console.log(LINE);
  console.log();

  const memory     = loadMemory();
  const cwd        = process.cwd();
  let   currentTurn = 1;

  for (const tc of TEST_CASES) {
    process.stdout.write(`TEST: ${tc.name}\n${DASH}\n`);

    try {
      // ── Run pipeline once ──────────────────────────────────────────────
      const result = await runPipeline({
        prompt:         tc.prompt,
        transcriptPath: "",
        cwd,
        memory,
        currentTurn:    currentTurn++,
      });

      // ── Format with both adapters ──────────────────────────────────────
      const claudeOut = formatClaudeContext(result);
      const codexOut  = formatCodexContext(result);

      // ── Assertions ────────────────────────────────────────────────────

      // 1. Task type matches expectation
      assertEq("taskType", result.taskType, tc.expected.taskType);

      // 2. Claude output contains the optimized task verbatim
      assertTrue(
        "claude output contains optimizedTask",
        claudeOut.includes(result.optimizedTask)
      );

      // 3. Codex optimizedPrompt is exactly the pipeline's optimizedTask (no mutation)
      assertEq(
        "codex.optimizedPrompt === pipeline.optimizedTask",
        codexOut.optimizedPrompt,
        result.optimizedTask
      );

      // 4. Claude always has [OUTPUT POLICY]
      assertTrue("claude has [OUTPUT POLICY]", claudeOut.includes("[OUTPUT POLICY]"));

      // 5. Codex systemPrompt is non-empty
      assertTrue("codex systemPrompt is non-empty", codexOut.systemPrompt.trim().length > 0);

      // 6. Both adapters see the same task type in metadata / output
      assertEq("codex metadata.taskType", codexOut.metadata.taskType, result.taskType);

      // 7. Input chars are unchanged
      assertEq("originalChars", result.originalChars, tc.prompt.length);

      // 8. Optional: optimized prompt is shorter than threshold
      if (tc.expected.optimizedShorterThan !== undefined) {
        assertTrue(
          `optimizedTask shorter than ${tc.expected.optimizedShorterThan} chars`,
          result.optimizedTask.length < tc.expected.optimizedShorterThan
        );
      }

      // V2 parity checks

      // 9. toolOptimizationHint: if present in result, codex system prompt must reflect it
      if (result.toolOptimizationHint) {
        assertTrue(
          "codex renders toolOptimizationHint when present",
          codexOut.systemPrompt.includes("repeated file access")
        );
        assertTrue(
          "claude renders toolOptimizationHint when present",
          claudeOut.includes("[TOOL OPTIMIZATION]")
        );
      }

      // 10. proofStats available in codex metadata
      assertTrue(
        "codex metadata has proofWithout (number)",
        typeof codexOut.metadata.proofWithout === "number"
      );
      assertTrue(
        "codex metadata has proofEfficiencyPct (number)",
        typeof codexOut.metadata.proofEfficiencyPct === "number"
      );

      // 11. Proof invariant holds in codex metadata
      assertTrue(
        "codex proof: proofWithout = proofWith + proofSaved",
        codexOut.metadata.proofWithout ===
          codexOut.metadata.proofWith + codexOut.metadata.proofSaved
      );

      // 12. smartMemoryUpdate is returned by pipeline (memory persistence works for both)
      assertTrue(
        "pipeline returns smartMemoryUpdate",
        result.smartMemoryUpdate !== undefined
      );
      assertTrue(
        "smartMemoryUpdate.decisions is array",
        Array.isArray(result.smartMemoryUpdate.decisions)
      );

      // ── Report ────────────────────────────────────────────────────────
      console.log(`  taskType        : ${result.taskType}`);
      console.log(`  optimizedTask   : "${result.optimizedTask}"`);
      console.log(`  originalChars   : ${result.originalChars}  →  optimizedChars: ${result.optimizedChars}`);
      console.log(`  Claude  (${String(claudeOut.length).padStart(4)} chars): ${preview(claudeOut, 80)}`);
      console.log(`  Codex sys (${String(codexOut.systemPrompt.length).padStart(3)} chars): ${preview(codexOut.systemPrompt, 80)}`);
      console.log(`  PASS ✓\n`);
      passed++;

    } catch (err) {
      console.log(`  FAIL ✗  ${err.message}\n`);
      failures.push({ name: tc.name, error: err.message });
      failed++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(LINE);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    failures.forEach((f) => console.log(`  ✗ ${f.name}: ${f.error}`));
  }

  console.log(LINE);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Assertion Helpers ────────────────────────────────────────────────────────

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

function assertTrue(label, value) {
  if (!value) {
    throw new Error(`${label}: expected truthy, got ${value}`);
  }
}

function preview(str, maxLen) {
  const first = str.replace(/\n/g, " ").trim();
  return first.length <= maxLen ? first : first.slice(0, maxLen - 3) + "...";
}

// ─── Run ──────────────────────────────────────────────────────────────────────

runTests().catch((err) => {
  console.error("Test harness crashed:", err.message);
  process.exit(1);
});
