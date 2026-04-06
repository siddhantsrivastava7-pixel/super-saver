#!/usr/bin/env node
/**
 * .codex/hooks/post_turn.js
 *
 * SUPER SAVER — Codex Post-Turn Hook
 *
 * Fires after Codex produces a response. Updates shared session memory with:
 *   - known_failures (if the turn failed)
 *   - last_successful_pattern (if the turn succeeded)
 *   - last_verification_command (if response contained a verification command)
 *   - recent_files (from any files detected in the response)
 *
 * ─── INPUT ASSUMPTIONS ──────────────────────────────────────────────────────
 * stdin is JSON. Handles multiple payload shapes defensively:
 *
 * Shape A (preferred):
 *   {
 *     prompt:     "original user prompt",
 *     response:   "full Codex response text",
 *     session_id: "...",
 *     success:    true,       // optional
 *     exit_code:  0,          // optional
 *   }
 *
 * Shape B (minimal):
 *   { message: "...", reply: "...", ok: true }
 *
 * ─── OUTPUT ─────────────────────────────────────────────────────────────────
 * No stdout required. Some Codex CLIs ignore post-turn hook output entirely.
 * Exit 0 always — post-turn hooks must never fail the session.
 *
 * ─── SHARED MEMORY ───────────────────────────────────────────────────────────
 * Reads and writes the same .claude/hooks/.session-memory.json used by
 * the Claude adapter. Both adapters share failure context and file history.
 */

"use strict";

const path = require("path");

const CLAUDE = path.resolve(__dirname, "../../.claude");

const { loadMemory, saveMemory, applyUpdates } = require(path.join(CLAUDE, "utils/memory.js"));
const { recordFailure, recordSuccess }          = require(path.join(CLAUDE, "utils/verifier.js"));

// ─── Safety Net ───────────────────────────────────────────────────────────────

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

// ─── Verification Command Extraction ─────────────────────────────────────────

// Lines prefixed with $ or RUN: in Codex output are treated as verification commands
const VERIFICATION_PREFIX = /^\s*(?:\$|RUN:)\s*/;

function extractVerificationCommands(text) {
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => VERIFICATION_PREFIX.test(l))
    .map((l) => l.replace(VERIFICATION_PREFIX, "").trim())
    .filter(Boolean)
    .slice(0, 3); // cap at 3 commands per turn
}

// ─── File Mention Extraction (from response) ──────────────────────────────────

const RESPONSE_FILE_PATTERN =
  /\b([\w/.-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|cpp|c|h|cs|rb|sh|json|yaml|toml|sql|md))\b/gi;

function extractMentionedFiles(text) {
  if (!text) return [];
  const seen    = new Set();
  const results = [];
  let m;
  const re = new RegExp(RESPONSE_FILE_PATTERN.source, "gi");
  while ((m = re.exec(text)) !== null && results.length < 5) {
    const norm = m[1].toLowerCase();
    if (!seen.has(norm)) { seen.add(norm); results.push(m[1]); }
  }
  return results;
}

// ─── Input Normalization ──────────────────────────────────────────────────────

function extractTurnResult(raw) {
  const prompt   = raw.prompt   ?? raw.message   ?? raw.input    ?? "";
  const response = raw.response ?? raw.reply     ?? raw.output   ?? "";
  const sessionId = raw.session_id ?? raw.id ?? "";

  // Determine success: explicit field → exit code → absence of error keywords
  let success;
  if (typeof raw.success === "boolean") {
    success = raw.success;
  } else if (typeof raw.exit_code === "number" || typeof raw.exitCode === "number") {
    success = (raw.exit_code ?? raw.exitCode) === 0;
  } else if (typeof raw.ok === "boolean") {
    success = raw.ok;
  } else {
    // Heuristic: look for error signals in the response
    const lower = response.toLowerCase();
    success = !(
      lower.includes("error:") ||
      lower.includes("traceback") ||
      lower.includes("exception:") ||
      lower.includes("failed to") ||
      lower.includes("cannot find module")
    );
  }

  return { prompt, response, sessionId, success };
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

main().catch(() => process.exit(0));

async function main() {
  // Parse stdin
  let input;
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    input = JSON.parse(raw);
  } catch {
    return; // Non-fatal
  }

  const { prompt, response, success } = extractTurnResult(input);
  if (!response) return; // Nothing to record

  // Load shared memory
  let memory;
  try {
    memory = loadMemory();
  } catch {
    return;
  }

  // Extract verification commands from Codex response
  const verCmds = extractVerificationCommands(response);
  const lastCmd = verCmds[0] ?? memory.last_verification_command ?? "";

  // Extract files mentioned in the response
  const mentionedFiles = extractMentionedFiles(response);

  // Update failure / success state
  try {
    if (success) {
      memory = recordSuccess(lastCmd, prompt.slice(0, 100), memory);
    } else {
      // Extract a brief error summary from the response (first error-looking line)
      const errorLine = response
        .split("\n")
        .find((l) => /error|exception|traceback|failed/i.test(l)) ?? response.slice(0, 100);
      memory = recordFailure(lastCmd, errorLine.trim().slice(0, 200), null, memory);
    }
  } catch {}

  // Persist updates
  try {
    applyUpdates(memory, {
      files:                   mentionedFiles,
      verificationCommand:     lastCmd || undefined,
      verificationResult:      success ? "success" : "failure",
    });
    saveMemory(memory);
  } catch {}

  // Exit 0 — post-turn hooks never return meaningful output
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data",  (c) => chunks.push(c));
    process.stdin.on("end",   () => resolve(chunks.join("")));
    process.stdin.on("error", () => resolve(chunks.join("")));
    setTimeout(() => resolve(chunks.join("")), 5000);
  });
}
