/**
 * .claude/utils/compressor.js
 *
 * History Compression Engine
 *
 * Problem: Sending 20+ message turns on every request wastes tokens.
 * Solution: Keep the last 3-5 turns verbatim + collapse older turns
 *           into a single [CONTEXT SUMMARY] block.
 *
 * Algorithm:
 *   1. Parse JSONL transcript into structured messages
 *   2. Detect and remove noise: retries, corrections, duplicates
 *   3. Summarize older messages (beyond the RECENT_WINDOW)
 *   4. Return a compressed context string
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

// Default number of most-recent turns to keep verbatim.
// Overridden per-call via compressHistory(path, prompt, { compressionLevel }).
const RECENT_WINDOW = 4;

// Maps named compression levels to RECENT_WINDOW values.
// Controlled by lifecycle.js based on session state.
const COMPRESSION_LEVEL_WINDOWS = { LOW: 6, MEDIUM: 4, HIGH: 2 };

// Max characters per message in the recent window (prevents single huge message dominating)
const MAX_MESSAGE_CHARS = 800;

// Max characters for the entire summary block
const MAX_SUMMARY_CHARS = 400;

// Patterns that indicate a message is a correction/retry (noise to remove)
const NOISE_PATTERNS = [
  /^no[,.]?\s+(that'?s?\s+)?(wrong|not right|incorrect)/i,
  /^(that'?s?\s+)?(wrong|incorrect|not what i (wanted|meant|asked))/i,
  /^(wait|nope|nevermind|never mind|ignore that)/i,
  /^(try again|redo|redo that|do it again)/i,
  /^(actually|hmm|ugh),?\s*(let'?s?\s+)?try/i,
  /^can you (redo|undo|revert|try again)/i,
];

// Patterns for duplicate/redundant instructions
const DUPLICATE_SIGNALS = [
  /^(as i (said|mentioned)|like i said|as (before|previously))/i,
  /^(remember|don'?t forget)[,:]?\s+i (already|previously) (said|told|mentioned)/i,
];

// ─── Transcript Parser ────────────────────────────────────────────────────────

/**
 * Read and parse a JSONL transcript file.
 * Each line is a JSON event — we extract role + content pairs.
 *
 * Claude Code transcript format:
 *   Each line is a JSON object with a "type" field.
 *   We care about "user" and "assistant" typed events.
 */
function parseTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const messages = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Handle Claude Code's JSONL transcript event formats
        let role = null;
        let content = null;

        if (event.type === "user" && event.message) {
          role = "user";
          content = extractContent(event.message.content);
        } else if (event.type === "assistant" && event.message) {
          role = "assistant";
          content = extractContent(event.message.content);
        } else if (event.role && event.content) {
          // Simpler format: { role, content }
          role = event.role;
          content = extractContent(event.content);
        }

        if (role && content && content.trim()) {
          messages.push({ role, content: content.trim() });
        }
      } catch {
        // Skip malformed lines silently — defensive parsing
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Extract plain text from Claude's content field.
 * Content can be a string or an array of content blocks.
 */
function extractContent(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("\n")
      .trim();
  }

  return "";
}

// ─── Noise Detection ─────────────────────────────────────────────────────────

/**
 * Returns true if a message is a correction, retry, or noise.
 * These add no semantic value to the context.
 */
function isNoise(message) {
  const text = message.content.toLowerCase().trim();

  // Short correction messages (< 60 chars) that match noise patterns
  if (text.length < 60) {
    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(text)) return true;
    }
  }

  // Duplicate signal patterns (regardless of length)
  for (const pattern of DUPLICATE_SIGNALS) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Detect consecutive duplicate messages (user sent same thing twice).
 * Returns a deduplicated array.
 */
function deduplicateMessages(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i];
    const prev = result[result.length - 1];

    // Skip if same role and content is near-identical (> 85% overlap)
    if (prev && prev.role === curr.role) {
      const similarity = computeSimilarity(prev.content, curr.content);
      if (similarity > 0.85) continue;
    }

    result.push(curr);
  }
  return result;
}

/**
 * Simple similarity: ratio of shared words between two strings.
 */
function computeSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  return shared / Math.max(wordsA.size, wordsB.size, 1);
}

// ─── Summarizer ───────────────────────────────────────────────────────────────

