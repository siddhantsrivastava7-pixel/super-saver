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
 *   2b. Lifecycle state detection
 *   2c. Smart memory extraction
 *   3.  Compress conversation history (or structured rebuild context)
 *   4.  Optimize the prompt (filler removal + structuring)
 *   5.  Filter relevant files (keyword inference or explicit mention)
 *   6.  Apply read optimization policy (registry-based dedup)
 *   7.  Classify task type + get output policy rules
 *   8.  Tool awareness policy (suppression + optimization hint)
 *   9.  Inject retry/failure context if applicable
 *   10. Estimate and accumulate token savings
 *   11. Proof engine (before vs after estimates)
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
const {
  detectLifecycleState,
  buildRebuildContext,
  buildCompactHeader,
  getCompressionWindow,
}                                              = require(path.join(UTILS, "lifecycle.js"));
const { extractSmartMemory }                   = require(path.join(UTILS, "smartMemory.js"));
const { detectTaskShift }                      = require(path.join(UTILS, "memoryDecay.js"));
const { analyzeSessionStrategy }               = require(path.join(UTILS, "sessionStrategy.js"));
const { classifyTaskType }                     = require(path.join(UTILS, "outputPolicy.js"));
const { computeSessionProof, formatProofLine } = require(path.join(UTILS, "proofEngine.js"));
const { analyzeToolBehavior }                  = require(path.join(UTILS, "toolTracker.js"));
const {
  analyzeOutputWaste,
  formatWasteFeedback,
}                                              = require(path.join(UTILS, "outputWaste.js"));

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline({ prompt, transcriptPath, cwd, memory, currentTurn }) {

  // ── Step 2a: Quick task pre-classification (for session strategy) ────────
  // Runs before lifecycle so the strategy can override compression level.
  // The official taskType is determined in step 7; this is only for strategy.
  let quickTaskType = "default";
  try {
    quickTaskType = classifyTaskType(prompt);
  } catch {}

  // ── Step 2b: Lifecycle state detection ───────────────────────────────────
  // Must run BEFORE compression so compression level and context mode are known.
  let lifecycle = {
    mode: "normal", compressionLevel: "MEDIUM",
    idleGapMs: 0, idleGapMin: "0.0",
    isIdleGap: false, isLongSession: false, estimatedSavedTokens: 0,
  };
  try {
    lifecycle = detectLifecycleState(memory, currentTurn);
  } catch {
    // Non-fatal — proceed with defaults
  }

  // ── Step 2b.5: Session strategy analysis ─────────────────────────────────
  // Determines the strategic session mode based on task intent shift — not just
  // timing (lifecycle) but what KIND of work this is vs. the previous task.
  // Can override the compression level when the task context warrants it
  // (e.g., exploration → LOW, fresh-task → HIGH, even in a short session).
  // Does NOT fire when lifecycle is in rebuild mode (rebuild takes precedence).
  let sessionStrategy = { sessionMode: "continuation", isModeChange: false, note: "",
    contextStrategy: { compressionOverride: null, includeDecisions: true, includeIssues: true,
      rebuildDepth: "full", triggerReset: false } };
  try {
    sessionStrategy = analyzeSessionStrategy(prompt, quickTaskType, memory, currentTurn);
    // Let strategy override compression level, but don't fight a lifecycle rebuild.
    if (
      sessionStrategy.contextStrategy.compressionOverride &&
      lifecycle.mode !== "rebuild"
    ) {
      lifecycle = {
        ...lifecycle,
        compressionLevel: sessionStrategy.contextStrategy.compressionOverride,
      };
    }
  } catch {
    // Non-fatal
  }

  // ── Step 2c: Smart memory extraction + task shift detection ─────────────
  // Extract structured facts from the current prompt for memory persistence.
  // Also detect if the prompt represents a significant topic shift vs. the
  // established session goal — sets taskShifted=true so applyUpdates() can
  // clear stale task-specific context before merging the new items.
  // These are returned as smartMemoryUpdate and persisted by the hook via
  // applyUpdates() — pipeline.js itself does not mutate memory.
  let smartMemoryUpdate = {
    decisions: [], constraints: [], known_issues: [], important_files: [],
    taskShifted: false,
  };
  try {
    const extracted   = extractSmartMemory(prompt, currentTurn);
    const taskShifted = detectTaskShift(memory, prompt, currentTurn);
    smartMemoryUpdate = { ...extracted, taskShifted };
  } catch {
    // Non-fatal — proceed without smart memory this turn
  }

  // ── Step 3: Compress history ─────────────────────────────────────────────
  // Mode-aware:
  //   rebuild → skip history entirely, build minimal context from memory
  //   compact → use HIGH compression + prepend compact header
  //   normal  → standard adaptive compression
  let contextBlock = "";
  let messagesCompressed = 0;
  try {
    if (lifecycle.mode === "rebuild") {
      // Replace full history with a minimal, memory-derived context block.
      // This is the core token-saving mechanism for idle gap turns.
      contextBlock = buildRebuildContext(memory, currentTurn, sessionStrategy.contextStrategy);
      // messagesCompressed = 0 (no transcript read — savings tracked via lifecycle)
    } else {
      const compression = compressHistory(transcriptPath, prompt, {
        compressionLevel: lifecycle.compressionLevel,
      });
      contextBlock       = compression.contextBlock;
      messagesCompressed = Math.max(
        0,
        compression.originalMessages - compression.compressedMessages
      );
      // For compact mode, prepend the compact mode header to signal Claude
      if (lifecycle.mode === "compact" && contextBlock) {
        contextBlock = `${buildCompactHeader()}\n\n${contextBlock}`;
      }

      // When transcript is unavailable (empty path), compressor returns 0 compressed
      // messages. Estimate based on session turn vs. compression window so that
      // history_saved_tokens accumulates even in environments with no transcript.
      if (messagesCompressed === 0 && transcriptPath === "") {
        const recentWindow = getCompressionWindow(lifecycle.compressionLevel);
        // One message compressed per turn beyond the window (conservative estimate)
        messagesCompressed = currentTurn > recentWindow + 1 ? 1 : 0;
      }
    }
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
  let outputPolicyBlock  = "";
  let taskType           = "default";
  let policyEstimatedSaved = 0;
  try {
    const policy       = getOutputPolicy(optimizedTask, isMultiStep);
    outputPolicyBlock  = policy.block;
    taskType           = policy.taskType;
    policyEstimatedSaved = policy.estimatedSaved ?? 0;
  } catch {
    outputPolicyBlock = "Keep answer concise. Do not repeat context.";
  }

  // ── Step 8: Tool awareness policy ────────────────────────────────────────
  // Replaces the simpler getToolUsagePolicy() from lifecycle.js.
  // Adds repeated-read detection on top of task-type suppression.
  let toolPolicyBlock      = "";
  let toolOptimizationHint = "";
  let toolStats            = {};
  try {
    const toolResult     = analyzeToolBehavior({
      taskType,
      readRegistry:  updatedRegistry,
      relevantFiles,
      cacheHits,
      currentTurn,
    });
    toolPolicyBlock      = toolResult.suppressionBlock;
    toolOptimizationHint = toolResult.optimizationHint;
    toolStats            = toolResult.stats;
  } catch {
    // Non-fatal
  }

  // ── Step 8.5: Output waste analysis ──────────────────────────────────────
  // Analyze the PREVIOUS turn's assistant response for redundancy patterns.
  // When waste is detected, formatWasteFeedback() produces a short 3-line block
  // that is injected into the next turn's context — telling Claude to skip
  // preamble, repeated context, and unnecessary prose this turn.
  // Non-fatal: returns empty stats/string when transcript is unavailable.
  let outputWasteStats    = {};
  let outputWasteFeedback = "";
  try {
    outputWasteStats    = analyzeOutputWaste(transcriptPath, prompt, taskType);
    outputWasteFeedback = formatWasteFeedback(outputWasteStats);
  } catch {
    // Non-fatal
  }

  // ── Step 9: Retry / failure context ──────────────────────────────────────
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

  // ── Step 10: Estimate savings ────────────────────────────────────────────
  let updatedSavings = memory.savings;
  let savingsLine    = "";
  try {
    // Measure the actual additionalContext we're injecting this turn.
    // This is the honest "tokens sent with the optimizer" denominator that was
    // previously missing — the old code only counted the tiny filler-removed prompt,
    // causing efficiency to show ~98% instead of a realistic figure.
    const additionalContextChars = [
      optimizedTask,
      contextBlock,
      fileCacheBlock,
      outputPolicyBlock,
      toolPolicyBlock,
      toolOptimizationHint,
      outputWasteFeedback,
      retryBlock,
      verificationSuggestion,
    ].filter(Boolean).reduce((sum, s) => sum + s.length, 0);

    updatedSavings = updateSavings(memory.savings, {
      originalChars,
      optimizedChars,
      messagesCompressed,
      cacheHits,
      additionalContextChars,
      taskType,
      lifecycleMode:           lifecycle.mode,
      lifecycleTokensSaved:    lifecycle.estimatedSavedTokens,
      outputPolicyEstimated:   policyEstimatedSaved,
    });
    savingsLine = formatSavingsBlock(updatedSavings);
  } catch {
    // Non-fatal — carry forward existing savings
  }

  // ── Step 11: Proof engine ─────────────────────────────────────────────────
  // Compute before/after token estimates for display and telemetry.
  let proofStats   = {};
  let proofLine    = "";
  try {
    proofStats = computeSessionProof(updatedSavings);
    proofLine  = formatProofLine(proofStats);
  } catch {
    // Non-fatal
  }

  // ── Telemetry (non-fatal, side-effect by design) ─────────────────────────
  try {
    recordTurn({
      taskType, originalChars, optimizedChars, cacheHits,
      relevantFiles, updatedSavings,
      lifecycleMode:  lifecycle.mode,
      turnStats:      updatedSavings?.turnStats,
      proofStats,
      toolStats,
      outputWasteStats,
    });
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

    // V2: Tool awareness (suppressionBlock + optimization hint)
    toolPolicyBlock,
    toolOptimizationHint,

    // Lifecycle state (for memory persistence + adapter rendering)
    lifecycleState: lifecycle,

    // Registry + savings (for memory persistence by the adapter)
    updatedRegistry,
    cacheHits,
    updatedSavings,
    savingsLine,

    // V2: Proof engine (before/after estimates)
    proofStats,
    proofLine,

    // V2: Smart memory update (for applyUpdates() in the hook)
    smartMemoryUpdate,

    // V4: Output waste analysis (prior response redundancy stats + feedback block)
    outputWasteStats,
    outputWasteFeedback,

    // V5: Session strategy (mode + context strategy + optional note)
    sessionStrategy,
  };
}

module.exports = { runPipeline };
