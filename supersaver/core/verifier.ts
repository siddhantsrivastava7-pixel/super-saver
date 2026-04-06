/**
 * core/verifier.ts
 *
 * Mechanical result verification via shell commands.
 *
 * Runs commands extracted from model output sequentially.
 * Stops at the first failure and records the exit code + error output.
 * On success, records the last 3 lines of output per command for traceability.
 *
 * Commands are expected to be safe, project-local commands like:
 *   npm test, npm run build, python -m pytest, go test ./...
 */

import { execSync } from "child_process";
import type { VerificationResult } from "./types";

// Per-command timeout — prevents runaway test suites from blocking the CLI
const COMMAND_TIMEOUT_MS = 30_000;

// Maximum characters of error output to capture (avoid log flooding)
const MAX_ERROR_CHARS = 300;

export function verifyResult(commands: string[]): VerificationResult {
  if (commands.length === 0) {
    return {
      success: true,
      logs: ["No verification commands found in model output"],
    };
  }

  const logs: string[] = [];

  for (const command of commands) {
    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
        // Capture both stdout and stderr — merged for simpler log handling
        stdio: ["pipe", "pipe", "pipe"],
      });

      logs.push(`[PASS] ${command}`);

      // Include last 3 lines of output for context without log bloat
      const lines = output.trim().split("\n");
      const tail = lines.slice(-3).join("\n");
      if (tail) {
        logs.push(`       └─ ${tail.replace(/\n/g, "\n          ")}`);
      }
    } catch (err: unknown) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      const exitCode = error.status ?? 1;
      const errorText = (error.stderr || error.stdout || error.message || "")
        .trim()
        .slice(0, MAX_ERROR_CHARS);

      logs.push(`[FAIL] ${command} (exit ${exitCode})`);
      if (errorText) {
        logs.push(`       └─ ${errorText}`);
      }

      // Stop at first failure — no point running subsequent checks
      return {
        success: false,
        logs,
        failedCommand: command,
        exitCode,
      };
    }
  }

  return { success: true, logs };
}
