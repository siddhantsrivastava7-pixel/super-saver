#!/usr/bin/env node
/**
 * apps/cli.ts
 *
 * SUPER SAVER — CLI entry point and pipeline orchestrator.
 *
 * Command: supersaver run "<task>"
 *
 * Full pipeline:
 *   1.  Load session memory
 *   2.  Classify the task
 *   3.  Route to model
 *   4.  Compress memory → compact context block
 *   5.  Optimize the prompt
 *   6.  Call provider (with retry + escalation)
 *   7.  Extract verification commands from model output
 *   8.  Run verification
 *   9.  Calculate token savings
 *   10. Update and persist session memory
 *   11. Log the run to runs.tsv
 *   12. Print formatted result
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { loadMemory, updateMemory, compressMemory } from "../core/memory";
import { classifyTask } from "../core/classifier";
import { routeModel } from "../core/router";
import { optimizePrompt } from "../core/optimizer";
import { callClaude } from "../providers/claude";
import { callCodex } from "../providers/codex";
import { verifyResult } from "../core/verifier";
import { calculateSavings } from "../core/cost";
import { logRun } from "../core/runLogger";

import type {
  PipelineResult,
  ProviderRequest,
  ProviderResponse,
  ModelName,
  FailureRecord,
} from "../core/types";

// ─── Provider Dispatch ────────────────────────────────────────────────────────

function getProvider(
  model: ModelName
): (req: ProviderRequest) => Promise<ProviderResponse> {
  return model === "claude" ? callClaude : callCodex;
}

// ─── Verification Command Extraction ─────────────────────────────────────────

/**
 * Parse lines prefixed with $ or "RUN:" from model output.
 * Both claudePlanner and codexExecutor system prompts instruct models
 * to emit verification commands in this format, making extraction reliable.
 */
function extractVerificationCommands(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("$") || line.startsWith("RUN:"))
    .map((line) =>
      line.replace(/^\$\s*/, "").replace(/^RUN:\s*/, "").trim()
    )
    .filter(Boolean);
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(userPrompt: string): Promise<PipelineResult> {
  // Step 1: Load session memory and increment iteration counter
  const memory = await loadMemory();
  memory.iteration = (memory.iteration ?? 0) + 1;

  // Step 2: Classify the task
  const classification = classifyTask(userPrompt);

  // Step 3: Route to the appropriate model
  const routing = routeModel(classification);

  // Step 4: Compress memory into a compact context block
  // This replaces full chat history — the core token savings mechanism
  const memoryContext = compressMemory(memory);

  // Step 5: Optimize the prompt (filler removal + model-specific structuring)
  const optimization = optimizePrompt(
    userPrompt,
    routing.model,
    memoryContext
  );

  // Step 6: Call the provider with retry + escalation logic
  //
  //   Attempt 1: primary model
  //   Attempt 2: retry primary model (transient errors, rate limits)
  //   Attempt 3: escalate to fallback model
  let response: ProviderResponse;
  let escalated = false;

  const primaryProvider = getProvider(routing.model);
  const request: ProviderRequest = {
    prompt: optimization.optimizedPrompt,
    systemPrompt: optimization.systemPrompt,
  };

  try {
    response = await primaryProvider(request);
  } catch (_firstError) {
    try {
      // Retry once — catches transient failures, rate limit blips
      response = await primaryProvider(request);
    } catch (_secondError) {
      // Both attempts failed → escalate to fallback model
      escalated = true;
      const fallbackProvider = getProvider(routing.fallback_model);
      response = await fallbackProvider(request);
    }
  }

  // Step 7: Extract verification shell commands from model output
  const verificationCommands = extractVerificationCommands(response.output);

  // Step 8: Run verification
  const verification = verifyResult(verificationCommands);

  // Step 9: Calculate token savings
  const savings = calculateSavings(
    optimization.originalTokens,
    optimization.optimizedTokens,
    routing.model
  );

  // Step 10: Update and persist session memory
  const newFailures: FailureRecord[] = verification.success
    ? []
    : [
        {
          command: verification.failedCommand ?? "unknown",
          error:
            verification.logs[verification.logs.length - 1] ?? "",
          timestamp: new Date().toISOString(),
        },
      ];

  await updateMemory({
    current_task: userPrompt,
    last_plan: response.output,
    touched_files: classification.detected_files,
    known_failures: newFailures,
    iteration: memory.iteration,
    last_updated: new Date().toISOString(),
  });

  // Step 11: Log the run
  logRun({
    timestamp: new Date().toISOString(),
    iteration: memory.iteration,
    model: escalated ? routing.fallback_model : routing.model,
    mode: routing.mode,
    task_type: classification.task_type,
    result: escalated
      ? "escalated"
      : verification.success
      ? "success"
      : "failure",
    originalTokens: optimization.originalTokens,
    optimizedTokens: optimization.optimizedTokens,
    savingsPercent: savings.savingsPercent,
    verificationPassed: verification.success,
    notes: routing.rationale,
  });

  const modelLabel = `${escalated ? routing.fallback_model : routing.model} (${routing.mode})${escalated ? " [escalated]" : ""}`;

  return {
    model: modelLabel,
    mode: routing.mode,
    originalTokens: optimization.originalTokens,
    optimizedTokens: optimization.optimizedTokens,
    savingsPercent: savings.savingsPercent,
    output: response.output,
    verificationResult: verification,
    escalated,
  };
}

// ─── Output Formatter ─────────────────────────────────────────────────────────

function printResult(result: PipelineResult): void {
  const verLabel = result.verificationResult.success ? "PASS" : "FAIL";
  const verLogs = result.verificationResult.logs.join("\n");
  const savedPct = result.savingsPercent.toFixed(1);

  const separator = "─".repeat(50);

  console.log(`
${separator}
Model Used:       ${result.model}

Original Tokens:  ${result.originalTokens}
Optimized Tokens: ${result.optimizedTokens}
Savings:          ${savedPct}%

Result:
${result.output}

Verification:     ${verLabel}
${verLogs}
${separator}`);
}

// ─── CLI Definition ───────────────────────────────────────────────────────────

yargs(hideBin(process.argv))
  .scriptName("supersaver")
  .usage("$0 <command> [options]")
  .command(
    "run <task>",
    "Run a task through the SUPER SAVER optimization pipeline",
    (y) =>
      y.positional("task", {
        describe: "The task prompt to process",
        type: "string",
        demandOption: true,
      }),
    async (argv) => {
      const task = argv.task as string;

      if (!task.trim()) {
        console.error("Error: task cannot be empty");
        process.exit(1);
      }

      try {
        const result = await runPipeline(task);
        printResult(result);
        process.exit(result.verificationResult.success ? 0 : 1);
      } catch (err) {
        console.error("Pipeline error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    }
  )
  .example(
    '$0 run "fix authentication bug in login.ts"',
    "Route a bug fix task to the optimal model"
  )
  .example(
    '$0 run "design the database schema for a multi-tenant SaaS"',
    "Route an architecture task to Claude"
  )
  .demandCommand(1, "Provide a command. Use --help to see available commands.")
  .strict()
  .help()
  .parse();
