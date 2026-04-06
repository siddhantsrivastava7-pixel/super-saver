/**
 * .claude/core/pipeline.js
 *
 * Provider-Agnostic Optimization Pipeline
 *
 * Steps 3–9 extracted from the 11-step beforePrompt.js orchestrator.
 * This is a pure function: it accepts pre-loaded state, performs all
 * prompt-level transformations, and returns a result object.
 *
 * No I/O. No provider knowledge. No formatting decisions.
 * Both adapters (Claude, Codex) call this and get identical core outputs.
 * Only the final rendering differs between adapters.
 *
 * Step map:
 *   3. Compress conversation history
 *   4. Optimize the prompt (filler removal + structuring)
 *   5. Filter relevant files (keyword inference or explicit mention)
 *   6. Apply read optimization policy (registry-based dedup)
 *   7. Classify task type + get output policy rules
 *   8. Inject retry/failure context if applicable
 *   9. Estimate and accumulate token savings
 *
 * @param {{
 *   prompt:         string,   — trimmed user prompt
 *   transcriptPath: string,   — path to JSONL transcript (may be empty)
 *   cwd:            string,   — project working directory
 *   memory:         object,   — pre-loaded session memory (schema v2)
 *   currentTurn:    number,   — prompts_processed + 1
 * }} input
 *
 * @returns {PipelineResult}
 */

"use strict";

const path = require("path");

const UTILS = path.join(__dirname, "../utils");

const { compressHistory }                      = require(path.join(UTILS, "compressor.js"));
const { optimizePrompt, detectMultiStep }      = require(path.join(UTILS, "optimizer.js"));
const { filterRelevantFiles }                  = require(path.join(UTILS, "fileFilter.js"));
const { applyReadPolicy }                      = require(path.join(UTILS, "diffPolicy.js"));
const { getOutputPolicy }                      = require(path.join(UTILS, "outputPolicy.js"));
const {
  inferVerificationCommand,
  getFailureContext,
  isCodeModifyingTask,
  formatVerificationSuggestion,
}                                              = require(path.join(UTILS, "verifier.js"));
const { updateSavings, formatSavingsBlock }    = require(path.join(UTILS, "savings.js"));
const { recordTurn }                           = require(path.join(UTILS, "telemetry.js"));

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline({ prompt, transcriptPath, cwd, memory, currentTurn }) {

  // ── Step 3: Compress history ─────────────────────────────────────────────
  let contextBlock = "";
  let messagesCompressed = 0;
  try {
    const compression = compressHistory(transcriptPath, prompt);
    contextBlock       = compression.contextBlock;
    messagesCompressed = Math.max(
      0,
      compression.originalMessages - compression.compressedMessages
    );
  } catch {
    // Non-fatal — proceed without history context
  }

  // ── Step 4: Optimize the prompt ──────────────────────────────────────────
  let optimizedTask  = prompt;
  let originalChars  = prompt.length;
  let optimizedChars = prompt.length;
  let isMultiStep    = false;
  try {
    const opt   = optimizePrompt(prompt);
    optimizedTask  = opt.optimizedTask;
    originalChars  = opt.originalChars;
    optimizedChars = opt.optimizedChars;
    isMultiStep    = detectMultiStep(prompt);
  } catch {
    // Non-fatal — use raw prompt
  }

  // ── Step 5: Filter relevant files ────────────────────────────────────────
  let relevantFiles = [];
  let fileSource    = "none";
  try {
    const fileResult = filterRelevantFiles(prompt, cwd);
    relevantFiles    = fileResult.files;
    fileSource       = fileResult.source;
  } catch {
    // Non-fatal
  }

  // ── Step 6: Apply read optimization policy ───────────────────────────────
  let fileCacheBlock  = "";
  let updatedRegistry = memory.read_registry ?? {};
  let cacheHits       = 0;
  if (relevantFiles.length > 0) {
    try {
      const readResult = applyReadPolicy(
        relevantFiles,
        updatedRegistry,
        cwd,
        currentTurn,
        fileSource === "explicit"
      );
      fileCacheBlock  = readResult.block;
      updatedRegistry = readResult.updatedRegistry;
      cacheHits       = readResult.cacheHits;
    } catch {
      fileCacheBlock = relevantFiles.map((f) => `  - ${f}`).join("\n");
    }
  }

  // ── Step 7: Task-aware output policy ─────────────────────────────────────
  let outputPolicyBlock = "";
  let taskType          = "default";
  try {
    const policy   = getOutputPolicy(optimizedTask, isMultiStep);
    outputPolicyBlock = policy.block;
    taskType          = policy.taskType;
  } catch {
    outputPolicyBlock = "Keep answer concise. Do not repeat context.";
  }

  // ── Step 8: Retry / failure context ──────────────────────────────────────
  let retryBlock             = "";
  let verificationSuggestion = "";
  try {
    retryBlock = getFailureContext(memory);
    if (isCodeModifyingTask(prompt)) {
      const cmd = inferVerificationCommand(cwd);
      if (cmd && !memory.last_verification_command) {
        verificationSuggestion = formatVerificationSuggestion(cmd);
      }
    }
  } catch {
    // Non-fatal
  }

  // ── Step 9: Estimate savings ─────────────────────────────────────────────
  let updatedSavings = memory.savings;
  let savingsLine    = "";
  try {
    updatedSavings = updateSavings(memory.savings, {
      originalChars,
      optimizedChars,
      messagesCompressed,
      cacheHits,
    });
    savingsLine = formatSavingsBlock(updatedSavings);
  } catch {
    // Non-fatal — carry forward existing savings
  }

  // ── Telemetry (non-fatal, side-effect by design) ─────────────────────────
  // Telemetry is the one deliberate side effect inside runPipeline.
  // It writes to .claude/logs/ so observability survives process restarts.
  try {
    recordTurn({ taskType, originalChars, optimizedChars, cacheHits, relevantFiles, updatedSavings });
  } catch {}

  return {
    // Prompt optimization
    optimizedTask,
    originalChars,
    optimizedChars,
    isMultiStep,

    // Classification
    taskType,

    // Context blocks (raw content, no section headers)
    contextBlock,
    messagesCompressed,

    // File cache
    relevantFiles,
    fileSource,
    fileCacheBlock,

    // Output policy
    outputPolicyBlock,

    // Retry / verification
    retryBlock,
    verificationSuggestion,

    // Registry + savings (for memory persistence by the adapter)
    updatedRegistry,
    cacheHits,
    updatedSavings,
    savingsLine,
  };
}

module.exports = { runPipeline };
