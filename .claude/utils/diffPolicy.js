/**
 * .claude/utils/diffPolicy.js
 *
 * Read Optimization Policy (hardened)
 *
 * Decides how to present each file in additionalContext based on
 * the read registry. Prevents Claude from re-reading files it has
 * already analyzed, while accurately communicating what changed.
 *
 * ─── Policy rules (applied per file, in order) ─────────────────────────────
 *  1. File not in registry ("new")       → note first-seen, register it
 *  2. File unchanged ("unchanged")       → inject cached summary, skip re-read
 *  3. File changed ("changed")           → inject symbol-delta summary, re-register
 *  4. File unreadable/missing ("error")  → note as missing with path hint
 *
 * ─── Context budget (per turn) ─────────────────────────────────────────────
 *  MAX_FULL_PER_TURN    = 2   files that warrant a full read (new/changed)
 *  MAX_EXCERPTS_PER_TURN = 3  additional files shown as compact summaries
 *  Remaining files beyond both caps get a one-line "also relevant" note.
 *
 * ─── Explicit read override ─────────────────────────────────────────────────
 *  When explicitRead = true (user named the file directly):
 *    - Budget caps are bypassed
 *    - Cached files say "available for re-read" not "re-reading unnecessary"
 *    - Large file warnings are still shown
 *
 * ─── Large file handling ─────────────────────────────────────────────────────
 *  Files > LARGE_FILE_BYTES get a size annotation; fileHasher already limits
 *  content reads to 128KB so hashing/summary still works safely.
 *
 * ─── Edge cases ─────────────────────────────────────────────────────────────
 *  - Missing files:    "not found or unreadable — verify path"
 *  - Renamed files:    detected as "new" at the new path (correct by design)
 *  - Very large files: size-annotated, summary-only
 *  - Empty registry:   all files treated as "new"
 */

"use strict";

const path = require("path");
const { getFileStatus, registerFile, getChangedSectionsSummary } = require("./readRegistry.js");

// ─── Budget Constants ─────────────────────────────────────────────────────────

// Files that justify a full read (new / changed since last seen)
const MAX_FULL_PER_TURN     = 2;

// Additional files shown as compact summary-only cache entries
const MAX_EXCERPTS_PER_TURN = 3;

// Files over this threshold get a size annotation
const LARGE_FILE_BYTES = 50 * 1024; // 50 KB

// ─── Block Formatters ─────────────────────────────────────────────────────────

/**
 * Format a file seen for the first time this session.
 * Full detail: summary + symbols + optional size warning.
 */
