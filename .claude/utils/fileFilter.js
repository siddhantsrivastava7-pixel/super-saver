/**
 * .claude/utils/fileFilter.js
 *
 * File Context Filter
 *
 * Reduces token usage by telling Claude which files are relevant,
 * rather than letting it scan everything or hallucinate file paths.
 *
 * Strategy:
 *   1. If the prompt explicitly names files → use those (max 5)
 *   2. If no files named → infer from keyword-to-file mapping
 *   3. If no keywords match → return empty (let Claude decide)
 *   4. Always cap at MAX_FILES to bound context size
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_FILES = 5;

// File extension patterns for code files
const CODE_FILE_PATTERN =
  /\b([\w/.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|h|cs|rb|php|swift|kt|scala|sh|bash|zsh|json|yaml|yml|toml|env|sql|prisma|graphql|proto|md|mdx))\b/gi;

// ─── Keyword-to-Domain Mapping ────────────────────────────────────────────────
// Maps semantic keywords in the prompt to likely file/directory patterns.
// Used when the user doesn't explicitly name files.
// Order matters: more specific entries first.

const KEYWORD_DOMAIN_MAP = [
  // Auth / Identity
  {
    keywords: ["auth", "login", "logout", "signin", "signup", "sign in", "sign up", "password", "credential", "session", "token", "jwt", "oauth", "sso"],
    patterns: ["auth", "login", "session", "credential", "token", "user"],
  },
  // Payments / Billing
  {
    keywords: ["payment", "checkout", "billing", "stripe", "invoice", "subscription", "charge", "cart", "order"],
    patterns: ["payment", "checkout", "billing", "stripe", "cart", "order"],
  },
  // API / Routes
  {
    keywords: ["api", "route", "endpoint", "controller", "handler", "request", "response", "rest", "graphql"],
    patterns: ["api", "route", "controller", "handler", "endpoint"],
  },
  // Database / Models
  {
    keywords: ["database", "db", "model", "schema", "migration", "query", "sql", "orm", "prisma", "mongoose"],
    patterns: ["model", "schema", "migration", "db", "database"],
  },
  // UI / Components
  {
    keywords: ["component", "ui", "frontend", "button", "form", "modal", "page", "view", "template", "layout", "style", "css"],
    patterns: ["component", "ui", "view", "page", "layout", "form"],
  },
  // Tests
  {
    keywords: ["test", "spec", "jest", "vitest", "mocha", "coverage", "unit test", "integration test"],
    patterns: ["test", "spec", "__tests__"],
  },
  // Config / Environment
  {
    keywords: ["config", "environment", "env", "settings", "configuration", ".env"],
    patterns: ["config", ".env", "settings"],
  },
  // Utilities / Helpers
  {
    keywords: ["util", "helper", "utility", "lib", "shared", "common"],
    patterns: ["util", "helper", "lib", "shared", "common"],
  },
  // Middleware
  {
    keywords: ["middleware", "interceptor", "guard", "filter", "pipe"],
    patterns: ["middleware", "interceptor", "guard"],
  },
  // CI / Deploy
  {
    keywords: ["deploy", "ci", "cd", "pipeline", "dockerfile", "docker", "kubernetes", "k8s", "github actions"],
    patterns: ["deploy", "Dockerfile", ".github", "k8s", "kubernetes"],
  },
];

// ─── File Extraction from Prompt ──────────────────────────────────────────────

/**
 * Extract explicitly mentioned file paths from the prompt.
 * Handles both bare filenames ("login.ts") and path-like references ("src/auth/login.ts").
 */
function extractMentionedFiles(prompt) {
  const matches = prompt.match(CODE_FILE_PATTERN) ?? [];
  // Deduplicate (case-insensitive, normalize slashes)
  const seen = new Set();
  const result = [];
  for (const match of matches) {
    const normalized = match.replace(/\\/g, "/").toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(match); // Keep original casing
    }
  }
  return result.slice(0, MAX_FILES);
}

