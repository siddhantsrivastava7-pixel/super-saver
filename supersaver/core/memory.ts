/**
 * core/memory.ts
 *
 * Structured session memory — the alternative to full chat history.
 *
 * Instead of sending N messages of context (expensive), we maintain a
 * compact JSON object that captures only the essential state:
 *   - what the user is trying to accomplish
 *   - which files have been touched
 *   - what has failed before
 *   - the last plan summary
 *
 * compressMemory() converts this into a ~100-200 token context block
 * that replaces the full history on every API call.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { SessionMemory, FailureRecord } from "./types";

// __dirname in compiled output is dist/core/ — go up two levels to reach project root
const SESSION_PATH = path.resolve(__dirname, "../../store/session.json");

// Maximum number of failure records to retain (prevents unbounded growth)
const MAX_FAILURE_RECORDS = 10;

// Maximum characters of the last plan to include in compressed memory
// (~50 tokens) — just enough to orient the model without flooding the context
const MAX_PLAN_SUMMARY_CHARS = 200;

const DEFAULT_MEMORY: SessionMemory = {
  goal: "",
  current_task: "",
  constraints: [],
  touched_files: [],
  relevant_files: [],
  known_failures: [],
  last_plan: "",
  iteration: 0,
  last_updated: new Date().toISOString(),
};

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Load session memory from disk.
 * Merges with DEFAULT_MEMORY so new fields added in future versions
 * are always present even on old session files.
 */
export async function loadMemory(): Promise<SessionMemory> {
  try {
    const raw = await fs.readFile(SESSION_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionMemory>;
    return { ...DEFAULT_MEMORY, ...parsed };
  } catch {
    // File missing or malformed — start a fresh session
    return { ...DEFAULT_MEMORY };
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function saveMemory(memory: SessionMemory): Promise<void> {
  await fs.writeFile(SESSION_PATH, JSON.stringify(memory, null, 2), "utf-8");
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Merge partial updates into the current session and persist.
 * Array fields are deduplicated and bounded rather than overwritten,
 * so callers can safely pass incremental additions.
 */
export async function updateMemory(
  updates: Partial<SessionMemory>
): Promise<SessionMemory> {
  const current = await loadMemory();

  const mergedFailures: FailureRecord[] = [
    ...current.known_failures,
    ...(updates.known_failures ?? []),
  ].slice(-MAX_FAILURE_RECORDS); // keep only the most recent N failures

  const updated: SessionMemory = {
    ...current,
    ...updates,
    // Deduplicate file lists rather than blindly overwrite
    touched_files: dedupe([
      ...current.touched_files,
      ...(updates.touched_files ?? []),
    ]),
    relevant_files: dedupe([
      ...current.relevant_files,
      ...(updates.relevant_files ?? []),
    ]),
    known_failures: mergedFailures,
    last_updated: new Date().toISOString(),
  };

  await saveMemory(updated);
  return updated;
}

// ─── Compress ─────────────────────────────────────────────────────────────────

/**
 * Build a compact context block from structured memory.
 *
 * This is the key optimization: instead of sending the full conversation
 * history (potentially thousands of tokens), we send a structured summary
 * that captures essential state in ~100-200 tokens.
 *
 * Sections are only included when non-empty, so first-run sessions
 * produce minimal output.
 */
export function compressMemory(memory: SessionMemory): string {
  const parts: string[] = [];

  if (memory.goal) {
    parts.push(`GOAL: ${memory.goal}`);
  }

  if (memory.current_task) {
    parts.push(`LAST TASK: ${memory.current_task}`);
  }

  if (memory.constraints.length > 0) {
    parts.push(`CONSTRAINTS: ${memory.constraints.join("; ")}`);
  }

  if (memory.touched_files.length > 0) {
    parts.push(`TOUCHED FILES: ${memory.touched_files.join(", ")}`);
  }

  if (memory.relevant_files.length > 0) {
    parts.push(`RELEVANT FILES: ${memory.relevant_files.join(", ")}`);
  }

  if (memory.known_failures.length > 0) {
    // Include only the most recent failure — one failure is enough to orient the model
    const recent = memory.known_failures[memory.known_failures.length - 1];
    parts.push(`LAST FAILURE: \`${recent.command}\` → ${recent.error.slice(0, 120)}`);
  }

  if (memory.last_plan) {
    // Truncate to first N chars — full plan is too verbose for a context block
    const summary = memory.last_plan
      .slice(0, MAX_PLAN_SUMMARY_CHARS)
      .replace(/\n/g, " ")
      .trimEnd();
    parts.push(`LAST PLAN SUMMARY: ${summary}${memory.last_plan.length > MAX_PLAN_SUMMARY_CHARS ? "..." : ""}`);
  }

  return parts.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
