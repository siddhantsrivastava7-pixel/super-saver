# SUPER SAVER

A token optimization hook for Claude Code and Codex CLI. Intercepts every prompt before it reaches the model and injects efficient context — automatically, invisibly, with zero workflow changes.

## What it does

- **Strips filler** — removes hedge words, polite padding, verbose phrases
- **Classifies task** → injects the right output policy (`[PATCH MODE]`, `[DIRECT ANSWER MODE]`, etc.)
- **Compresses history** — adaptive window (LOW/MEDIUM/HIGH) based on session state
- **File cache** — SHA-1 registry; serves cached summaries instead of re-reads
- **Lifecycle optimization** — detects idle gaps and long sessions:
  - Idle gap > 5 min → `[SESSION REBUILD]` replaces full history (~2000 tokens saved)
  - Turn > 15 → `[SESSION COMPACT MODE]` with aggressive compression (~360 tokens saved)
- **Tool policy** — discourages unnecessary tool calls on simple tasks
- **Failure memory** — remembers what failed so the model doesn't repeat the same mistake
- **Telemetry** — rolling log of per-turn savings at `.claude/logs/telemetry.jsonl`

## Requirements

- Node.js ≥ 18 (no npm install — all built-in modules)
- Claude Code CLI **or** an OpenAI-compatible Codex CLI

---

## Install

### Claude Code — one command

```bash
cd your-project
npx github:siddhantsrivastava7-pixel/super-saver
```

Then open Claude Code from your project folder. The hook is live.

### Codex CLI — one command

```bash
cd your-project
npx github:siddhantsrivastava7-pixel/super-saver --codex
```

Then wire `.codex/config.toml` hooks into your Codex CLI config (see [Codex details](#codex-details) below).

### Both at once

```bash
npx github:siddhantsrivastava7-pixel/super-saver --codex
```

The installer:
- Copies `.claude/` (and `.codex/` if `--codex`) into the current directory
- Safely merges the `UserPromptSubmit` hook into any existing `.claude/settings.json` without touching your other settings
- Runs a smoke test to confirm the hook produces valid output
- Prints next steps

> **Re-running is safe** — existing files are updated, hook entries are never duplicated.

---

## Codex details

Each turn `pre_prompt.js` calls the shared pipeline and writes to stdout:

```json
{
  "system_prompt": "File context: ...\nReturn only the corrected code as a unified diff.",
  "user_prompt":   "Fix the null check in validateToken",
  "metadata": {
    "taskType":             "code-fix",
    "lifecycleMode":        "normal",
    "lifecycleSavedTokens": 0,
    "cacheHits":            2,
    "savingsLine":          "Session: 6 prompts | ~840 tokens saved (31% efficiency) | 4 file cache hits"
  }
}
```

Use `system_prompt` as the `system` role and `user_prompt` as the `user` role:

```js
const { system_prompt, user_prompt } = JSON.parse(hookOutput);

await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: system_prompt },
    { role: "user",   content: user_prompt },
  ],
});
```

Wire the hooks in `.codex/config.toml`:

```toml
[hooks]
pre_prompt = "node .codex/hooks/pre_prompt.js"
post_turn  = "node .codex/hooks/post_turn.js"
```

The exact config key depends on your Codex CLI version — check its docs for `pre_prompt` or `beforeTurn` equivalents.

---

## Check your savings

```bash
node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"
```

Example output after a working session:

```json
{
  "prompts_processed": 18,
  "cache_hits": 11,
  "total_estimated_saved_tokens": 28340,
  "average_estimated_savings_percent": 67,
  "prompt_saved_tokens": 210,
  "history_saved_tokens": 1440,
  "read_cache_saved_tokens": 4400,
  "output_policy_saved_tokens": 700,
  "lifecycle_saved_tokens": 22000,
  "lifecycle_normal_turns": 14,
  "lifecycle_compact_turns": 3,
  "lifecycle_rebuild_turns": 1
}
```

## How savings accumulate

| Source | Tokens saved | When |
|---|---|---|
| Filler removal | 2–15 per prompt | Every prompt |
| File cache hit | ~400 each | Same file referenced across turns |
| History compression | ~180 per collapsed message | Sessions with 5+ turns |
| Lifecycle rebuild | ~2000 per idle-gap turn | After a pause > 5 minutes |
| Lifecycle compact | ~360 per turn | Sessions > 15 turns |
| Tool policy | ~50 per turn | Explanation / small-edit tasks |

---

## Reset session state

```bash
node -e "require('./.claude/utils/memory.js').resetMemory();"
```

---

## Architecture

```
.claude/
  core/
    pipeline.js          # provider-agnostic optimization steps 2b–9
  adapters/
    claude.js            # formats output as additionalContext
    codex.js             # formats output as {systemPrompt, optimizedPrompt, metadata}
  hooks/
    beforePrompt.js      # thin Claude entrypoint: stdin → pipeline → stdout
  utils/
    lifecycle.js         # idle gap detection, rebuild/compact context, tool policy
    compressor.js        # adaptive history compression (LOW/MEDIUM/HIGH)
    optimizer.js         # filler removal + prompt structuring
    fileFilter.js        # keyword-based file relevance inference
    memory.js            # persistent session memory (schema v2)
    fileHasher.js        # SHA-1 change detection
    readRegistry.js      # per-file cache registry with LRU eviction
    diffPolicy.js        # read optimization policy + budget caps
    outputPolicy.js      # task-aware output shaping (7 types)
    verifier.js          # failure memory + verification command inference
    savings.js           # token savings estimation (5-category breakdown)
    telemetry.js         # rolling observability log
  tests/
    compression-safety.js # 10 tests — compression never destroys critical context
    file-inference.js     # 14 tests — file registry edge cases
    adapter-parity.js     #  8 tests — Claude/Codex produce identical core output
    cache-hit.js          #  7 tests — end-to-end cache hit behavior
    lifecycle.js          # 16 tests — all 9 lifecycle optimization features

.codex/
  config.toml
  hooks/
    pre_prompt.js
    post_turn.js
```

---

## Run tests

```bash
node .claude/tests/compression-safety.js
node .claude/tests/file-inference.js
node .claude/tests/adapter-parity.js
node .claude/tests/cache-hit.js
node .claude/tests/lifecycle.js
```

All 55 tests should pass.
