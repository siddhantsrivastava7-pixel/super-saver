/**
 * .claude/utils/fileHasher.js
 *
 * File content hashing — used by readRegistry to detect changes.
 *
 * Uses Node's built-in crypto module (SHA-1, 12-char prefix).
 * SHA-1 is not cryptographically strong but is plenty for change detection.
 *
 * Large file guard: files > 128KB are hashed using only the first 64KB
 * of content + the file size, keeping hashing fast on large files while
 * still detecting meaningful changes.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");

const MAX_HASH_BYTES = 64 * 1024;   // 64 KB — hash limit per file
const MAX_CONTENT_BYTES = 128 * 1024; // 128 KB — max file we'll read fully

/**
 * Hash a string directly. Returns a 12-char hex prefix.
 */
function hashContent(str) {
  return crypto
    .createHash("sha1")
    .update(str, "utf-8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Read a file and return its hash + content.
 * For large files, content is truncated to MAX_CONTENT_BYTES for summary extraction.
 *
 * @param {string} filePath - Absolute path to file
 * @returns {{ hash: string|null, content: string|null, sizeBytes: number }}
 */
function hashFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const sizeBytes = stat.size;

    // Read content (truncated for very large files)
    const readLimit = Math.min(sizeBytes, MAX_CONTENT_BYTES);
    const buffer = Buffer.alloc(readLimit);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, readLimit, 0);
    fs.closeSync(fd);

    const content = buffer.toString("utf-8");

    // Hash either the full content or the first MAX_HASH_BYTES + size suffix
    const hashInput =
      sizeBytes <= MAX_HASH_BYTES
        ? content
        : content.slice(0, MAX_HASH_BYTES) + `:size=${sizeBytes}`;

    return {
      hash: hashContent(hashInput),
      content,
      sizeBytes,
    };
  } catch {
    return { hash: null, content: null, sizeBytes: 0 };
  }
}

module.exports = { hashContent, hashFile };
