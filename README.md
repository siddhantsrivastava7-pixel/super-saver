# 🚀 SUPER SAVER

### Save **50–70% tokens** in Claude Code — automatically

> Install once. Keep working normally. No new commands.

---

## ⚠️ The hidden problem

Most token waste isn't the model — it's **context**.

* You pause → Claude reprocesses everything
* Same file gets read again and again
* Long chats become bloated and expensive

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
  (biggest token saver)

* 📉 **Reduces verbose outputs**
  (task-aware output shaping)

* 🧩 **Prevents repeated mistakes**
  (failure memory)

---

## ⚡ Real results

```json
{
  "prompts_processed": 18,
  "cache_hits": 11,
  "total_estimated_saved_tokens": 28340,
  "average_estimated_savings_percent": 67,
  "lifecycle_saved_tokens": 22000
}
```

👉 Biggest gains:

* Idle gaps → ~2000 tokens saved per turn
* File cache → ~400 tokens per hit
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

Just use Claude normally.

Then check savings:

```bash
node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"
```

---

## 🧠 Why this works

Most tools optimize prompts.

Super Saver optimizes **the entire session lifecycle**:

* when to reuse context
* when to compress
* when to rebuild
* when to skip re-reading

👉 That's where real savings come from.

---

## 🔍 How savings accumulate

| Source              | Tokens saved | When             |
| ------------------- | ------------ | ---------------- |
| Filler removal      | 2–15         | Every prompt     |
| File cache          | ~400         | Same file reused |
| History compression | ~180         | Long sessions    |
| Lifecycle rebuild   | ~2000        | After idle gap   |
| Lifecycle compact   | ~360         | Long sessions    |

---

## 🧩 Architecture

```
.claude/
  core/        # shared optimization pipeline
  adapters/    # Claude + Codex output layers
  hooks/       # entrypoints (UserPromptSubmit)
  utils/       # lifecycle, cache, compression, etc.
```

---

## ⚠️ Important

* No workflow changes
* No new commands
* Your original prompt is untouched
* Everything runs automatically

---

## 🔥 Why people use it

> "I didn't change anything — just installed it — and my sessions stopped blowing up in tokens."

---

## 📦 Requirements

* Node.js ≥ 18
* Claude Code CLI

---

## 🧪 Run tests

```bash
node .claude/tests/lifecycle.js
```

All 55 tests should pass.

---

## 🚀 One line summary

> Super Saver fixes how AI sessions waste tokens — automatically.

---

## ⭐ If this saved you tokens

Star the repo — it helps others find it.
