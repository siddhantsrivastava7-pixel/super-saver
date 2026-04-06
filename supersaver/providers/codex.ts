/**
 * providers/codex.ts
 *
 * Codex / OpenAI API caller — mock implementation.
 *
 * ─── TO ENABLE THE REAL OPENAI API ───────────────────────────────────────────
 * 1. npm install openai
 * 2. Add OPENAI_API_KEY to your environment (.env or shell)
 * 3. Replace the mock body below with:
 *
 *   import OpenAI from "openai";
 *
 *   const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 *   export async function callCodex(request: ProviderRequest): Promise<ProviderResponse> {
 *     const start = Date.now();
 *     const completion = await client.chat.completions.create({
 *       model: "gpt-4o",
 *       max_tokens: request.maxTokens ?? 1024,
 *       temperature: request.temperature ?? 0.2,
 *       messages: [
 *         { role: "system", content: request.systemPrompt },
 *         { role: "user",   content: request.prompt },
 *       ],
 *     });
 *     return {
 *       output: completion.choices[0].message.content ?? "",
 *       tokensUsed: completion.usage?.total_tokens ?? 0,
 *       model: completion.model,
 *       durationMs: Date.now() - start,
 *     };
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ProviderRequest, ProviderResponse } from "../core/types";

export async function callCodex(
  request: ProviderRequest
): Promise<ProviderResponse> {
  const start = Date.now();

  // Simulate realistic Codex latency (~80ms) — faster than Claude
  await sleep(80);

  // Mock output: unified diff format as required by codexExecutor system prompt
  const mockOutput = [
    "--- a/login.ts",
    "+++ b/login.ts",
    "@@ -42,6 +42,10 @@ function validateSession(token: string): boolean {",
    "   if (!token) return false;",
    "+  // Reject tokens past their expiry timestamp",
    "+  const decoded = decodeToken(token);",
    "+  if (decoded.exp < Date.now() / 1000) return false;",
    "+",
    "   return verifySignature(token);",
    " }",
    "$ npm test",
  ].join("\n");

  return {
    output: mockOutput,
    // Mock token count: prompt tokens (estimated) + ~80 output tokens
    tokensUsed: Math.ceil(request.prompt.length / 4) + 80,
    model: "codex-mock",
    durationMs: Date.now() - start,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
