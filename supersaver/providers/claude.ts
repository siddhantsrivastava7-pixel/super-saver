/**
 * providers/claude.ts
 *
 * Claude API caller — mock implementation.
 *
 * ─── TO ENABLE THE REAL ANTHROPIC API ────────────────────────────────────────
 * 1. npm install @anthropic-ai/sdk
 * 2. Add ANTHROPIC_API_KEY to your environment (.env or shell)
 * 3. Replace the mock body below with:
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *
 *   const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *
 *   export async function callClaude(request: ProviderRequest): Promise<ProviderResponse> {
 *     const start = Date.now();
 *     const msg = await client.messages.create({
 *       model: "claude-opus-4-6",
 *       max_tokens: request.maxTokens ?? 2048,
 *       system: request.systemPrompt,
 *       messages: [{ role: "user", content: request.prompt }],
 *     });
 *     const text = msg.content[0].type === "text" ? msg.content[0].text : "";
 *     return {
 *       output: text,
 *       tokensUsed: msg.usage.input_tokens + msg.usage.output_tokens,
 *       model: msg.model,
 *       durationMs: Date.now() - start,
 *     };
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ProviderRequest, ProviderResponse } from "../core/types";

export async function callClaude(
  request: ProviderRequest
): Promise<ProviderResponse> {
  const start = Date.now();

  // Simulate realistic Claude latency (~120ms) for development experience
  await sleep(120);

  // Mock output follows the claudePlanner system prompt schema exactly,
  // including $ prefixed verification commands for the verifier to extract.
  const mockOutput = [
    "DIAGNOSIS: The authentication logic has a token validation gap on expired sessions.",
    "PLAN:",
    "  1. Locate the session validation middleware in the target file",
    "  2. Add expiry check before passing control to the next handler",
    "  3. Return 401 with a clear error message on expiry",
    "FILES TO TOUCH: login.ts",
    "RISKS: Low — change is isolated to the middleware chain",
    "VERIFICATION STEPS:",
    "$ npm test",
    "$ npm run build",
  ].join("\n");

  return {
    output: mockOutput,
    // Mock token count: prompt tokens (estimated) + ~150 output tokens
    tokensUsed: Math.ceil(request.prompt.length / 4) + 150,
    model: "claude-mock",
    durationMs: Date.now() - start,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
