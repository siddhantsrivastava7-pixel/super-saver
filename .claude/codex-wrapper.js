#!/usr/bin/env node
/**
 * .claude/codex-wrapper.js
 *
 * Super Saver — drop-in wrapper for @openai/codex CLI.
 *
 * Runs the full optimization pipeline before every codex invocation:
 *   • Compresses context + smart memory rebuild
 *   • Injects output policy, file cache, session strategy
 *   • Persists session memory and telemetry
 *   • Injects optimized context via -c instructions="..."
 *   • Replaces raw prompt with optimized version
 *
 * Usage (exact same syntax as `codex`):
 *   node .claude/codex-wrapper.js "fix the auth bug"
 *   node .claude/codex-wrapper.js "fix the auth bug" --full-auto
 *   node .claude/codex-wrapper.js exec "fix the auth bug" -a never
 *   node .claude/codex-wrapper.js -m o4-mini "explain this function"
 *
 * Add once to package.json for convenience:
 *   "scripts": { "ai": "node .claude/codex-wrapper.js" }
 * Then: npm run ai "fix the auth bug"
 *
 * All flags pass through unchanged. Only two things change:
 *   1. -c instructions="<super saver context>" is prepended
 *   2. The prompt argument is replaced with the optimized version
 *
 * INVARIANT: If anything fails, the original codex call runs unmodified.
 */

"use strict";

const path        = require("path");
const { execSync, spawnSync } = require("child_process");

const CLAUDE_DIR = path.join(__dirname, "..");   // .claude/.. = project root/.claude/..
                                                   // __dirname = <project>/.claude
const UTILS      = path.join(__dirname, "utils");
const CORE       = path.join(__dirname, "core");

// ─── Flags that consume the next argument as their value ──────────────────────

const FLAGS_WITH_VALUES = new Set([
  "-m", "--model",
  "-c", "--config",
  "-p", "--profile",
  "-s", "--sandbox",
  "-a", "--ask-for-approval",
  "-C", "--cd",
  "-i", "--image",
  "--remote",
  "--remote-auth-token-env",
  "--enable",
  "--disable",
  "--add-dir",
]);

// Codex subcommands — positional args that are NOT the user prompt
const SUBCOMMANDS = new Set([
  "exec", "e", "review", "login", "logout",
  "mcp", "mcp-server", "app-server",
  "completion", "sandbox", "debug",
  "apply", "a", "resume", "fork",
  "cloud", "features", "help",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape a string as a TOML basic string value (double-quoted).
 * Used when passing instructions via -c instructions="..."
 */
function toTomlString(str) {
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Find the @openai/codex binary. Prefers a globally/locally installed `codex`
 * command; falls back to npx @openai/codex (downloads on first use).
 */
function resolveCodex() {
  try {
    // On Windows: `where codex`, on Unix: `which codex`
    execSync(process.platform === "win32" ? "where codex" : "which codex",
      { stdio: "ignore", shell: true });
    return { cmd: "codex", baseArgs: [] };
  } catch {
    return { cmd: "npx", baseArgs: ["@openai/codex"] };
  }
}

/**
 * Parse process.argv into { prompt, passthroughArgs }.
 *
 * Strategy: scan argv left-to-right, skip flag/value pairs, collect positionals.
 * The LAST positional that is not a known subcommand is treated as the prompt.
 * That positional is removed from passthroughArgs; everything else is kept.
 *
 * Returns { prompt: "", passthroughArgs: argv } if no prompt found.
 */
function parseArgs(argv) {
  const positionals = []; // { idx, val }
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("-")) {
      i += FLAGS_WITH_VALUES.has(arg) ? 2 : 1;
    } else {
      positionals.push({ idx: i, val: arg });
      i++;
    }
  }

  // Find last positional that is not a subcommand
  let promptEntry = null;
  for (let j = positionals.length - 1; j >= 0; j--) {
    if (!SUBCOMMANDS.has(positionals[j].val)) {
      promptEntry = positionals[j];
      break;
    }
  }

  if (!promptEntry) return { prompt: "", passthroughArgs: argv };

  const prompt = promptEntry.val;
  const passthroughArgs = argv.filter((_, idx) => idx !== promptEntry.idx);
  return { prompt, passthroughArgs };
}

/**
 * Run the Super Saver pipeline and return { systemPrompt, optimizedPrompt, routingResult }.
 * Returns null on any failure — caller falls through to unmodified codex call.
 */
async function runSuperSaver(prompt, cwd) {
  const { runPipeline }       = require(path.join(CORE,  "pipeline.js"));
  const { formatCodexContext } = require(path.join(__dirname, "adapters", "codex.js"));
  const { loadMemory, saveMemory, applyUpdates } = require(path.join(UTILS, "memory.js"));

  const memory      = loadMemory();
  const currentTurn = (memory.savings?.prompts_processed ?? 0) + 1;

  const result = await runPipeline({
    prompt,
    transcriptPath: "",   // no transcript available from CLI wrapper
    cwd,
    memory,
    currentTurn,
  });

  // Persist memory (same as beforePrompt.js)
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

  const { systemPrompt, optimizedPrompt } = formatCodexContext(result);
  return { systemPrompt, optimizedPrompt, routingResult: result.routingResult };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cwd  = process.cwd();

  // Nothing to optimize — pass straight through
  if (argv.length === 0) {
    const { cmd, baseArgs } = resolveCodex();
    process.exit(spawnSync(cmd, baseArgs, { stdio: "inherit", shell: false }).status ?? 0);
  }

  const { prompt, passthroughArgs } = parseArgs(argv);

  // Too short to bother optimizing — pass through unchanged
  if (!prompt || prompt.trim().length < 10) {
    const { cmd, baseArgs } = resolveCodex();
    process.exit(spawnSync(cmd, [...baseArgs, ...argv], { stdio: "inherit", shell: false }).status ?? 0);
  }

  // ── Run Super Saver pipeline ───────────────────────────────────────────────
  let systemPrompt     = "";
  let optimizedPrompt  = prompt;

  try {
    const ss = await runSuperSaver(prompt.trim(), cwd);
    if (ss) {
      systemPrompt    = ss.systemPrompt;
      optimizedPrompt = ss.optimizedPrompt || prompt;
    }
  } catch {
    // Non-fatal: fall through with raw prompt, no instructions injected
  }

  // ── Build final codex args ─────────────────────────────────────────────────
  const { cmd, baseArgs } = resolveCodex();
  const finalArgs = [...baseArgs];

  // Inject Super Saver context as Codex instructions override.
  // -c instructions="..." sets the system-level instructions for this call.
  if (systemPrompt && systemPrompt.length > 0) {
    finalArgs.push("-c", `instructions=${toTomlString(systemPrompt)}`);
  }

  // Pass all original flags through (model, sandbox, approval, etc.)
  finalArgs.push(...passthroughArgs);

  // Add the (possibly optimized) prompt last
  finalArgs.push(optimizedPrompt);

  // ── Spawn codex ────────────────────────────────────────────────────────────
  const result = spawnSync(cmd, finalArgs, {
    stdio:  "inherit",
    shell:  false,
    cwd,
  });

  process.exit(result.status ?? 0);
}

main().catch(() => {
  // Ultimate fallback: run codex with original args unchanged
  const { cmd, baseArgs } = resolveCodex();
  process.exit(
    spawnSync(cmd, [...baseArgs, ...process.argv.slice(2)], {
      stdio: "inherit", shell: false,
    }).status ?? 0
  );
});
