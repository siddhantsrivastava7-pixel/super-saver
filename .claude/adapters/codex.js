/**
 * .claude/adapters/codex.js
 *
 * Codex / OpenAI-Compatible Adapter
 *
 * Renders a pipeline result as a structured object ready for any
 * OpenAI-compatible chat completions API (Codex, GPT-4o, etc.).
 *
 * Interface:
 *   formatCodexContext(pipelineResult) → { systemPrompt, optimizedPrompt, metadata }
 *
 * Output shape:
 * {
 *   systemPrompt:     string,  — context block for the "system" role message
 *   optimizedPrompt:  string,  — cleaned task for the "user" role message
 *   metadata: {
 *     taskType:        string,  — classified task type
 *     originalTokens:  number,  — estimated tokens before optimization
 *     optimizedTokens: number,  — estimated tokens after optimization
 *     cacheHits:       number,  — files served from registry cache
 *     savingsLine:     string,  — session savings summary (may be empty)
 *   }
 * }
 *
 * Usage with openai SDK:
 *   const { systemPrompt, optimizedPrompt } = formatCodexContext(result);
 *   await openai.chat.completions.create({
 *     model: "gpt-4o",
 *     messages: [
 *       { role: "system", content: systemPrompt },
 *       { role: "user",   content: optimizedPrompt },
 *     ],
 *   });
 *
 * Design decisions:
 *   - System prompt is minimal (Codex context windows are often smaller)
 *   - File context comes first (code-first model — most useful signal up top)
 *   - Output policy is translated to short imperative instructions
 *   - History context is labelled "Prior context" (not Claude-specific bracketed sections)
 *   - No Claude-specific section tags ([OPTIMIZED TASK], etc.) — clean for other providers
 *
 * This module has no I/O and no side effects.
 */

"use strict";

// ─── Task-Specific Codex Instructions ─────────────────────────────────────────
// Codex responds best to short, imperative system-role directives.
// These mirror the OUTPUT_POLICIES in outputPolicy.js but in Codex's idiom.

const CODEX_INSTRUCTIONS = {
  "code-fix":       "Return only the corrected code as a unified diff. No prose preamble.",
  "implementation": "Return complete working code. Add comments only for non-obvious logic.",
  "test":           "Return a complete test file. No explanatory prose.",
  "refactor":       "Return the refactored code as a unified diff. Preserve behavior exactly.",
  "explanation":    "Answer in 3–5 sentences. Lead with the direct answer. No restatement.",
  "review":         "List issues as: SEVERITY | location | fix. Severity-ordered. No praise.",
  "multi-step":     "Execute steps in sequence. Output results per step, numbered.",
};

const DEFAULT_INSTRUCTION = "Return minimal, working output. No explanations unless asked.";

// ─── Formatter ────────────────────────────────────────────────────────────────

/**
 * Format a pipeline result for an OpenAI-compatible provider.
 *
 * @param {object} result — return value of runPipeline()
 * @returns {{ systemPrompt: string, optimizedPrompt: string, metadata: object }}
 */
function formatCodexContext(result) {
  const parts = [];

  // ── File context (highest signal for code models) ────────────────────────
  if (result.fileCacheBlock) {
    parts.push(`File context:\n${result.fileCacheBlock}`);
  }

  // ── Prior conversation context (compact) ─────────────────────────────────
  if (result.contextBlock && result.contextBlock.length > 20) {
    parts.push(`Prior context:\n${result.contextBlock}`);
  }

  // ── Task-specific output instruction ─────────────────────────────────────
  const instruction = CODEX_INSTRUCTIONS[result.taskType] ?? DEFAULT_INSTRUCTION;
  parts.push(instruction);

  // ── Tool usage constraint (lightweight tasks only) ────────────────────────
  // toolPolicyBlock is set by lifecycle.js for explanation/formatting/small-edit
  // tasks. Codex idiom: inline note rather than a bracketed section tag.
  if (result.toolPolicyBlock) {
    parts.push("Avoid external tool calls unless strictly required. Reason from context.");
  }

  // ── Failure awareness (if prior attempts failed) ──────────────────────────
  if (result.retryBlock) {
    parts.push(result.retryBlock);
  }

  const systemPrompt = parts.join("\n\n");

  const lc = result.lifecycleState;

  return {
    systemPrompt,
    optimizedPrompt: result.optimizedTask,
    metadata: {
      taskType:              result.taskType,
      originalTokens:        Math.ceil(result.originalChars  / 4),
      optimizedTokens:       Math.ceil(result.optimizedChars / 4),
      cacheHits:             result.cacheHits,
      savingsLine:           result.savingsLine,
      // Lifecycle fields — lets Codex callers observe session state
      lifecycleMode:         lc?.mode              ?? "normal",
      lifecycleIdleGapMin:   lc?.idleGapMin        ?? "0.0",
      lifecycleSavedTokens:  lc?.estimatedSavedTokens ?? 0,
    },
  };
}

module.exports = { formatCodexContext, CODEX_INSTRUCTIONS };
