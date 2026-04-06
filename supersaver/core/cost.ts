/**
 * core/cost.ts
 *
 * Token estimation and savings reporting.
 * Uses the industry-standard approximation: 1 token ≈ 4 characters.
 */

import type { SavingsReport } from "./types";

// 1 token ≈ 4 English characters (GPT/Claude tokenizer approximation)
const CHARS_PER_TOKEN = 4;

// Blended cost per 1,000 tokens in USD (input + output averaged)
// Update these when pricing changes — they drive the cost savings estimate.
const COST_PER_1K_TOKENS: Record<string, number> = {
  claude: 0.015,   // claude-opus approximate blended rate
  codex: 0.002,    // gpt-4o approximate blended rate
  default: 0.01,
};

/**
 * Estimate token count from raw text.
 * Fast approximation — does NOT call any tokenizer library.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compute savings between original (user prompt + raw memory) and
 * optimized (structured prompt + system prompt) token counts.
 *
 * @param originalTokens  - tokens before optimization
 * @param optimizedTokens - tokens after optimization
 * @param model           - "claude" | "codex" | "default" — drives cost estimate
 * @param historySaved    - additional tokens saved by not sending full chat history
 * @param compressionSaved - tokens saved by filler-word removal pass
 */
export function calculateSavings(
  originalTokens: number,
  optimizedTokens: number,
  model: string = "default",
  historySaved: number = 0,
  compressionSaved: number = 0
): SavingsReport {
  const savedTokens = Math.max(0, originalTokens - optimizedTokens);
  const savingsPercent =
    originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

  const costPer1k =
    COST_PER_1K_TOKENS[model] ?? COST_PER_1K_TOKENS["default"];
  const estimatedCostSavedUSD = (savedTokens / 1000) * costPer1k;

  return {
    originalTokens,
    optimizedTokens,
    savedTokens,
    savingsPercent,
    historySaved,
    compressionSaved,
    estimatedCostSavedUSD,
  };
}
