# SUPER SAVER

A dual-model optimization layer for Claude and Codex. Sits between you and the LLMs and automatically:

- Routes tasks to the right model (Claude for planning, Codex for execution)
- Compresses session memory instead of sending full chat history
- Optimizes prompts before every API call
- Verifies results mechanically via shell commands
- Reports token savings on every run

---

## How It Works

```
Your prompt
    │
    ▼
[Classifier]  — keyword scoring → task_type, ambiguity, context_width
    │
    ▼
[Router]      — decision table → claude or codex, plan or execute
    │
    ▼
[Memory]      — load session.json → compressMemory() → ~150 token context block
    │
    ▼
[Optimizer]   — filler removal + model-specific structuring → optimized prompt
    │
    ▼
[Provider]    — call Claude or Codex (mock; real API: swap 4 lines)
    │
    ▼
[Verifier]    — extract $ commands from output → execSync → PASS / FAIL
    │
    ▼
[Logger]      — append to runs.tsv + update session.json
    │
    ▼
[Output]      — model used, tokens, savings %, result, verification status
```

### Why no full chat history?

Sending N turns of conversation on every request is wasteful. SUPER SAVER instead maintains a compact structured JSON (`store/session.json`) that captures what matters: the current goal, which files were touched, what failed, and a summary of the last plan. This produces 80-95% token savings on multi-turn sessions.

---

## Project Structure

```
supersaver/
  apps/
    cli.ts              — pipeline orchestrator + CLI definition
  core/
    types.ts            — all shared TypeScript interfaces
    classifier.ts       — keyword-scoring task classifier
    router.ts           — model routing decision table
    memory.ts           — session.json read/write + compressMemory()
    optimizer.ts        — 4-pass prompt optimization
    verifier.ts         — shell command runner (execSync)
    cost.ts             — token estimation + savings calculation
    runLogger.ts        — append-only TSV run log
  providers/
    claude.ts           — Claude caller (mock → real: swap 4 lines)
    codex.ts            — Codex caller (mock → real: swap 4 lines)
  prompts/
    claudePlanner.ts    — system prompt: structured plan format
    codexExecutor.ts    — system prompt: patch-only format
  store/
    session.json        — persistent structured memory
    runs.tsv            — append-only run history
```

---

## Setup

**Requirements:** Node.js >= 18

```bash
cd supersaver
npm install
npm run build
```

The build script automatically creates `store/session.json` and `store/runs.tsv` if they don't exist.

### Install globally (optional)

```bash
npm install -g .
```

---

## Usage

```bash
# Basic usage
supersaver run "fix authentication bug in login.ts"

# Architecture task → routed to Claude
supersaver run "design the database schema for a multi-tenant SaaS app"

# Test writing → routed to Codex
supersaver run "write unit tests for the payment module"

# Run without installing globally
node dist/apps/cli.js run "refactor the user service"

# Dev mode (no build step required)
npm run dev -- run "explain how the session middleware works"
```

---

## Example Output

```
supersaver run "fix authentication bug in login.ts"

──────────────────────────────────────────────────
Model Used:       codex (execute)

Original Tokens:  14
Optimized Tokens: 11
Savings:          21.4%

Result:
--- a/login.ts
+++ b/login.ts
@@ -42,6 +42,10 @@ function validateSession(token: string): boolean {
   if (!token) return false;
+  const decoded = decodeToken(token);
+  if (decoded.exp < Date.now() / 1000) return false;
+
   return verifySignature(token);
 }
$ npm test

Verification:     PASS
[PASS] npm test
──────────────────────────────────────────────────
```

---

## Routing Rules

| Task Type      | Model  | Mode    | Condition                        |
|----------------|--------|---------|----------------------------------|
| tiny_edit      | Codex  | execute |                                  |
| test_write     | Codex  | execute |                                  |
| bug_fix        | Codex  | execute |                                  |
| refactor       | Claude | plan    |                                  |
| debug_complex  | Claude | plan    |                                  |
| architecture   | Claude | plan    |                                  |
| explanation    | Claude | plan    |                                  |
| any (override) | Claude | plan    | ambiguity=high OR broad+deep     |

---

## Enabling Real APIs

**Claude (Anthropic):**
```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
```
Then replace the mock body in `providers/claude.ts` with the commented-out real implementation.

**Codex / GPT-4o (OpenAI):**
```bash
npm install openai
export OPENAI_API_KEY=sk-...
```
Then replace the mock body in `providers/codex.ts` with the commented-out real implementation.

---

## Run Log

Every execution appends a row to `store/runs.tsv`:

```
timestamp  iteration  model   mode     task_type  result   originalTokens  optimizedTokens  savingsPercent  verificationPassed  notes
```

Inspect with:
```bash
cat store/runs.tsv
# or
column -t -s $'\t' store/runs.tsv
```

---

## Retry & Escalation

If the primary model fails (exception or timeout):
1. Retry once (handles transient errors / rate limits)
2. If both fail → escalate to the fallback model
3. Run is logged with `result=escalated`

---

## Token Savings Breakdown

| Source                  | Savings mechanism                        |
|-------------------------|------------------------------------------|
| Memory compression      | Compact context block vs. full history   |
| Prompt optimization     | Filler removal + phrase replacement      |
| Model routing           | Codex for simple tasks (lower cost/call) |

Estimation: `1 token ≈ 4 chars`. Not exact — a real tokenizer would be more precise, but this approximation is sufficient for comparative savings reporting.
