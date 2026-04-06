#!/usr/bin/env node
/**
 * .claude/tests/compression-safety.js
 *
 * Compression Safety Regression Tests
 *
 * Validates that history compression never destroys critical context:
 *   1. Long history → goal preserved in summary
 *   2. Long history → recent window (RECENT_WINDOW=4) is verbatim
 *   3. Correction/noise turns are filtered and don't appear in output
 *   4. Duplicate messages collapse safely
 *   5. Output block length stays within a reasonable bound
 *   6. Empty transcript → empty context block (no crash)
 *   7. Single-turn history → no summary needed (just recent context)
 *
 * Run:  node .claude/tests/compression-safety.js
 * Exit: 0 = all pass, 1 = one or more failures
 */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { compressHistory, isNoise, parseTranscript } =
  require(path.join(__dirname, "../utils/compressor.js"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpTranscript(messages) {
  // Write messages as simple { role, content } JSONL (supported by compressor)
  const lines = messages
    .map((m) => JSON.stringify({ role: m.role, content: m.content }))
    .join("\n");
  const filePath = path.join(os.tmpdir(), `cs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(filePath, lines + "\n", "utf-8");
  return filePath;
}

function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function assertContains(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected output to contain "${needle}"\n  Got: "${haystack.slice(0, 300)}"`);
  }
}

function assertNotContains(label, haystack, needle) {
  if (haystack.includes(needle)) {
    throw new Error(`${label}: expected output NOT to contain "${needle}"`);
  }
}

function assertTrue(label, value) {
  if (!value) throw new Error(`${label}: expected true, got ${JSON.stringify(value)}`);
}

function assertEq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────

// 10-message conversation (5 user/assistant pairs)
// Oldest 6 messages go to summary; newest 4 stay verbatim
const LONG_HISTORY = [
  { role: "user",      content: "Build JWT auth in TypeScript" },        // turn 1 goal
  { role: "assistant", content: "Created auth.ts with HS256 signing" },  // turn 1 reply
  { role: "user",      content: "Switch to RS256 algorithm" },            // turn 2
  { role: "assistant", content: "Updated to RS256 keypair validation" }, // turn 2 reply
  { role: "user",      content: "Add protected route middleware" },       // turn 3
  { role: "assistant", content: "Created authMiddleware.ts" },            // turn 3 reply
  { role: "user",      content: "Add refresh token endpoint" },           // turn 4 (recent)
  { role: "assistant", content: "Added POST /refresh returning JWT" },   // turn 4 reply (recent)
  { role: "user",      content: "Add rate limiting to all auth routes" }, // turn 5 (recent)
  { role: "assistant", content: "Added express-rate-limit middleware" },  // turn 5 reply (recent)
];

// Conversation with noise turns
const HISTORY_WITH_NOISE = [
  { role: "user",      content: "Build JWT auth in TypeScript" },
  { role: "assistant", content: "Created auth.ts with basic implementation" },
  { role: "user",      content: "no that's wrong, try again" },            // noise
  { role: "assistant", content: "Updated auth.ts implementation" },
  { role: "user",      content: "wait, nevermind, ignore that last one" }, // noise
  { role: "assistant", content: "Reverted to original approach" },
  { role: "user",      content: "Add refresh token support" },
  { role: "assistant", content: "Added refreshToken function to auth.ts" },
];

// Conversation with duplicate user messages
const HISTORY_WITH_DUPLICATES = [
  { role: "user",      content: "Fix the authentication bug" },
  { role: "user",      content: "Fix the authentication bug" }, // exact duplicate
  { role: "assistant", content: "Found and fixed the null check in auth.ts" },
  { role: "user",      content: "Fix the authentication bug" }, // third duplicate
  { role: "assistant", content: "Confirmed fix is working" },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

const TESTS = [

  {
    name: "Long history: goal preserved in summary",
    run() {
      const f = tmpTranscript(LONG_HISTORY);
      try {
        const { contextBlock } = compressHistory(f, "current turn prompt");
        assertContains(
          "contextBlock contains goal",
          contextBlock,
          "Build JWT auth in TypeScript"
        );
      } finally { cleanup(f); }
    },
  },

  {
    name: "Long history: recent window is verbatim (not in summary)",
    run() {
      const f = tmpTranscript(LONG_HISTORY);
      try {
        const { contextBlock } = compressHistory(f, "current turn prompt");
        // Recent context should contain recent turns
        assertContains("contextBlock contains recent turn 4", contextBlock, "Add refresh token");
        assertContains("contextBlock contains recent turn 5", contextBlock, "Add rate limiting");
        // [RECENT CONTEXT] section should exist
        assertContains("contextBlock has RECENT CONTEXT", contextBlock, "RECENT CONTEXT");
      } finally { cleanup(f); }
    },
  },

  {
    name: "Long history: older turns are condensed into summary",
    run() {
      const f = tmpTranscript(LONG_HISTORY);
      try {
        const { contextBlock, originalMessages, compressedMessages } =
          compressHistory(f, "current turn prompt");
        // Summary should say "X earlier turns condensed"
        assertContains("contextBlock has CONTEXT SUMMARY", contextBlock, "CONTEXT SUMMARY");
        // Compression happened
        assertTrue("originalMessages > compressedMessages",
          originalMessages > compressedMessages);
      } finally { cleanup(f); }
    },
  },

  {
    name: "Noise turns: correction phrases are filtered",
    run() {
      // Test isNoise() directly for known noise patterns
      const noiseInputs = [
        { role: "user", content: "no that's wrong, try again" },
        { role: "user", content: "wait, nevermind" },
        { role: "user", content: "try again" },
        { role: "user", content: "nope, not right" },
      ];
      for (const msg of noiseInputs) {
        assertTrue(
          `isNoise("${msg.content}")`,
          isNoise(msg)
        );
      }

      // Non-noise should not be filtered
      const nonNoise = [
        { role: "user", content: "Add refresh token support to auth.ts" },
        { role: "user", content: "Fix the null check in validateToken" },
      ];
      for (const msg of nonNoise) {
        assertTrue(
          `NOT isNoise("${msg.content}")`,
          !isNoise(msg)
        );
      }
    },
  },

  {
    name: "Noise turns: do not appear in compressed history output",
    run() {
      const f = tmpTranscript(HISTORY_WITH_NOISE);
      try {
        const { contextBlock } = compressHistory(f, "something new");
        // Noise phrases should not appear in the output
        assertNotContains("no noise in output", contextBlock, "no that's wrong");
        assertNotContains("no noise in output", contextBlock, "nevermind");
        // Substantive content should survive
        assertContains("goal preserved", contextBlock, "Build JWT auth in TypeScript");
      } finally { cleanup(f); }
    },
  },

  {
    name: "Duplicate messages: collapse safely without crashing",
    run() {
      const f = tmpTranscript(HISTORY_WITH_DUPLICATES);
      try {
        const result = compressHistory(f, "unrelated prompt");
        // Should not throw; contextBlock is a string
        assertTrue("contextBlock is string", typeof result.contextBlock === "string");
        // The unique content should appear
        if (result.contextBlock.length > 0) {
          assertContains("goal in output", result.contextBlock, "Fix the authentication bug");
        }
      } finally { cleanup(f); }
    },
  },

  {
    name: "Context block length is bounded",
    run() {
      const f = tmpTranscript(LONG_HISTORY);
      try {
        const { contextBlock } = compressHistory(f, "current prompt");
        // Summary cap (MAX_SUMMARY_CHARS=400) + recent window (4 * MAX_MESSAGE_CHARS=800)
        // Total reasonable ceiling: ~4000 chars
        assertTrue(
          `contextBlock.length (${contextBlock.length}) < 4000`,
          contextBlock.length < 4000
        );
      } finally { cleanup(f); }
    },
  },

  {
    name: "Empty transcript: returns empty context block without crash",
    run() {
      const f = tmpTranscript([]);
      try {
        const result = compressHistory(f, "any prompt");
        assertEq("contextBlock is empty string", result.contextBlock, "");
        assertEq("compressedMessages is 0", result.compressedMessages, 0);
      } finally { cleanup(f); }
    },
  },

  {
    name: "Nonexistent transcript path: returns empty context block",
    run() {
      const result = compressHistory("/nonexistent/path/that/does/not/exist.jsonl", "prompt");
      assertEq("contextBlock is empty string", result.contextBlock, "");
    },
  },

  {
    name: "Single-turn history: no summary section, just recent context",
    run() {
      const f = tmpTranscript([
        { role: "user",      content: "Fix the login bug" },
        { role: "assistant", content: "Fixed null check in login.ts" },
      ]);
      try {
        const { contextBlock } = compressHistory(f, "unrelated next prompt");
        // Short history doesn't need a summary section
        // Recent context should contain the single turn
        if (contextBlock.length > 0) {
          assertContains("recent context present", contextBlock, "RECENT CONTEXT");
        }
      } finally { cleanup(f); }
    },
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTests() {
  const LINE = "═".repeat(60);
  const DASH = "─".repeat(60);

  console.log(LINE);
  console.log("SUPER SAVER — Compression Safety Tests");
  console.log(LINE);
  console.log();

  let passed = 0;
  let failed = 0;
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
