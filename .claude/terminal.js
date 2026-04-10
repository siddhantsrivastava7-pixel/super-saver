#!/usr/bin/env node
/**
 * .claude/terminal.js
 *
 * SUPER SAVER — Unified AI Terminal
 *
 * A single terminal that routes each prompt to Claude Code or Codex
 * automatically, based on what you're asking. Super Saver's classification
 * engine decides which AI gives you the best result at the lowest cost.
 *
 * Usage:
 *   node .claude/terminal.js
 *
 * Or via npm script (added by setup.js):
 *   npm run chat
 *
 * Routing rules:
 *   exploration / explanation / design / high-risk  → Claude
 *   execution   / code-fix   / narrow / low-risk    → Codex
 *
 * Overrides:
 *   @claude  fix the bug        → force Claude
 *   @codex   explain this       → force Codex
 *
 * Commands:
 *   /status   — show session stats
 *   /history  — show routing decisions this session
 *   /clear    — clear screen
 *   /exit     — quit (also: Ctrl+C, "exit", "quit")
 */

"use strict";

const readline     = require("readline");
const path         = require("path");
const { spawnSync, execSync } = require("child_process");

const UTILS = path.join(__dirname, "utils");
const CORE  = path.join(__dirname, "core");

// ─── Colours ──────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
};

function c(color, str) { return `${C[color]}${str}${C.reset}`; }

// ─── CLI Resolution ───────────────────────────────────────────────────────────

function resolveCmd(name, npxPkg) {
  try {
    execSync(
      process.platform === "win32" ? `where ${name}` : `which ${name}`,
      { stdio: "ignore", shell: true }
    );
    return { cmd: name, baseArgs: [] };
  } catch {
    return { cmd: "npx", baseArgs: [npxPkg] };
  }
}

const CLAUDE_CMD = resolveCmd("claude", "@anthropic-ai/claude-code");
const CODEX_CMD  = resolveCmd("codex",  "@openai/codex");

// ─── Routing Decision ─────────────────────────────────────────────────────────

/**
 * Decide which AI to use based on classification signals.
 *
 * Principles:
 *   Claude  — better reasoning, handles ambiguity, exploration, architecture
 *   Codex   — faster, autonomous execution, code changes, narrow tasks
 *
 * @returns {"claude"|"codex"}
 */
function routeToAI(taskType, verbCategory, risk, scope) {
  // High risk → Claude (complex problems need stronger reasoning)
  if (risk === "high") return "claude";

  // Explicit exploration signals → Claude
  if (verbCategory === "exploration") return "claude";
  if (taskType === "explanation")     return "claude";
  if (taskType === "review")          return "claude";

  // Narrow execution → Codex (fast, autonomous, stays focused)
  if (verbCategory === "execution" && (scope === "narrow" || scope === "medium")) {
    return "codex";
  }

  // Low-risk code tasks → Codex
  if (risk === "low" && (
    taskType === "code-fix" ||
    taskType === "implementation" ||
    taskType === "refactor" ||
    taskType === "test"
  )) return "codex";

  // Default: Claude (safer for ambiguous tasks)
  return "claude";
}

function routeLabel(ai) {
  return ai === "claude"
    ? c("cyan",  "claude")
    : c("green", "codex");
}

// ─── TOML string escaping (for Codex -c instructions) ─────────────────────────

