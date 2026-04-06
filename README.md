# SUPER SAVER

A Claude Code hook that reduces token usage on every prompt — automatically, invisibly, with zero workflow changes.

## What it does

Intercepts every prompt before it reaches Claude and injects optimized context:

- **Strips filler** — removes hedge words, polite padding, verbose phrases
- **Classifies task** → injects the right output policy (`[PATCH MODE]`, `[DIRECT ANSWER MODE]`, etc.)
- **Compresses history** — keeps last 4 turns verbatim, collapses older turns to a summary
- **File cache** — tracks files you've referenced; serves cached summaries instead of re-reads
- **Failure memory** — remembers what failed so Claude doesn't repeat the same mistake
- **Telemetry** — rolling log of per-turn savings at `.claude/logs/telemetry.jsonl`

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Node.js ≥ 18 (no npm install — all built-in modules)

## Setup

```bash
# 1. Clone into your project (or copy the .claude/ folder)
git clone https://github.com/siddhantsrivastava7-pixel/super-saver.git
cp -r super-saver/.claude ./your-project/.claude

# 2. Open Claude Code from your project folder
cd your-project
claude
```

That's it. The hook activates automatically.

> **Note:** Claude Code must be opened from the folder containing `.claude/`. The hook is project-scoped.

## Check your savings

```bash
node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"
```

Example output after a working session:

```json
{
  "prompts_processed": 12,
  "cache_hits": 8,
  "cache_misses": 4,
  "total_estimated_saved_tokens": 1842,
  "average_estimated_savings_percent": 23
}
```

## How savings accumulate

| Source | Tokens saved | When |
|---|---|---|
| Filler removal | 2–15 per prompt | Every prompt |
| File cache hit | ~400 each | Same file referenced across turns |
| History compression | ~180 per collapsed message | Sessions with 5+ turns |

Savings are small on short single prompts. They grow fast in multi-turn sessions where you reference files repeatedly.

## Reset session state

```bash
node -e "require('./.claude/utils/memory.js').resetMemory();"
```

## Architecture

```
.claude/
  core/
    pipeline.js          # provider-agnostic optimization steps 3–9
  adapters/
    claude.js            # formats output as additionalContext
    codex.js             # formats output as {systemPrompt, optimizedPrompt}
  hooks/
    beforePrompt.js      # thin entrypoint: stdin → pipeline → stdout
  utils/
    compressor.js        # history compression
    optimizer.js         # filler removal + prompt structuring
    fileFilter.js        # keyword-based file relevance inference
    memory.js            # persistent session memory (schema v2)
    fileHasher.js        # SHA-1 change detection
    readRegistry.js      # per-file cache registry with LRU eviction
    diffPolicy.js        # read optimization policy + budget caps
    outputPolicy.js      # task-aware output shaping (7 types)
    verifier.js          # failure memory + verification command inference
    savings.js           # token savings estimation
    telemetry.js         # rolling observability log
  tests/
    adapter-parity.js    # 8 tests — Claude/Codex produce identical core output
    compression-safety.js # 10 tests — compression never destroys critical context
    file-inference.js    # 14 tests — file registry edge cases

.codex/                  # optional Codex/OpenAI adapter
  config.toml
  hooks/
    pre_prompt.js
    post_turn.js

supersaver/              # optional standalone CLI (routes tasks to Claude or Codex)
```

## Run tests

```bash
node .claude/tests/compression-safety.js
node .claude/tests/file-inference.js
node .claude/tests/adapter-parity.js
```

## Codex / OpenAI integration

See `.codex/config.toml` and `.codex/hooks/` for wiring into an OpenAI-compatible CLI.
The same `core/pipeline.js` runs for both adapters — only the output format differs.
