/**
 * core/runLogger.ts
 *
 * Append-only TSV run log — one row per pipeline execution.
 *
 * Uses synchronous fs operations (appendFileSync) so a crash mid-pipeline
 * never corrupts a partial write. The file is opened, written, and closed
 * atomically from the OS perspective.
 *
 * TSV format was chosen over JSON for:
 *   - Easy inspection with cat / less / Excel
 *   - Line-oriented so partial writes are detectable
 *   - No parsing overhead for simple grep-based analysis
 */

import * as fs from "fs";
import * as path from "path";
import type { RunEntry } from "./types";

// __dirname in compiled output is dist/core/ — go up two levels to reach project root
const RUNS_PATH = path.resolve(__dirname, "../../store/runs.tsv");

const HEADERS = [
  "timestamp",
  "iteration",
  "model",
  "mode",
  "task_type",
  "result",
  "originalTokens",
  "optimizedTokens",
  "savingsPercent",
  "verificationPassed",
  "notes",
].join("\t");

/**
 * Append a single run entry to runs.tsv.
 * Creates the file with headers if it doesn't exist yet.
 */
export function logRun(entry: RunEntry): void {
  const fileExists =
    fs.existsSync(RUNS_PATH) && fs.statSync(RUNS_PATH).size > 0;

  if (!fileExists) {
    fs.writeFileSync(RUNS_PATH, HEADERS + "\n", "utf-8");
  }

  fs.appendFileSync(RUNS_PATH, formatRow(entry) + "\n", "utf-8");
}

function formatRow(entry: RunEntry): string {
  return [
    entry.timestamp,
    entry.iteration,
    entry.model,
    entry.mode,
    entry.task_type,
    entry.result,
    entry.originalTokens,
    entry.optimizedTokens,
    entry.savingsPercent.toFixed(1),
    entry.verificationPassed ? "true" : "false",
    // Escape tabs in notes to prevent TSV column corruption
    entry.notes.replace(/\t/g, " "),
  ].join("\t");
}