function toTomlString(str) {
  return `"${str
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

// ─── Run pipeline + route ─────────────────────────────────────────────────────

async function processPrompt(rawPrompt, sessionHistory) {
  const { runPipeline }        = require(path.join(CORE,  "pipeline.js"));
  const { formatCodexContext } = require(path.join(__dirname, "adapters", "codex.js"));
  const { loadMemory, saveMemory, applyUpdates } = require(path.join(UTILS, "memory.js"));
  const { classifyVerbCategory, classifyScope }  = require(path.join(UTILS, "sessionStrategy.js"));

  // ── Parse force-routing prefix ─────────────────────────────────────────────
  let forcedAI  = null;
  let prompt    = rawPrompt.trim();

  if (/^@claude\s+/i.test(prompt)) {
    forcedAI = "claude";
    prompt   = prompt.replace(/^@claude\s+/i, "").trim();
  } else if (/^@codex\s+/i.test(prompt)) {
    forcedAI = "codex";
    prompt   = prompt.replace(/^@codex\s+/i, "").trim();
  }

  if (!prompt) return;

  // ── Run Super Saver pipeline ───────────────────────────────────────────────
  let systemPrompt    = "";
  let optimizedPrompt = prompt;
  let ai              = forcedAI ?? "claude";
  let taskType        = "default";
  let risk            = "medium";
  let verbCategory    = "neutral";
  let scope           = "medium";
  let confidence      = 0.5;

  try {
    const memory      = loadMemory();
    const currentTurn = (memory.savings?.prompts_processed ?? 0) + 1;

    const result = await runPipeline({
      prompt, transcriptPath: "", cwd: process.cwd(), memory, currentTurn,
    });

    // Persist memory
    try {
      applyUpdates(memory, {
        prompt,
        files:                  result.relevantFiles,
        updatedRegistry:        result.updatedRegistry,
        updatedSavings:         result.updatedSavings,
        lifecycleState:         result.lifecycleState,
        smartMemoryUpdate:      result.smartMemoryUpdate,
        currentTurn,
        taskType:               result.taskType,
        sessionMode:            result.sessionStrategy?.sessionMode,
        strategyTriggeredReset: result.sessionStrategy?.contextStrategy?.triggerReset ?? false,
        modelUsed:              result.routingResult?.model    ?? "",
        reasoningLevel:         result.routingResult?.reasoning ?? "",
        lastTurnFailed:         result.routingResult?.isWeak   ?? false,
      });
      saveMemory(memory);
    } catch { /* non-fatal */ }

    taskType     = result.taskType;
    risk         = result.routingResult?.risk       ?? "medium";
    confidence   = result.routingResult?.confidence ?? 0.5;
    verbCategory = classifyVerbCategory(prompt);
    scope        = classifyScope(prompt);
    optimizedPrompt = result.optimizedTask || prompt;

    const { systemPrompt: sp } = formatCodexContext(result);
    systemPrompt = sp;

    if (!forcedAI) {
      ai = routeToAI(taskType, verbCategory, risk, scope);
    }
  } catch {
    // Non-fatal: use raw prompt, default routing
    ai = forcedAI ?? "claude";
  }

  // ── Show routing decision ──────────────────────────────────────────────────
  const forced = forcedAI ? c("gray", " (forced)") : "";
  const tag    = `${taskType} · ${risk} risk · ${verbCategory}`;
  process.stdout.write(
    `  ${C.bold}→${C.reset} ${routeLabel(ai)}  ${c("gray", tag)}${forced}\n\n`
  );

  // Record for /history
  sessionHistory.push({ prompt: rawPrompt.slice(0, 60), ai, taskType, risk });

  // ── Dispatch ───────────────────────────────────────────────────────────────
  if (ai === "claude") {
    runClaude(optimizedPrompt, systemPrompt);
  } else {
    runCodex(optimizedPrompt, systemPrompt);
  }
}

// ─── Claude dispatch ──────────────────────────────────────────────────────────

function runClaude(prompt, systemPrompt) {
  const { cmd, baseArgs } = CLAUDE_CMD;

  // Claude CLI: `claude -p "prompt"` for non-interactive output
  // System context injected via --system-prompt if supported, else prepended
  const args = [...baseArgs, "-p", prompt];

  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.error) {
    // Fallback: try with npx
    spawnSync("npx", ["@anthropic-ai/claude-code", "-p", prompt],
      { stdio: "inherit", shell: false });
  }
  process.stdout.write("\n");
}

// ─── Codex dispatch ───────────────────────────────────────────────────────────

function runCodex(prompt, systemPrompt) {
  const { cmd, baseArgs } = CODEX_CMD;

  const args = [...baseArgs, "exec"];
  if (systemPrompt) {
    args.push("-c", `instructions=${toTomlString(systemPrompt)}`);
  }
  args.push("-a", "never", prompt);

  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.error) {
    spawnSync("npx", ["@openai/codex", "exec", "-a", "never", prompt],
      { stdio: "inherit", shell: false });
  }
  process.stdout.write("\n");
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function showStatus() {
  try {
    const { getMetrics } = require(path.join(UTILS, "telemetry.js"));
    const m = getMetrics();
    if (!m || m.prompts_processed === 0) {
      console.log(c("gray", "  No session data yet."));
      return;
    }
    console.log([
      "",
      `  ${c("bold", "Session stats")}`,
      `  Prompts processed : ${m.prompts_processed}`,
      `  Tokens saved      : ${m.total_estimated_saved_tokens}`,
      `  Efficiency        : ${m.estimated_efficiency_percent}%`,
      `  Routing — claude  : ${m.model_routing_low + m.model_routing_medium} · codex: ${m.model_routing_high}`,
      "",
    ].join("\n"));
  } catch {
    console.log(c("gray", "  Could not load metrics."));
  }
}

function showHistory(history) {
  if (history.length === 0) {
    console.log(c("gray", "  No history yet."));
    return;
  }
  console.log("");
  history.forEach((h, i) => {
    const ai  = routeLabel(h.ai);
    const tag = c("gray", `${h.taskType} · ${h.risk}`);
    console.log(`  ${c("dim", String(i + 1).padStart(2))}  ${ai}  ${tag}  ${c("dim", h.prompt)}`);
  });
  console.log("");
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function showBanner() {
  console.log([
    "",
    `  ${c("bold", "SUPER SAVER")}  ${c("gray", "unified AI terminal")}`,
    `  ${c("cyan", "claude")} · ${c("green", "codex")}  ${c("gray", "auto-routed by task")}`,
    "",
    `  ${c("gray", "Type a prompt. Prefix with @claude or @codex to force.")}`,
    `  ${c("gray", "/status  /history  /clear  /exit")}`,
    "",
  ].join("\n"));
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  showBanner();

  const sessionHistory = [];

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: `${c("bold", "›")} `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) { rl.prompt(); return; }

    // Built-in commands
    if (input === "/exit" || input === "exit" || input === "quit") {
      console.log(c("gray", "\n  Goodbye.\n"));
      process.exit(0);
    }
    if (input === "/clear") {
      process.stdout.write("\x1Bc");
      showBanner();
      rl.prompt();
      return;
    }
    if (input === "/status") {
      showStatus();
      rl.prompt();
      return;
    }
    if (input === "/history") {
      showHistory(sessionHistory);
      rl.prompt();
      return;
    }

    // Skip short inputs
    if (input.length < 5) {
      console.log(c("gray", "  (too short to route — type a full prompt)"));
      rl.prompt();
      return;
    }

    // Pause readline while the AI runs (avoids input mixing with output)
    rl.pause();
    process.stdout.write("\n");

    try {
      await processPrompt(input, sessionHistory);
    } catch (e) {
      console.error(c("red", `  Error: ${e.message}`));
    }

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(c("gray", "\n  Goodbye.\n"));
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log(c("gray", "\n  Goodbye.\n"));
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
