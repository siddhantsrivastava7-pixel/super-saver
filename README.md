# 🚀 SUPER SAVER v5

### Save **50–70% tokens** in Claude Code — automatically

> Install once. Keep working normally. No new commands.

---

## ⚠️ The hidden problem

Most token waste isn't the model — it's **context**.

* You pause → Claude reprocesses everything
* Same file gets read again and again
* Long chats become bloated and expensive
* Decisions and constraints get forgotten between turns
* **Wrong session mode** — Claude drags old execution context into a brand-new task

👉 You're often wasting **40–70% tokens** without realizing it

---

## 💡 What this does

**Super Saver** sits inside Claude Code and optimizes every prompt *before it hits the model*.

It works silently in the background.

### ✨ Automatically:

* 🧹 **Removes prompt waste**
  (filler words, verbose phrasing)

* 🧠 **Compresses long conversations**
  (adaptive context window)

* 📂 **Avoids re-reading the same files**
  (smart file cache + diff detection)

* 🔄 **Rebuilds context after idle gaps**
  (biggest token saver — structured memory, not raw history)

* 📉 **Reduces verbose outputs**
  (task-aware output shaping)

* 🧩 **Prevents repeated mistakes**
  (failure memory + known issue tracking)

* 🧠 **Smart Memory Engine** *(v2)*
  (extracts decisions, constraints, known issues — survives session gaps)

* 📊 **Proof Engine** *(v2)*
  (honest before/after estimates — every number is traceable)

* 🔧 **Tool Awareness Engine** *(v2)*
  (suppresses unnecessary tool calls on simple tasks, tracks impact)

* 🗑️ **Output Waste Analyzer** *(v4)*
  (detects redundant prose in prior responses and prevents recurrence)

* 🧭 **Session Strategy Engine** *(v5)*
  (detects task intent shifts and adjusts context mode automatically)

---

## 📊 Real results

```json
{
  "prompts_processed": 71,
  "estimated_total_tokens_without_optimizer": 15978,
  "estimated_total_tokens_with_optimizer": 10107,
  "estimated_total_tokens_saved": 5871,
  "estimated_efficiency_percent": 37,
  "prompt_saved_tokens": 312,
  "history_saved_tokens": 1440,
  "read_cache_saved_tokens": 1600,
  "output_policy_saved_tokens": 519,
  "lifecycle_saved_tokens": 2000,
  "tool_suppressed_turns": 18,
  "estimated_suppression_saved": 3600,
  "lifecycle_compact_turns": 8,
  "lifecycle_rebuild_turns": 2
}
```

👉 Biggest gains:

* Idle gaps → ~2000 tokens saved per rebuild turn
* File cache → ~400 tokens per hit
* Tool suppression → ~200 tokens per blocked call
* Long sessions → massive compounding savings

---

## 🛠 Install (30 seconds)

### Claude Code

```bash
cd your-project
npx github:siddhantsrivastava7-pixel/super-saver
```

Restart Claude Code → done.

---

### Claude + Codex

```bash
npx github:siddhantsrivastava7-pixel/super-saver --codex
```

---

## ✅ Verify it's working

Just use Claude normally. Then check savings:

```bash
node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"
```

---

## 🧠 v2: Smart Memory Engine

Extracts structured facts from every prompt using keyword heuristics — no ML, no API calls.

Tracked per-session:

| Field | What it stores |
|---|---|
| `decisions` | Architectural choices ("decided to use JWT") |
| `constraints` | Hard rules ("never add external dependencies") |
| `known_issues` | Bugs and errors mentioned ("bug in auth.js") |
| `important_files` | Files explicitly referenced |

**Confidence filter**: only stores decisions with strong commitment verbs.

| Input | Stored? |
|---|---|
| `"decided to use PostgreSQL"` | ✅ yes |
| `"maybe we should try JWT"` | ❌ no — hedging language |
| `"we'll use TypeScript"` | ✅ yes |
| `"thinking about switching to Redis"` | ❌ no — speculative |

**Memory decay** *(v3)*: each item carries a confidence score that decays 0.03/turn. Items below 0.15 are pruned. Superseded items (contradicted by newer decisions) are filtered from context.

When an idle gap is detected, rebuild mode uses this structured memory instead of raw history:

```
[SESSION REBUILD]
Goal: Migrate auth system to JWT
Current Task: Fix token expiry bug

Key Decisions:
* decided to use JWT instead of sessions
* going with PostgreSQL for the database

Constraints:
* never store passwords in plaintext
* always use HTTPS

Known Issues:
* bug in token validation logic
* session not clearing on logout

Important Files:
* auth.js
* middleware.js
```

---

## 📊 v2: Proof Engine

Every number traces back to a real measurement. No inflation.

**Invariants always enforced:**

```
total_without = total_with + total_saved
efficiency %  = total_saved / total_without × 100
```

`total_with` includes both the optimized prompt AND all injected context blocks — so efficiency reflects the full cost of running the optimizer, not just filler removal.

Per-turn deltas are visible in the telemetry log:

```jsonl
{"turn":12,"task":"code-fix","per_turn_saved_tokens":220,"proof_without":380,"proof_with":160}
{"turn":13,"task":"explanation","per_turn_saved_tokens":0,"proof_without":45,"proof_with":45}
```

---

## 🔧 v2: Tool Awareness Engine

Tracks unnecessary tool calls and suppresses them on simple tasks.

**Task-type rules:**

