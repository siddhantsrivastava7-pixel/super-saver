/**
 * .claude/utils/readRegistry.js
 *
 * Read Registry — tracks files already analyzed in the current session.
 *
 * Stored inside memory.json under the `read_registry` key so it
 * persists across hook invocations within the same session.
 *
 * Each entry:
 * {
 *   path: "src/auth/login.ts",   // relative path for readability
 *   hash: "abc123def456",        // 12-char SHA-1 prefix for change detection
 *   summary: "...",              // compact description (~200 chars)
 *   symbols: ["fn1", "class2"],  // exported names
 *   lastUsedTurn: 3,             // turn number when last referenced
 *   lastModified: 1712345678901, // ms timestamp
 *   readCount: 2,                // how many times referenced
 * }
 *
 * Registry is capped at MAX_REGISTRY_SIZE entries (LRU eviction).
 */

"use strict";

const path = require("path");
const { hashFile } = require("./fileHasher.js");

const MAX_REGISTRY_SIZE = 20;

/**
 * Normalize a file path to a consistent key for registry lookups.
 * Uses forward slashes on all platforms to prevent Windows backslash mismatches.
 */
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}
const MAX_SUMMARY_CHARS = 220;

// ─── Symbol Extraction ────────────────────────────────────────────────────────

const SYMBOL_PATTERNS = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
  /export\s+(?:const|let|var)\s+(\w+)/g,
  /export\s+(?:abstract\s+)?class\s+(\w+)/g,
  /export\s+(?:interface|type|enum)\s+(\w+)/g,
  /exports\.(\w+)\s*=/g,
  /module\.exports\s*=\s*\{([^}]+)\}/,  // special: captures comma-sep names
  /^def\s+(\w+)/gm,                     // Python
  /^func\s+(\w+)/gm,                    // Go
  /^pub\s+fn\s+(\w+)/gm,               // Rust
];

/**
 * Extract exported/public symbol names from source content.
 * Returns up to 8 unique names.
 */
function extractSymbols(content) {
  const symbols = new Set();

  for (const pattern of SYMBOL_PATTERNS) {
    // Special case: module.exports = { a, b, c }
    if (pattern.source.includes("module\\.exports")) {
      const m = content.match(pattern);
      if (m && m[1]) {
        m[1].split(",").forEach((s) => {
          const name = s.trim().split(":")[0].trim();
          if (/^\w+$/.test(name)) symbols.add(name);
        });
      }
      continue;
    }

    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(content)) !== null && symbols.size < 12) {
      if (m[1] && /^\w+$/.test(m[1])) symbols.add(m[1]);
    }
  }

  return [...symbols].slice(0, 8);
}

// ─── Summary Extraction ───────────────────────────────────────────────────────

/**
 * Extract a compact summary from file content.
 * Priority: JSDoc/module comment → symbols list → first meaningful line.
 */
function extractSummary(filePath, content) {
  if (!content) return "";
  const bullets = [];

  // Try to grab a top-level JSDoc or block comment description
  const docMatch = content.match(/\/\*[\s\*]+([^\n*][^\n]{10,})/);
  if (docMatch) {
    bullets.push(docMatch[1].trim().slice(0, 120));
  }

  // Symbols are the clearest signal of what the file contains
  const symbols = extractSymbols(content);
  if (symbols.length > 0) {
    bullets.push(`exports: ${symbols.join(", ")}`);
  }

  // Fallback: first non-trivial code line
  if (bullets.length === 0) {
    const firstCode = content
      .split("\n")
      .find(
        (l) =>
          l.trim().length > 10 &&
          !l.trim().startsWith("//") &&
          !l.trim().startsWith("*") &&
          !l.trim().startsWith("import") &&
          !l.trim().startsWith("use ")
      );
    if (firstCode) bullets.push(firstCode.trim().slice(0, 80));
  }

  return bullets.join("; ").slice(0, MAX_SUMMARY_CHARS);
}

