/**
 * core/optimizer.ts
 *
 * Transforms raw user prompts into tight, model-specific prompts.
 *
 * Four-pass pipeline:
 *   1. Phrase replacement  — swap verbose idioms for concise equivalents
 *   2. Filler removal      — strip meaningless padding words
 *   3. Whitespace collapse — normalize spacing and blank lines
 *   4. Model structuring   — add system prompt + memory context in model-specific format
 *
 * Claude prompts are structured for reasoning (memory context as a named block).
 * Codex prompts are stripped to minimum (imperative task only + brief context).
 */

import { getClaudePlannerSystem } from "../prompts/claudePlanner";
import { getCodexExecutorSystem } from "../prompts/codexExecutor";
import { estimateTokens } from "./cost";
import type { OptimizationResult, ModelName } from "./types";

// ─── Replacement Patterns ─────────────────────────────────────────────────────
// [pattern, replacement] pairs applied in order.
// These swap verbose phrases for shorter semantic equivalents.
const REPLACEMENTS: [RegExp, string][] = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bmake use of\b/gi, "use"],
  [/\bis able to\b/gi, "can"],
  [/\bwith the exception of\b/gi, "except"],
];

// ─── Filler Word Patterns ─────────────────────────────────────────────────────
// Words/phrases that consume tokens without adding information.
// Applied after replacements to avoid partial-match conflicts.
const FILLER_PATTERNS: RegExp[] = [
  /\bplease\b/gi,
  /\bkindly\b/gi,
  /\bcould you\b/gi,
  /\bwould you mind\b/gi,
  /\bi was wondering if\b/gi,
  /\bthat being said\b/gi,
  /\bof course\b/gi,
  /\bit goes without saying\b/gi,
  /\bneedless to say\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bessentially\b/gi,
  /\bsimply\b/gi,
];

// ─── Optimizer ────────────────────────────────────────────────────────────────

export function optimizePrompt(
  userPrompt: string,
  model: ModelName,
  memoryContext: string
): OptimizationResult {
  // Measure original size (prompt + whatever memory context would be appended raw)
  const originalTokens = estimateTokens(userPrompt + memoryContext);

  let optimized = userPrompt;

  // Pass 1: Replace verbose idioms
  for (const [pattern, replacement] of REPLACEMENTS) {
    optimized = optimized.replace(pattern, replacement);
  }

  // Pass 2: Strip filler words (replace with empty string, leaving surrounding space)
  for (const pattern of FILLER_PATTERNS) {
    optimized = optimized.replace(pattern, "");
  }

  // Pass 3: Normalize whitespace
  optimized = optimized
    .replace(/[ \t]+/g, " ")     // collapse multiple spaces/tabs → single space
    .replace(/\n{3,}/g, "\n\n")  // collapse 3+ blank lines → double newline
    .trim();

  // Pass 4: Model-specific structuring
  let finalPrompt: string;
  let systemPrompt: string;

  if (model === "claude") {
    systemPrompt = getClaudePlannerSystem();
    // Claude: memory context as a clearly labeled block before the request.
    // Named sections make it easier for Claude to parse structured input.
    finalPrompt = memoryContext
      ? `[SESSION CONTEXT]\n${memoryContext}\n\n[REQUEST]\n${optimized}`
      : optimized;
  } else {
    systemPrompt = getCodexExecutorSystem();
    // Codex: ultra-minimal — context inline, task imperative.
    // No section headers — Codex doesn't need them for patch generation.
    finalPrompt = memoryContext
      ? `Context: ${memoryContext}\n\nTask: ${optimized}`
      : `Task: ${optimized}`;
  }

  // Measure optimized prompt WITHOUT system prompt — system prompt is constant
  // overhead sent on every call regardless, so it shouldn't skew the savings %.
  // We compare: (raw user input + raw memory) vs (cleaned + structured prompt).
  const optimizedTokens = estimateTokens(finalPrompt);
  const compressionRatio = optimizedTokens / Math.max(originalTokens, 1);

  return {
    optimizedPrompt: finalPrompt,
    systemPrompt,
    originalTokens,
    optimizedTokens,
    compressionRatio,
  };
}
