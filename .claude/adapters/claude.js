/**
 * .claude/adapters/claude.js
 *
 * Claude Code Adapter
 *
 * Renders a pipeline result as a Claude Code `additionalContext` string.
 * This string is injected as a system reminder before every user prompt.
 *
 * Interface:
 *   formatClaudeContext(pipelineResult) → string
 *
 * Section order is deliberate — Claude reads top-down:
 *   [OPTIMIZED TASK]  — primary focus anchor (always present)
 *   [CONTEXT]         — compressed conversation history
 *   [FILE CACHE]      — read deduplication hints
 *   [OUTPUT POLICY]   — task-specific response shaping
 *   [RETRY CONTEXT]   — failure awareness (only when relevant)
 *   [VERIFICATION]    — post-change validation suggestion
 *   [SUPER SAVER]     — session efficiency stats (after turn 1)
 *
 * This module has no I/O and no side effects.
 * It only formats — all decisions are made by pipeline.js.
 */

"use strict";

/**
 * Format a pipeline result into an additionalContext string for Claude Code.
 *
 * @param {object} result — return value of runPipeline()
 * @returns {string}
 */
function formatClaudeContext(result) {
  const sections = [];

  // Always present — gives Claude the cleaned, structured task statement
  sections.push(`[OPTIMIZED TASK]\n${result.optimizedTask}`);

  // Compressed history — skip if empty or trivially short
  if (result.contextBlock && result.contextBlock.length > 20) {
    sections.push(`[CONTEXT]\n${result.contextBlock}`);
  }

  // File cache block — present when relevant files were found
  if (result.fileCacheBlock) {
    sections.push(`[FILE CACHE]\n${result.fileCacheBlock}`);
  }

  // Output policy — always present (falls back to "efficient mode" default)
  sections.push(`[OUTPUT POLICY]\n${result.outputPolicyBlock}`);

  // Tool usage policy — only for lightweight tasks where tool calls waste tokens
  if (result.toolPolicyBlock) {
    sections.push(result.toolPolicyBlock);
  }

  // Tool optimization hint — only when repeated file reads are detected
  if (result.toolOptimizationHint) {
    sections.push(result.toolOptimizationHint);
  }

  // Retry context — only when prior failures exist in memory
  if (result.retryBlock) {
    sections.push(`[RETRY CONTEXT]\n${result.retryBlock}`);
  }

  // Verification suggestion — only on first code-modifying task in a session
  if (result.verificationSuggestion) {
    sections.push(`[VERIFICATION]\n${result.verificationSuggestion}`);
  }

  // Savings + proof — only after 2+ prompts (nothing to compare on turn 1)
  // proofLine provides the cleaner "before vs after" framing when available.
  const statsContent = result.proofLine || result.savingsLine;
  if (statsContent) {
    sections.push(`[SUPER SAVER]\n${statsContent}`);
  }

  return sections.join("\n\n");
}

module.exports = { formatClaudeContext };
