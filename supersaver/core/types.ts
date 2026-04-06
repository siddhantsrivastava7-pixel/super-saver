/**
 * core/types.ts
 *
 * Central type definitions for the entire SUPER SAVER pipeline.
 * All modules import from here — no circular dependencies possible
 * since this file imports nothing.
 */

// ─── Classifier ──────────────────────────────────────────────────────────────

export type TaskType =
  | "bug_fix"
  | "tiny_edit"
  | "test_write"
  | "refactor"
  | "debug_complex"
  | "architecture"
  | "explanation";

export type Ambiguity = "low" | "medium" | "high";
export type ContextWidth = "narrow" | "medium" | "broad";
export type ReasoningDepth = "shallow" | "moderate" | "deep";

export interface ClassificationResult {
  task_type: TaskType;
  ambiguity: Ambiguity;
  context_width: ContextWidth;
  reasoning_depth: ReasoningDepth;
  detected_files: string[];   // filenames extracted from prompt via regex
  prompt_length: number;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export type ModelName = "claude" | "codex";
export type ModelMode = "plan" | "execute";

export interface RoutingDecision {
  model: ModelName;
  mode: ModelMode;
  fallback_model: ModelName;   // escalation target if primary fails twice
  rationale: string;           // human-readable reason, stored in run log
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface FailureRecord {
  command: string;
  error: string;
  timestamp: string;  // ISO 8601
}

export interface SessionMemory {
  goal: string;
  current_task: string;
  constraints: string[];
  touched_files: string[];
  relevant_files: string[];
  known_failures: FailureRecord[];  // capped at 10 entries
  last_plan: string;
  iteration: number;
  last_updated: string;  // ISO 8601
}

// ─── Providers ───────────────────────────────────────────────────────────────

export interface ProviderRequest {
  prompt: string;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderResponse {
  output: string;
  tokensUsed: number;
  model: string;
  durationMs: number;
}

// ─── Optimizer ───────────────────────────────────────────────────────────────

export interface OptimizationResult {
  optimizedPrompt: string;
  systemPrompt: string;
  originalTokens: number;
  optimizedTokens: number;
  compressionRatio: number;   // optimizedTokens / originalTokens (< 1 = savings)
}

// ─── Cost / Savings ──────────────────────────────────────────────────────────

export interface SavingsReport {
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  savingsPercent: number;
  historySaved: number;         // tokens saved by not sending full chat history
  compressionSaved: number;     // tokens saved by filler-word removal
  estimatedCostSavedUSD: number;
}

// ─── Verifier ────────────────────────────────────────────────────────────────

export interface VerificationResult {
  success: boolean;
  logs: string[];
  failedCommand?: string;
  exitCode?: number;
}

// ─── Run Logger ──────────────────────────────────────────────────────────────

export type RunResult = "success" | "failure" | "escalated";

export interface RunEntry {
  timestamp: string;
  iteration: number;
  model: string;
  mode: string;
  task_type: string;
  result: RunResult;
  originalTokens: number;
  optimizedTokens: number;
  savingsPercent: number;
  verificationPassed: boolean;
  notes: string;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface PipelineResult {
  model: string;            // e.g. "claude (plan)" or "codex (execute) [escalated]"
  mode: ModelMode;
  originalTokens: number;
  optimizedTokens: number;
  savingsPercent: number;
  output: string;
  verificationResult: VerificationResult;
  escalated: boolean;
}
