/**
 * .claude/utils/verifier.js
 *
 * Lightweight Verification & Retry Memory
 *
 * This is NOT an autonomous execution loop. It is a correction memory
 * layer that:
 *   1. Infers the most likely verification command for the project
 *   2. Stores compact failure summaries between turns
 *   3. Injects failure context into additionalContext so Claude
 *      avoids repeating failed approaches
 *
 * No shell commands are executed by this module — execution is left
 * entirely to Claude. We only manage the MEMORY of what has failed.
 *
 * Storage: memory.known_failures (capped at 5 entries)
 *
 * Failure context example injected into additionalContext:
 *
 *   [RETRY CONTEXT]
 *   Prior attempt failed:
 *     Command: npm test
 *     Error: TypeError: Cannot read property 'id' of undefined at auth.ts:42
 *     Do NOT repeat the null-check approach tried in the previous turn.
 *   Last working pattern: return early if token is null before decoding
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Verification Command Inference ──────────────────────────────────────────

// Script priority order for npm projects
const NPM_SCRIPT_PRIORITY = ["test", "build", "lint", "typecheck", "type-check", "check"];

// Fallback indicators for non-npm projects
const PROJECT_INDICATORS = [
  { file: "pytest.ini",      command: "python -m pytest" },
  { file: "setup.py",        command: "python -m pytest" },
  { file: "pyproject.toml",  command: "python -m pytest" },
  { file: "go.mod",          command: "go test ./..." },
  { file: "Cargo.toml",      command: "cargo test" },
  { file: "Makefile",        command: "make test" },
  { file: "Gemfile",         command: "bundle exec rspec" },
  { file: "pom.xml",         command: "mvn test" },
];

/**
 * Infer the most appropriate verification command for the project at cwd.
 * Returns null if no safe command can be determined.
 *
 * @param {string} cwd - Project working directory
 * @returns {string|null}
 */
function inferVerificationCommand(cwd) {
  if (!cwd) return null;

  // 1. Check package.json for available scripts
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      for (const script of NPM_SCRIPT_PRIORITY) {
        if (scripts[script]) {
          // Prefer "npm test" shorthand over "npm run test" for tidiness
          return script === "test" ? "npm test" : `npm run ${script}`;
        }
      }
      // Has package.json but no standard script — suggest npm test anyway
      return "npm test";
    }
  } catch {
    // Malformed package.json — continue to fallbacks
  }

  // 2. Check for other project indicators
  try {
    const files = fs.readdirSync(cwd);
    for (const { file, command } of PROJECT_INDICATORS) {
      if (files.includes(file)) return command;
    }
  } catch {
    // Filesystem error — no suggestion
  }

  return null;
}

// ─── Failure Context Injection ────────────────────────────────────────────────

/**
 * Generate a [RETRY CONTEXT] block from memory if there are recent failures.
 * Only injected when memory contains failures — silent otherwise.
 *
 * @param {object} memory - Current session memory
 * @returns {string}      - Block string (empty if no relevant failures)
 */
function getFailureContext(memory) {
  const failures = memory.known_failures ?? [];
  if (failures.length === 0) return "";

  // Only use the most recent failure — older ones are likely stale
  const last = failures[failures.length - 1];
  if (!last) return "";

  const lines = [
    `Prior attempt failed:`,
    `  Command : ${last.command}`,
    `  Error   : ${last.error.slice(0, 180)}`,
  ];

  if (last.avoidPattern) {
    lines.push(`  Avoid   : ${last.avoidPattern}`);
  }

  if (memory.last_successful_pattern) {
    lines.push(
      `  Last working pattern: ${memory.last_successful_pattern.slice(0, 100)}`
    );
  }

  lines.push(`Do NOT repeat the approach that caused this failure.`);

  return lines.join("\n");
}

// ─── Memory Updaters ──────────────────────────────────────────────────────────

/**
 * Record a task failure into memory.
 * Stores only a compact summary — no raw logs.
 *
 * @param {string} command       - The command that was run
 * @param {string} errorSummary  - Short description of the error
 * @param {string} avoidPattern  - What approach to avoid next time (optional)
 * @param {object} memory        - Current memory object
 * @returns {object}             - Updated memory
 */
function recordFailure(command, errorSummary, avoidPattern, memory) {
  const entry = {
    command,
    error: errorSummary.slice(0, 200),
    avoidPattern: avoidPattern ? avoidPattern.slice(0, 100) : null,
    timestamp: new Date().toISOString(),
  };

  const existing = memory.known_failures ?? [];

  return {
    ...memory,
    known_failures: [...existing, entry].slice(-5), // Cap at 5 entries
    last_verification_command: command,
    last_verification_result: "failure",
  };
}

/**
 * Record a successful verification into memory.
 * Clears the failure list (fresh start after success).
 *
 * @param {string} command         - The command that passed
 * @param {string} successPattern  - What approach worked (optional, stored as guide)
 * @param {object} memory          - Current memory object
 * @returns {object}               - Updated memory
 */
function recordSuccess(command, successPattern, memory) {
  return {
    ...memory,
    known_failures: [],  // Clean slate after success
    last_verification_command: command,
    last_verification_result: "success",
    last_successful_pattern: successPattern
      ? successPattern.slice(0, 150)
      : memory.last_successful_pattern,
  };
}

// ─── Task Classification ──────────────────────────────────────────────────────

/**
 * Returns true if the prompt describes a code-modifying task
 * that would benefit from verification.
 */
function isCodeModifyingTask(prompt) {
  const lower = prompt.toLowerCase();
  const modifiers = [
    "fix", "implement", "refactor", "add", "remove", "delete",
    "update", "change", "create", "build", "write", "rewrite",
  ];
  return modifiers.some((v) => lower.includes(v));
}

/**
 * Generate a suggested verification step for injection into additionalContext.
 * Only included when the task is code-modifying and a command is known.
 *
 * @param {string} command - Inferred verification command
 * @returns {string}
 */
function formatVerificationSuggestion(command) {
  if (!command) return "";
  return `After making changes, verify with: \`${command}\``;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  inferVerificationCommand,
  getFailureContext,
  recordFailure,
  recordSuccess,
  isCodeModifyingTask,
  formatVerificationSuggestion,
};
