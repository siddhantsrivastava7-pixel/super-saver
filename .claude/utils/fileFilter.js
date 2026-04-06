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

/**
 * Search the entire project tree for a file with an exact basename match.
 * Used when an explicit mention like "pipeline.js" doesn't exist at the cwd root —
 * the file could be in any subdirectory, including .claude/ or src/.
 *
 * Unlike walkDir (which skips .claude/, .git/ etc.), this search only skips
 * directories that can never contain user code: node_modules, dist, .git.
 *
 * @param {string} rootDir  — project root to search from
 * @param {string} target   — exact filename to find, e.g. "pipeline.js"
 * @returns {string[]}      — relative paths (forward slashes), up to 3 matches
 */
function findFilesByExactName(rootDir, target) {
  const results = [];
  const targetLower = target.toLowerCase();

  // Only skip directories that are truly irrelevant — NOT .claude, src, lib, etc.
  const HARD_SKIP = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt",
    "coverage", "__pycache__", ".venv", "vendor", "target",
  ]);

  function walk(dir, depth) {
    if (depth > 5 || results.length >= 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= 3) break;
      if (entry.isDirectory()) {
        if (!HARD_SKIP.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
        const rel = path.relative(rootDir, path.join(dir, entry.name)).replace(/\\/g, "/");
        results.push(rel);
      }
    }
  }

  try { walk(rootDir, 0); } catch {}
  return results;
}

/**
 * Resolve an explicit file mention to an actual relative path in the project.
 *
 * Strategy:
 *   1. If the mention looks like a path (contains /), try path.resolve(cwd, mention).
 *   2. Try path.resolve(cwd, basename) directly (file at project root).
 *   3. Search the whole tree for an exact basename match.
 *   4. If still not found, return the original mention (caller shows "not found").
 *
 * @param {string} mention — e.g. "pipeline.js" or "src/auth/login.ts"
 * @param {string} cwd     — project root
 * @returns {string}       — resolved relative path (forward slashes) or original mention
 */
function resolveExplicitFile(mention, cwd) {
  const normalized = mention.replace(/\\/g, "/");

  // 1. Try direct resolution (works for "src/auth.ts", ".claude/core/pipeline.js")
  const direct = path.resolve(cwd, normalized);
  if (fs.existsSync(direct)) {
    return path.relative(cwd, direct).replace(/\\/g, "/");
  }

  // 2. Search tree by exact basename (works for bare "pipeline.js", "auth.ts")
  const basename = path.basename(normalized);
  const found = findFilesByExactName(cwd, basename);
  if (found.length > 0) return found[0];

  // 3. Fallback: return as-is; diffPolicy will show "not found"
  return normalized;
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
    const resolved = explicit.map((f) => resolveExplicitFile(f, cwd)).slice(0, MAX_FILES);
    return {
      files: resolved,
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
