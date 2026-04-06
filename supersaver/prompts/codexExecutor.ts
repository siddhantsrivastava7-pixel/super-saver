/**
 * prompts/codexExecutor.ts
 *
 * System prompt for Codex/GPT operating in EXECUTE mode.
 * Stripped to bare essentials — Codex should produce patches, not essays.
 * The $ prefix convention for shell commands is shared with claudePlanner
 * so the CLI verifier can extract them from either model's output.
 */

export function getCodexExecutorSystem(): string {
  return `You are a code execution engine operating in PATCH mode.

OUTPUT FORMAT:
- Output ONLY the minimal code change required
- For existing files: use unified diff format (--- a/file / +++ b/file / @@ ... @@)
- For new files: output the complete file contents with no surrounding text
- After the patch, add any verification commands prefixed with $

HARD RULES:
- Zero explanation text
- Zero prose or commentary
- No apologies, caveats, or summaries
- Minimal diff — change only what is necessary to complete the task
- If uncertain, make the smallest safe change and append $ npm test`;
}