// ─── Keyword-Based Inference ──────────────────────────────────────────────────

/**
 * Infer relevant file patterns from prompt keywords.
 * Returns a list of filename/directory patterns to look for.
 */
function inferFilePatterns(prompt) {
  const lower = prompt.toLowerCase();
  const patterns = new Set();

  for (const entry of KEYWORD_DOMAIN_MAP) {
    const matched = entry.keywords.some((kw) => lower.includes(kw));
    if (matched) {
      entry.patterns.forEach((p) => patterns.add(p));
    }
  }

  return [...patterns];
}

/**
 * Search the project directory for files matching the inferred patterns.
 * Walks up to 3 directory levels deep to keep it fast.
 *
 * @param {string} cwd - The project working directory
 * @param {string[]} patterns - Patterns to search for
 * @returns {string[]} - Relative paths of matching files (max MAX_FILES)
 */
function findMatchingFiles(cwd, patterns) {
  if (!cwd || patterns.length === 0) return [];

  const results = [];

  try {
    walkDir(cwd, cwd, 0, 3, patterns, results);
  } catch {
    // Filesystem errors are non-fatal — just return what we have
  }

  return results.slice(0, MAX_FILES);
}

function walkDir(rootDir, currentDir, depth, maxDepth, patterns, results) {
  if (depth > maxDepth || results.length >= MAX_FILES) return;

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Skip directories we should never descend into
  const SKIP_DIRS = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt",
    "coverage", ".cache", "tmp", "temp", "__pycache__", ".venv",
    "vendor", "target", ".gradle", ".claude", "store", "logs",
  ]);

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        walkDir(rootDir, fullPath, depth + 1, maxDepth, patterns, results);
      }
    } else if (entry.isFile()) {
      const nameLower = entry.name.toLowerCase();
      const pathLower = relativePath.toLowerCase();

      // Skip root-level config/temp files — only include files inside a subdirectory
      // This prevents random root artifacts (*.json, *.log) from appearing in results
      if (depth === 0) continue;

      // Check if this file matches any of the patterns
      const matches = patterns.some((pattern) => {
        const p = pattern.toLowerCase();
        return nameLower.includes(p) || pathLower.includes(p);
      });

      if (matches) {
        results.push(relativePath);
      }
    }
  }
}

// ─── Main Filter Function ─────────────────────────────────────────────────────

/**
 * Determine which files are relevant to the current prompt.
 *
 * @param {string} prompt - The user's prompt
 * @param {string} cwd    - The current working directory
 * @returns {{
 *   files: string[],          // Relevant file paths (max 5)
 *   source: "explicit"|"inferred"|"none",
 *   patterns: string[]        // Patterns used for inference (empty if explicit)
 * }}
 */
function filterRelevantFiles(prompt, cwd) {
  // Step 1: Check for explicitly mentioned files
  const explicit = extractMentionedFiles(prompt);
  if (explicit.length > 0) {
    return {
      files: explicit,
      source: "explicit",
      patterns: [],
    };
  }

  // Step 2: Infer from keywords and search the filesystem
  const patterns = inferFilePatterns(prompt);
  if (patterns.length === 0) {
    return { files: [], source: "none", patterns: [] };
  }

  const found = findMatchingFiles(cwd, patterns);
  return {
    files: found,
    source: "inferred",
    patterns,
  };
}

/**
 * Format the file filter result into a context block string.
 */
function formatFileBlock(filterResult) {
  if (filterResult.files.length === 0) return "";

  const label =
    filterResult.source === "explicit"
      ? "Files mentioned in request"
      : `Files inferred from context (patterns: ${filterResult.patterns.join(", ")})`;

  return `${label}:\n${filterResult.files.map((f) => `  - ${f}`).join("\n")}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { filterRelevantFiles, formatFileBlock, extractMentionedFiles };