// ─── Status Check ─────────────────────────────────────────────────────────────

/**
 * Determine the status of a file relative to the registry.
 *
 * @param {string} filePath   - Absolute or resolvable path
 * @param {object} registry   - Current read_registry from memory
 * @returns {{
 *   status: "new"|"unchanged"|"changed"|"error",
 *   entry: object|null,     // existing registry entry (if any)
 *   content: string|null,
 *   hash: string|null,
 *   sizeBytes: number
 * }}
 */
function getFileStatus(filePath, registry) {
  const absPath = normalizePath(filePath);
  const { hash, content, sizeBytes } = hashFile(absPath);

  if (!hash) return { status: "error", entry: null, content: null, hash: null, sizeBytes: 0 };

  // Look up by normalized absolute path (primary) or original path (fallback)
  const existing = registry[absPath] ?? registry[filePath] ?? null;

  if (!existing) {
    return { status: "new", entry: null, content, hash, sizeBytes };
  }

  if (existing.hash === hash) {
    return { status: "unchanged", entry: existing, content, hash, sizeBytes };
  }

  return { status: "changed", entry: existing, content, hash, sizeBytes };
}

// ─── Registry Update ──────────────────────────────────────────────────────────

/**
 * Add or update a file entry in the registry.
 * Enforces MAX_REGISTRY_SIZE via LRU eviction (remove lowest lastUsedTurn).
 *
 * @param {string} filePath   - File path (used as key)
 * @param {string} content    - File content
 * @param {string} hash       - Pre-computed hash
 * @param {object} registry   - Current registry (mutated in place)
 * @param {number} turn       - Current conversation turn number
 * @returns {object}          - The new/updated entry
 */
function registerFile(filePath, content, hash, registry, turn, sizeBytes = 0) {
  const absPath = normalizePath(filePath);

  // Evict if at capacity (keep newest N-1, add this new one)
  const keys = Object.keys(registry);
  if (keys.length >= MAX_REGISTRY_SIZE && !registry[absPath]) {
    // Sort by lastUsedTurn ascending — evict oldest
    keys.sort((a, b) => (registry[a].lastUsedTurn || 0) - (registry[b].lastUsedTurn || 0));
    delete registry[keys[0]];
  }

  const symbols  = extractSymbols(content);
  const summary  = extractSummary(filePath, content);
  const existing = registry[absPath];

  registry[absPath] = {
    path: filePath,
    hash,
    summary,
    symbols,
    sizeBytes:   sizeBytes || 0,
    lastUsedTurn: turn || 0,
    lastModified: Date.now(),
    readCount:   (existing?.readCount || 0) + 1,
  };

  return registry[absPath];
}

// ─── Changed-Sections Summary ─────────────────────────────────────────────────

/**
 * Produce a compact symbol-delta description between an old registry entry
 * and freshly read file content.
 *
 * Used by diffPolicy.js to tell Claude what structurally changed in a file
 * without requiring it to re-read the full content.
 *
 * Examples:
 *   "added: refreshToken, revokeToken | removed: legacyLogin"
 *   "interface unchanged, implementation differs"
 *
 * @param {object|null} oldEntry   — existing registry entry (may be null)
 * @param {string}      newContent — current file content
 * @returns {string}
 */
function getChangedSectionsSummary(oldEntry, newContent) {
  const oldSyms = new Set(oldEntry?.symbols ?? []);
  const newSyms = new Set(extractSymbols(newContent));

  const added   = [...newSyms].filter((s) => !oldSyms.has(s));
  const removed = [...oldSyms].filter((s) => !newSyms.has(s));

  const parts = [];
  if (added.length   > 0) parts.push(`added: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);
  if (parts.length === 0) parts.push("interface unchanged, implementation differs");

  return parts.join(" | ");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getFileStatus,
  registerFile,
  extractSummary,
  extractSymbols,
  getChangedSectionsSummary,
  normalizePath,
};
