#!/usr/bin/env node
/**
 * .codex/hooks/pre_prompt.js
 *
 * SUPER SAVER — Codex Pre-Prompt Hook
 *
 * Mirrors .claude/hooks/beforePrompt.js but outputs the Codex adapter
 * format: { system_prompt, user_prompt, metadata }.
 *
 * All optimization logic lives in shared modules:
 *   ../../.claude/core/pipeline.js   — provider-agnostic steps 3–9
 *   ../../.claude/adapters/codex.js  — Codex-specific output format
 *   ../../.claude/utils/memory.js    — shared session memory
 *
 * ─── INPUT ASSUMPTIONS ──────────────────────────────────────────────────────
 * stdin is JSON. The hook handles three known Codex CLI payload shapes
 * (and falls back gracefully for unknown shapes):
 *
 * Shape A — Codex agent format:
 *   { messages: [{role: "user", content: "..."}], cwd: "...", session_id: "..." }
 *
 * Shape B — Simple prompt format:
 *   { prompt: "...", cwd: "...", session_id: "..." }
 *
 * Shape C — Alternative field names:
 *   { task: "...", workdir: "...", id: "..." }
 *
 * ─── OUTPUT ─────────────────────────────────────────────────────────────────
 * stdout JSON (dual field names for CLI version compatibility):
 * {
 *   system:        string,   — same as system_prompt (older Codex versions)
 *   system_prompt: string,   — context block for the system role
 *   prompt:        string,   — same as user_prompt (older Codex versions)
 *   user_prompt:   string,   — optimized user message
 *   metadata:      object    — taskType, token counts, cache stats
 * }
 *
 * Exit 0 always — hook failure must never block Codex from running.
 */

"use strict";

const path = require("path");

// Shared modules — .codex/ and .claude/ are sibling directories under project root
const CLAUDE = path.resolve(__dirname, "../../.claude");

const { runPipeline }                              = require(path.join(CLAUDE, "core/pipeline.js"));
const { formatCodexContext }                       = require(path.join(CLAUDE, "adapters/codex.js"));
const { loadMemory, saveMemory, applyUpdates }     = require(path.join(CLAUDE, "utils/memory.js"));

// ─── Safety Net ───────────────────────────────────────────────────────────────

process.on("uncaughtException", () => { emit(null); process.exit(0); });
process.on("unhandledRejection", () => { emit(null); process.exit(0); });

// ─── Input Normalization ──────────────────────────────────────────────────────

/**
 * Extract a normalized { prompt, cwd, sessionId } from any supported
 * Codex CLI payload shape. Defensive — never throws.
 */
function extractInput(raw) {
  // Shape A: messages array (Codex agent format)
  if (Array.isArray(raw.messages)) {
    const lastUser = [...raw.messages]
      .reverse()
      .find((m) => m.role === "user" || m.role === "human");
    return {
      prompt:    typeof lastUser?.content === "string" ? lastUser.content : "",
      cwd:       raw.cwd ?? raw.workdir ?? process.cwd(),
      sessionId: raw.session_id ?? raw.id ?? "",
    };
  }

  // Shape B/C: flat prompt/task field
  return {
    prompt:    raw.prompt ?? raw.task ?? raw.message ?? raw.input ?? "",
    cwd:       raw.cwd ?? raw.workdir ?? process.cwd(),
    sessionId: raw.session_id ?? raw.id ?? "",
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

/**
 * Write the Codex hook result to stdout.
 * Emits both old and new field names for version compatibility.
 * Emits safe empty values if result is null (error path).
 */
function emit(codexResult) {
  const out = codexResult
    ? {
        system:        codexResult.systemPrompt,
        system_prompt: codexResult.systemPrompt,
        prompt:        codexResult.optimizedPrompt,
        user_prompt:   codexResult.optimizedPrompt,
        metadata:      codexResult.metadata,
      }
    : {
        system:        "",
        system_prompt: "",
        prompt:        "",
        user_prompt:   "",
        metadata:      {},
      };

  process.stdout.write(JSON.stringify(out));
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

main().catch(() => { emit(null); process.exit(0); });

async function main() {
  // ── Step 1: Parse stdin ──────────────────────────────────────────────────
  let input;
  try {
    const raw = await readStdin();
    if (!raw.trim()) { emit(null); return; }
    input = JSON.parse(raw);
  } catch {
    emit(null);
    return;
  }

  const { prompt, cwd, sessionId } = extractInput(input);

  const trimmedPrompt = (prompt ?? "").trim();
  if (!trimmedPrompt || trimmedPrompt.length < 10) {
    emit(null);
    return;
  }

  // ── Step 2: Load shared session memory ───────────────────────────────────
  const memory      = loadMemory();
  const currentTurn = (memory.savings?.prompts_processed ?? 0) + 1;

  // ── Steps 3–9: Run provider-agnostic pipeline ────────────────────────────
  const result = await runPipeline({
    prompt:         trimmedPrompt,
    transcriptPath: "",         // Codex CLI does not expose a JSONL transcript path
    cwd:            cwd || process.cwd(),
    memory,
    currentTurn,
  });

  // ── Step 10: Persist memory (shared with Claude adapter) ─────────────────
  try {
    applyUpdates(memory, {
      prompt:          trimmedPrompt,
      files:           result.relevantFiles,
      updatedRegistry: result.updatedRegistry,
      updatedSavings:  result.updatedSavings,
    });
    saveMemory(memory);
  } catch {
    // Non-fatal
  }

  // ── Step 11: Emit Codex-formatted output ─────────────────────────────────
  emit(formatCodexContext(result));
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