| Task type | Tool policy |
|---|---|
| `explanation`, `default` | Suppressed — Claude reasons from context |
| `code-fix`, `implementation`, `refactor` | Allowed — tools are expected |

**Repeated-read detection**: if 3+ files have been accessed across multiple turns, injects:

```
[TOOL OPTIMIZATION]
This session has repeated file access.
Reuse cached understanding unless a fresh read is required.
```

---

## 🗑️ v4: Output Waste Analyzer

Detects redundant content in Claude's *previous* response and injects feedback before the next turn — telling Claude to skip it this time.

**Five waste categories detected:**

| Category | Example |
|---|---|
| Preamble | "Sure! I'll help you with that..." |
| Repeated context | Restating what the user just said |
| Unnecessary prose | "It's worth noting that..." |
| Avoidable explanation | Explaining obvious stdlib behavior |
| Verbose structure | Markdown headers for a 2-line answer |

Feedback is only injected when estimated waste exceeds 20 tokens. The feedback block itself is 3 lines — modeling the terse output it requests.

**`follow-up` task type**: when a correction is detected (short prompt + correction phrase), switches to delta-only mode — only the change, nothing restated.

---

## 🧭 v5: Session Strategy Engine

Solves a subtler waste: **using the wrong session mode for the task**.

Lifecycle handles *when* (idle gap, session length). Strategy handles *what kind* of session this is.

### Five session modes

| Mode | Trigger | Context behavior |
|---|---|---|
| `continuation` | Same intent, same files | Full compressed history, all decisions |
| `fresh-task` | New intent, low similarity | Clear execution history, keep constraints only |
| `same-files` | Same codebase area, different goal | Keep file knowledge, drop task decisions |
| `exploration` | Architectural / design work | Wide context (LOW compression), keep decisions |
| `execution` | Narrow targeted fix | Tight context (HIGH compression), focused |

### Task similarity scoring

Five weighted signals determine whether the current task is a continuation or a shift:

| Signal | Weight | What it measures |
|---|---|---|
| Verb category alignment | 0.30 | execution vs exploration verbs |
| File overlap | 0.25 | shared file mentions vs memory |
| Task type consistency | 0.20 | same outputPolicy classification |
| Word overlap | 0.15 | 4+ char keyword reuse |
| Scope alignment | 0.10 | broad vs narrow intent |

When a mode change is detected, Claude sees:

```
[SESSION MODE]
New task detected — execution history cleared. Project constraints preserved.
```

**Task-shift reset**: `fresh-task` mode triggers `applyTaskShiftReset` — clears `known_issues`, decays `decisions` by 0.4× confidence, preserves `constraints`.

---

## 🔍 How savings accumulate

| Source | Tokens saved | When |
|---|---|---|
| Filler removal | 2–15 | Every prompt |
| File cache | ~400 | Same file reused |
| History compression | ~180 | Long sessions |
| Lifecycle rebuild | ~2000 | After idle gap |
| Lifecycle compact | ~360 | Long sessions |
| Tool suppression | ~200/call | Simple tasks |
| Output shaping | ~50 | Non-default task types |
| Output waste feedback | ~80 | Redundant prior response |
| Session strategy | varies | Wrong-mode prevention |

---

## 🧩 Architecture

```
.claude/
  core/
    pipeline.js         # provider-agnostic optimization pipeline
  adapters/
    claude.js           # Claude Code output layer
    codex.js            # Codex CLI output layer
  hooks/
    beforePrompt.js     # UserPromptSubmit entrypoint
  utils/
    sessionStrategy.js  # v5: 5-mode session strategy engine
    outputWaste.js      # v4: post-response redundancy analyzer
    outputPolicy.js     # task-aware output shaping + follow-up mode
    smartMemory.js      # v2: structured memory extraction
    memoryDecay.js      # v3: MemoryItem confidence decay + supersede
    proofEngine.js      # v2: before/after token proof
    toolTracker.js      # v2: tool suppression + impact
    lifecycle.js        # idle gap + compact mode detection
    compressor.js       # conversation history compression
    diffPolicy.js       # file read deduplication
    savings.js          # token savings accumulation
    telemetry.js        # observability layer
    memory.js           # persistent session memory
```

---

## ⚠️ Important

* No workflow changes
* No new commands
* Your original prompt is untouched
* Everything runs automatically
* Works across session gaps and restarts

---

## 🧪 Run tests

```bash
npm test
```

395+ tests across 12 suites — all should pass.

Or run individual suites:

```bash
node .claude/tests/session-strategy.js  # 77 tests — 5-mode strategy engine
node .claude/tests/output-waste.js      # 60 tests — redundancy detection
node .claude/tests/memory-decay.js      # 72 tests — confidence decay + supersede
node .claude/tests/smart-memory.js      # 75 tests — memory extraction + confidence filter
node .claude/tests/proof-engine.js      # 28 tests — before/after invariants
node .claude/tests/tool-awareness.js    # 42 tests — suppression + impact
node .claude/tests/lifecycle.js         # 16 tests — rebuild/compact modes
node .claude/tests/savings-aggregation.js  # 39 tests — math invariants
```

---

## 📦 Requirements

* Node.js ≥ 18
* Claude Code CLI

---

## 🚀 One line summary

> Super Saver fixes how AI sessions waste tokens — automatically, invisibly, and provably.

---

## ⭐ If this saved you tokens

Star the repo — it helps others find it.
