/**
 * core/router.ts
 *
 * Pure function: maps a ClassificationResult to a RoutingDecision.
 * No side effects, no state. Fully deterministic — the same input always
 * produces the same output, making this easy to test and reason about.
 *
 * Routing logic:
 *   1. Lookup static decision table by task_type
 *   2. Apply override rules for edge cases (ambiguity, context+depth)
 */

import type {
  ClassificationResult,
  RoutingDecision,
  ModelName,
  ModelMode,
  TaskType,
} from "./types";

// ─── Decision Table ───────────────────────────────────────────────────────────
// Maps task_type → { model, mode, fallback_model }.
// Rationale strings are stored separately to keep the table readable.

type RoutingBase = {
  model: ModelName;
  mode: ModelMode;
  fallback_model: ModelName;
};

const ROUTING_TABLE: Record<TaskType, RoutingBase> = {
  // Execution tasks: deterministic and pattern-based → Codex
  tiny_edit:    { model: "codex",  mode: "execute", fallback_model: "claude" },
  test_write:   { model: "codex",  mode: "execute", fallback_model: "claude" },
  bug_fix:      { model: "codex",  mode: "execute", fallback_model: "claude" },

  // Planning tasks: require reasoning, trade-off analysis → Claude
  refactor:     { model: "claude", mode: "plan",    fallback_model: "codex" },
  debug_complex:{ model: "claude", mode: "plan",    fallback_model: "codex" },
  architecture: { model: "claude", mode: "plan",    fallback_model: "codex" },
  explanation:  { model: "claude", mode: "plan",    fallback_model: "codex" },
};

const RATIONALE_TABLE: Record<TaskType, string> = {
  tiny_edit:     "Simple edits are deterministic; Codex excels at direct patch application",
  test_write:    "Test generation is structured and pattern-based; optimal for Codex execute mode",
  bug_fix:       "Targeted bug fixes with clear scope benefit from Codex direct execution",
  refactor:      "Refactoring requires architectural awareness; Claude plans the approach",
  debug_complex: "Complex debugging requires multi-step reasoning; Claude handles deep analysis",
  architecture:  "System design needs broad reasoning and trade-off evaluation",
  explanation:   "Conceptual explanation benefits from Claude's depth and contextual nuance",
};

// ─── Router ───────────────────────────────────────────────────────────────────

export function routeModel(
  classification: ClassificationResult
): RoutingDecision {
  const base = ROUTING_TABLE[classification.task_type];

  // Override 1: High ambiguity with a Codex-bound task → escalate to Claude.
  // A vague prompt to Codex produces a bad patch with no way to recover.
  // Claude can surface the ambiguity and ask a clarifying assumption.
  if (classification.ambiguity === "high" && base.model === "codex") {
    return {
      model: "claude",
      mode: "plan",
      fallback_model: "codex",
      rationale: `High ambiguity overrides default routing (was: codex/${base.mode}). Claude will surface assumptions.`,
    };
  }

  // Override 2: Broad context + deep reasoning → always Claude.
  // Tasks that need wide codebase understanding AND deep reasoning exceed
  // what deterministic Codex execution can safely handle.
  if (
    classification.context_width === "broad" &&
    classification.reasoning_depth === "deep"
  ) {
    return {
      model: "claude",
      mode: "plan",
      fallback_model: "codex",
      rationale:
        "Broad context + deep reasoning overrides table — Claude required regardless of task type",
    };
  }

  return {
    ...base,
    rationale: RATIONALE_TABLE[classification.task_type],
  };
}
