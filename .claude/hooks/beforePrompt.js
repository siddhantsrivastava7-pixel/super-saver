#!/usr/bin/env node
/**
 * .claude/hooks/beforePrompt.js
 *
 * SUPER SAVER HOOK — UserPromptSubmit Orchestrator (thin shell)
 *
 * Fires before every user prompt reaches Claude.
 * Invisible to the user: original prompt unchanged in the UI.
 * Claude receives additionalContext with optimized instructions.
 *
 * ─── Responsibility split ──────────────────────────────────────────────────
 *  THIS FILE handles only:
 *    1.  Parse hook payload from stdin       (Claude Code I/O protocol)
 *    2.  Load persistent session memory      (session state)
 *    10. Persist updated memory to disk      (session state)
 *    11. Emit additionalContext to stdout    (Claude Code I/O protocol)
 *
 *  Steps 3–9 (all optimization logic) live in core/pipeline.js.
 *  Output formatting lives in adapters/claude.js.
 *
 * ─── Why this separation? ──────────────────────────────────────────────────
 *  core/pipeline.js is provider-agnostic — it can be called identically
 *  by any adapter (Claude, Codex, GPT-4o, ...).
 *  adapters/claude.js knows only about Claude Code's additionalContext format.
 *  This file knows only about Claude Code's stdin/stdout hook protocol.
 *
 * Input  (stdin): JSON { prompt, session_id, cwd, transcript_path, ... }
 * Output (stdout): JSON { additionalContext: string }
 * Exit 0: Claude sees additionalContext as a system reminder
 *
 * INVARIANT: This hook MUST NOT break Claude Code sessions.
 * On any unhandled error → exit 0, empty additionalContext.
 */

"use strict";

const path = require("path");

const { runPipeline }                        = require(path.join(__dirname, "../core/pipeline.js"));
const { formatClaudeContext }                = require(path.join(__dirname, "../adapters/claude.js"));
const { loadMemory, saveMemory, applyUpdates } = require(path.join(__dirname, "../utils/memory.js"));

// ─── Safety Net ───────────────────────────────────────────────────────────────

process.on("uncaughtException", () => { emit({}); process.exit(0); });
process.on("unhandledRejection", () => { emit({}); process.exit(0); });

// ─── Entrypoint ───────────────────────────────────────────────────────────────

main().catch(() => { emit({}); process.exit(0); });

async function main() {
  // ── Step 1: Parse stdin ──────────────────────────────────────────────────
  let input;
  try {
    const raw = await readStdin();
    if (!raw.trim()) { emit({}); return; }
    input = JSON.parse(raw);
  } catch {
    emit({});
    return;
  }

  const {
    prompt                     = "",
    transcript_path: transcriptPath = "",
    cwd                        = process.cwd(),
  } = input;

  // Guard: skip empty / slash-commands / one-word inputs
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt || trimmedPrompt.length < 15) {
    emit({});
    return;
  }

  // ── Step 2: Load memory ──────────────────────────────────────────────────
  const memory     = loadMemory();
  const currentTurn = (memory.savings?.prompts_processed ?? 0) + 1;

  // ── Steps 3–9: Run provider-agnostic pipeline ────────────────────────────
  const result = await runPipeline({
    prompt: trimmedPrompt,
    transcriptPath,
    cwd,
    memory,
    currentTurn,
  });

  // ── Step 10: Persist memory ───────────────────────────────────────────────
  try {
    applyUpdates(memory, {
      prompt:            trimmedPrompt,
      files:             result.relevantFiles,
      updatedRegistry:   result.updatedRegistry,
      updatedSavings:    result.updatedSavings,
      lifecycleState:    result.lifecycleState,
      smartMemoryUpdate: result.smartMemoryUpdate,
    });
    saveMemory(memory);
  } catch {
    // Non-fatal — never let a write failure break the session
  }

  // ── Step 11: Emit additionalContext ───────────────────────────────────────
  emit({ additionalContext: formatClaudeContext(result) });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify({ additionalContext: "", ...obj }));
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data",  (c) => chunks.push(c));
    process.stdin.on("end",   () => resolve(chunks.join("")));
    process.stdin.on("error", () => resolve(chunks.join("")));
    // Guard against a hanging tty in edge cases
    setTimeout(() => resolve(chunks.join("")), 5000);
  });
}
