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

  // ── Tool usage suppression (lightweight tasks only) ──────────────────────
  // toolPolicyBlock = task-type suppression; toolOptimizationHint = repeated-read hint.
  // Codex idiom: inline notes rather than Claude-style bracketed section tags.
  if (result.toolPolicyBlock) {
    parts.push("Avoid external tool calls unless strictly required. Reason from context.");
  }
  if (result.toolOptimizationHint) {
    parts.push("This session has repeated file access. Reuse cached understanding unless a fresh read is required.");
  }

  // ── Failure awareness (if prior attempts failed) ──────────────────────────
  if (result.retryBlock) {
    parts.push(result.retryBlock);
  }

  const systemPrompt = parts.join("\n\n");

  const lc    = result.lifecycleState;
  const proof = result.proofStats ?? {};

  return {
    systemPrompt,
    optimizedPrompt: result.optimizedTask,
    metadata: {
      taskType:              result.taskType,
      originalTokens:        Math.ceil(result.originalChars  / 4),
      optimizedTokens:       Math.ceil(result.optimizedChars / 4),
      cacheHits:             result.cacheHits,
      // V2: proof line (before vs after summary) replaces raw savingsLine
      savingsLine:           result.proofLine || result.savingsLine,
      // Lifecycle fields
      lifecycleMode:         lc?.mode                 ?? "normal",
      lifecycleIdleGapMin:   lc?.idleGapMin           ?? "0.0",
      lifecycleSavedTokens:  lc?.estimatedSavedTokens ?? 0,
      // V2: proof engine fields
      proofWithout:          proof.estimated_total_tokens_without_optimizer ?? 0,
      proofWith:             proof.estimated_total_tokens_with_optimizer    ?? 0,
      proofSaved:            proof.estimated_total_tokens_saved             ?? 0,
      proofEfficiencyPct:    proof.estimated_efficiency_percent             ?? 0,
      // V4: Output waste
      outputWasteTokens:     result.outputWasteStats?.output_tokens_redundant ?? 0,
      outputWasteReason:     result.outputWasteStats?.top_reason              ?? "none",
      // V5: Session strategy
      sessionMode:           result.sessionStrategy?.sessionMode              ?? "continuation",
      taskSimilarity:        result.sessionStrategy?.taskSimilarity           ?? 1,
      sessionModeChanged:    result.sessionStrategy?.isModeChange             ?? false,
    },
  };
}

module.exports = { formatCodexContext, CODEX_INSTRUCTIONS };