function formatNewEntry(relPath, entry, sizeBytes = 0) {
  const lines = [`${relPath}: [first seen this session]`];

  if (sizeBytes > LARGE_FILE_BYTES) {
    lines.push(`  Size: ${(sizeBytes / 1024).toFixed(0)}KB (large — summary-only, full read may be slow)`);
  }
  if (entry.summary) {
    lines.push(`  Summary: ${entry.summary}`);
  }
  if (entry.symbols && entry.symbols.length > 0) {
    lines.push(`  Exports: ${entry.symbols.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Compact version of a new-file entry when the full-read budget is exhausted.
 * One line per file — just enough for Claude to know it exists.
 */
function formatCompactNewEntry(relPath, entry, sizeBytes = 0) {
  const sizeStr  = sizeBytes > LARGE_FILE_BYTES ? ` (${(sizeBytes / 1024).toFixed(0)}KB)` : "";
  const symStr   = entry.symbols?.length > 0 ? `; exports: ${entry.symbols.slice(0, 3).join(", ")}` : "";
  const sumStr   = entry.summary ? entry.summary.slice(0, 80) : "new file";
  return `${relPath}${sizeStr}: [new — budget full] ${sumStr}${symStr}`;
}

/**
 * Format a cached (unchanged) file entry.
 * Messaging differs based on whether the user explicitly named the file.
 */
function formatCachedEntry(relPath, entry, explicitRead = false) {
  const lines = [
    `${relPath}: [cached — unchanged since turn ${entry.lastUsedTurn ?? "?"}]`,
    `  Summary: ${entry.summary || "no summary available"}`,
  ];

  if (entry.symbols && entry.symbols.length > 0) {
    lines.push(`  Exports: ${entry.symbols.join(", ")}`);
  }

  if (explicitRead) {
    // User explicitly asked about this file — don't dismiss re-reading it
    lines.push(`  Available for re-read — content unchanged since turn ${entry.lastUsedTurn ?? "?"}.`);
  } else {
    lines.push(`  Re-reading unnecessary unless you need full implementation details.`);
  }
  return lines.join("\n");
}

/**
 * Format a file that changed since last seen.
 * Shows symbol delta so Claude understands what structurally changed.
 */
function formatChangedEntry(relPath, symbolDelta, entry, sizeBytes = 0) {
  const lines = [`${relPath}: [CHANGED since turn ${entry.lastUsedTurn ?? "?"}]`];

  if (sizeBytes > LARGE_FILE_BYTES) {
    lines.push(`  Size: ${(sizeBytes / 1024).toFixed(0)}KB (large file)`);
  }
  if (symbolDelta) {
    lines.push(`  Changes: ${symbolDelta}`);
  }
  if (entry.summary) {
    lines.push(`  New summary: ${entry.summary}`);
  }
  lines.push(`  Re-read recommended for latest implementation.`);
  return lines.join("\n");
}

/**
 * Compact version for a changed file when the full-read budget is exhausted.
 */
function formatCompactChangedEntry(relPath, symbolDelta, entry) {
  const delta = symbolDelta || "content changed";
  return `${relPath}: [CHANGED — budget full] ${delta}`;
}

/**
 * Format a missing or unreadable file.
 */
function formatErrorEntry(relPath) {
  return `${relPath}: [not found or unreadable — verify path]`;
}

// ─── Legacy Helper (kept for backward compat / external callers) ──────────────

/**
 * Produce a structural description of a changed file.
 * @deprecated Use getChangedSectionsSummary() from readRegistry.js + formatChangedEntry()
 */
function describeChangedFile(filePath, content, previousEntry) {
  const delta = getChangedSectionsSummary(previousEntry, content);
  const lines  = content.split("\n").length;
  return `${lines} lines | ${delta}`;
}

// ─── Main Policy Function ─────────────────────────────────────────────────────

/**
 * Apply the read optimization policy to a list of file paths.
 *
 * @param {string[]} files        — File paths (relative or absolute)
 * @param {object}   registry     — Current read_registry from memory
 * @param {string}   cwd          — Project working directory
 * @param {number}   turn         — Current conversation turn
 * @param {boolean}  explicitRead — True if user specifically named these files
 * @returns {{
 *   block:           string,  — The [FILE CACHE] block for additionalContext
 *   updatedRegistry: object,  — Registry with new/updated entries
 *   cacheHits:       number,  — Files served from cache (token savings indicator)
 *   cacheChanges:    number,  — Files that changed (need re-read)
 * }}
 */
function applyReadPolicy(files, registry, cwd, turn, explicitRead = false) {
  if (!files || files.length === 0) {
    return { block: "", updatedRegistry: registry, cacheHits: 0, cacheChanges: 0 };
  }

  // Clone registry — return updated version without mutating the original
  const updatedRegistry = { ...registry };
  const sections        = [];

  let fullReadsUsed  = 0;  // new + changed files (warrant Claude reading them)
  let excerptsUsed   = 0;  // cached/compact summaries
  let cacheHits      = 0;
  let cacheChanges   = 0;

  for (const file of files) {
    const absPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const relPath = path.relative(cwd, absPath).replace(/\\/g, "/");

    const { status, entry, content, hash, sizeBytes } =
      getFileStatus(absPath, updatedRegistry);

    // ── explicitRead bypasses budget caps ──
    const budgetExhausted =
      !explicitRead &&
      fullReadsUsed >= MAX_FULL_PER_TURN &&
      excerptsUsed  >= MAX_EXCERPTS_PER_TURN;

    if (budgetExhausted) {
      // Silently skip — remaining files don't add value beyond budget
      break;
    }

    switch (status) {

      case "error":
        sections.push(formatErrorEntry(relPath));
        break;

      case "new": {
        const newEntry = registerFile(absPath, content, hash, updatedRegistry, turn, sizeBytes);

        if (!explicitRead && fullReadsUsed >= MAX_FULL_PER_TURN) {
          // Full budget hit — show compact one-liner
          sections.push(formatCompactNewEntry(relPath, newEntry, sizeBytes));
          excerptsUsed++;
        } else {
          sections.push(formatNewEntry(relPath, newEntry, sizeBytes));
          fullReadsUsed++;
        }
        break;
      }

      case "unchanged": {
        // Update lastUsedTurn so LRU eviction keeps frequently-used files
        updatedRegistry[absPath] = { ...entry, lastUsedTurn: turn };

        if (!explicitRead && excerptsUsed >= MAX_EXCERPTS_PER_TURN) {
          // Excerpt budget hit — one-liner only
          sections.push(`${relPath}: [cached, turn ${entry.lastUsedTurn ?? "?"}] ${(entry.summary || "").slice(0, 60)}`);
        } else {
          sections.push(formatCachedEntry(relPath, entry, explicitRead));
          excerptsUsed++;
        }
        cacheHits++;
        break;
      }

      case "changed": {
        const symbolDelta  = getChangedSectionsSummary(entry, content);
        const updatedEntry = registerFile(absPath, content, hash, updatedRegistry, turn, sizeBytes);

        if (!explicitRead && fullReadsUsed >= MAX_FULL_PER_TURN) {
          // Full budget hit — compact change notice
          sections.push(formatCompactChangedEntry(relPath, symbolDelta, updatedEntry));
          excerptsUsed++;
        } else {
          sections.push(formatChangedEntry(relPath, symbolDelta, updatedEntry, sizeBytes));
          fullReadsUsed++;
        }
        cacheChanges++;
        break;
      }
    }
  }

  if (sections.length === 0) {
    return { block: "", updatedRegistry, cacheHits, cacheChanges };
  }

  return {
    block: sections.join("\n\n"),
    updatedRegistry,
    cacheHits,
    cacheChanges,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { applyReadPolicy, describeChangedFile };