/**
 * Produce a summary of older messages (beyond the recent window).
 * Strategy: extract the first user message (the goal), then note
 * what the assistant was working on. Keep it under MAX_SUMMARY_CHARS.
 */
function summarizeOlderMessages(messages) {
  if (messages.length === 0) return "";

  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  const parts = [];

  // The earliest user message is usually the original goal
  if (userMessages.length > 0) {
    const goal = truncate(userMessages[0].content, 150);
    parts.push(`Original request: "${goal}"`);
  }

  // What the assistant was doing (last assistant message from older window)
  if (assistantMessages.length > 0) {
    const lastWork = truncate(
      assistantMessages[assistantMessages.length - 1].content,
      150
    );
    parts.push(`Prior work: "${lastWork}"`);
  }

  // Note how many turns were compressed
  const totalTurns = messages.length;
  parts.push(`(${totalTurns} earlier turns condensed)`);

  return truncate(parts.join(" | "), MAX_SUMMARY_CHARS);
}

// ─── Main Compression Function ────────────────────────────────────────────────

/**
 * Compress conversation history into a compact context block.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript file
 * @param {string} currentPrompt  - The current user prompt (to avoid including it in context)
 * @param {{ compressionLevel?: "LOW"|"MEDIUM"|"HIGH" }} [options]
 *   compressionLevel controls how many recent turns are kept verbatim:
 *     LOW    → 6 turns (new sessions, richer context)
 *     MEDIUM → 4 turns (default)
 *     HIGH   → 2 turns (idle gaps, long sessions)
 * @returns {{
 *   contextBlock: string,      // The formatted [CONTEXT SUMMARY] + [RECENT CONTEXT] block
 *   originalMessages: number,  // Raw message count before compression
 *   compressedMessages: number // Effective "message equivalent" after compression
 * }}
 */
function compressHistory(transcriptPath, currentPrompt, options = {}) {
  // Resolve adaptive window from compression level (fallback to static default)
  const level       = options.compressionLevel;
  const recentWindow = (level && COMPRESSION_LEVEL_WINDOWS[level])
    ? COMPRESSION_LEVEL_WINDOWS[level]
    : RECENT_WINDOW;

  // Parse the full history
  let messages = parseTranscript(transcriptPath);

  const originalCount = messages.length;

  // Remove noise messages
  messages = messages.filter((m) => !isNoise(m));

  // Remove duplicates
  messages = deduplicateMessages(messages);

  // Exclude the current prompt if it appears as the last user message
  // (it's about to be sent — no need to echo it in context)
  if (
    messages.length > 0 &&
    messages[messages.length - 1].role === "user" &&
    computeSimilarity(
      messages[messages.length - 1].content,
      currentPrompt
    ) > 0.7
  ) {
    messages = messages.slice(0, -1);
  }

  if (messages.length === 0) {
    return {
      contextBlock: "",
      originalMessages: originalCount,
      compressedMessages: 0,
    };
  }

  // Split into "older" and "recent" windows using the adaptive window size
  const recentMessages = messages.slice(-recentWindow);
  const olderMessages  = messages.slice(0, -recentWindow);

  const parts = [];

  // Build summary of older messages
  if (olderMessages.length > 0) {
    const summary = summarizeOlderMessages(olderMessages);
    if (summary) {
      parts.push(`[CONTEXT SUMMARY]\n${summary}`);
    }
  }

  // Build verbatim recent context
  if (recentMessages.length > 0) {
    const recentLines = recentMessages.map((m) => {
      const label = m.role === "user" ? "User" : "Assistant";
      const content = truncate(m.content, MAX_MESSAGE_CHARS);
      return `${label}: ${content}`;
    });
    parts.push(`[RECENT CONTEXT]\n${recentLines.join("\n\n")}`);
  }

  const compressedEquivalent = recentMessages.length + (olderMessages.length > 0 ? 1 : 0);

  return {
    contextBlock: parts.join("\n\n"),
    originalMessages: originalCount,
    compressedMessages: compressedEquivalent,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str, maxChars) {
  if (!str || str.length <= maxChars) return str;
  return str.slice(0, maxChars - 3).trimEnd() + "...";
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { compressHistory, parseTranscript, isNoise };
