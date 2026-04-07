/**
 * .claude/utils/sessionStrategy.js
 *
 * Session Strategy Engine (V5)
 *
 * Solves strategic context waste: the wrong session mode for the task.
 * Lifecycle handles WHEN (idle gap, session length). Strategy handles WHAT
 * kind of session this is — and therefore what context to carry forward.
 *
 * Five session modes:
 *
 *   continuation — same intent, same files, same flow
 *                  → full compressed history, all decisions, all issues
 *
 *   fresh-task   — new intent, low similarity to previous work
 *                  → clear execution history, keep only constraints
 *                  → HIGH compression, no old decisions in rebuild
 *
 *   same-files   — different goal, same codebase area
 *                  → keep file knowledge, drop task-specific decisions
 *                  → MEDIUM compression
 *
 *   exploration  — architectural/design/planning task
 *                  → wider context (LOW compression), keep decisions
 *                  → no bug-specific issues (not relevant to design)
 *
 *   execution    — narrow focused fix or build
 *                  → tight context (HIGH compression), current task only
 *                  → relevant decisions + issues, drop exploration history
 *
 * Task similarity is a weighted composite of 5 signals:
 *   - Verb category alignment (execution vs exploration)  — weight 0.30
 *   - File overlap (shared file mentions)                 — weight 0.25
 *   - Task type same (from outputPolicy classification)   — weight 0.20
 *   - Word overlap (4+ char words, reuse memoryDecay)     — weight 0.15
 *   - Scope alignment (narrow vs broad)                   — weight 0.10
 *
 * INVARIANT: Non-fatal. Any exception returns defaultStrategy().
 * Pure function — no I/O, no side effects.
 */

"use strict";

const path = require("path");

const { wordOverlap } = require(path.join(__dirname, "memoryDecay.js"));

// ─── Verb Category Classifiers ────────────────────────────────────────────────

// Execution verbs: narrow, concrete, file-level work
const EXECUTION_VERBS = [
  "fix", "patch", "debug", "repair", "add", "update", "change",
  "implement", "write", "create", "build", "remove", "delete", "rename",
];

// Exploration verbs: broad, conceptual, system-level thinking
const EXPLORATION_VERBS = [
  "design", "architect", "plan", "explore", "evaluate", "consider",
  "review", "analyze", "refactor", "restructure", "migrate", "model",
  "understand", "explain", "assess", "compare", "outline",
];

// Phrases that signal explicit continuation of previous work
const CONTINUATION_SIGNALS = [
  "also", "and then", "additionally", "next step", "now",
  "continue", "following up", "as well", "keep going", "same thing",
  "the same", "one more", "and also",
];

// ─── Scope Classifiers ────────────────────────────────────────────────────────

// Broad scope — user is thinking about the whole system/architecture
const BROAD_SCOPE_WORDS = [
  "system", "architecture", "overall", "entire", "whole", "all",
  "everywhere", "global", "throughout", "across", "codebase",
];

// Narrow scope — user is targeting a specific piece
const NARROW_SCOPE_WORDS = [
  "function", "method", "line", "field", "variable", "this bug",
  "this error", "that file", "specific", "particular", "only",
];

// ─── File Extraction ──────────────────────────────────────────────────────────

const FILE_PATTERN = /\b[\w\-./@]+\.(js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|json|yaml|yml|md|sh|sql|css|scss)\b/gi;

/**
 * Extract file names mentioned in text as a lowercase Set.
 * @param {string} text
 * @returns {Set<string>}
 */
function extractFileMentions(text) {
  return new Set((text.match(FILE_PATTERN) ?? []).map((f) => f.toLowerCase()));
}

/**
 * Build the set of known files from memory (important_files + recent_files).
 * Handles both MemoryItem[] and string[] (legacy).
 * @param {object} memory
 * @returns {Set<string>}
 */
function getMemoryFiles(memory) {
  const important = (memory.important_files ?? []).map((f) =>
    typeof f === "string" ? f : (f.value ?? "")
  ).filter(Boolean);
  const recent = (memory.recent_files ?? []).filter((f) => typeof f === "string");
  return new Set([...important, ...recent].map((f) => f.toLowerCase()));
}

// ─── Verb + Scope Classification ─────────────────────────────────────────────

/**
 * Classify the dominant verb category in a text.
 * @param {string} text
 * @returns {"execution"|"exploration"|"neutral"}
 */
function classifyVerbCategory(text) {
  const lower = text.toLowerCase();
  const execScore  = EXECUTION_VERBS.filter((v)   => lower.includes(v)).length;
  const exploScore = EXPLORATION_VERBS.filter((v) => lower.includes(v)).length;
  if (exploScore > execScore + 1) return "exploration";
  if (execScore  > exploScore + 1) return "execution";
  return "neutral";
}

/**
 * Classify the scope breadth of a text.
 * @param {string} text
 * @returns {"broad"|"narrow"|"medium"}
 */
function classifyScope(text) {
  const lower = text.toLowerCase();
  const broadScore  = BROAD_SCOPE_WORDS.filter((w)  => lower.includes(w)).length;
  const narrowScore = NARROW_SCOPE_WORDS.filter((w) => lower.includes(w)).length;
  if (broadScore  > narrowScore + 1) return "broad";
  if (narrowScore > broadScore  + 1) return "narrow";
  return "medium";
}

/**
 * Returns true if the prompt explicitly signals continuation of prior work.
 * Checked at the prompt opening only (< 60 chars).
 * @param {string} prompt
 * @returns {boolean}
 */
function hasContinuationSignal(prompt) {
  const opening = prompt.toLowerCase().slice(0, 70);
  return CONTINUATION_SIGNALS.some((s) => opening.includes(s));
}

// ─── Task Similarity ──────────────────────────────────────────────────────────

/**
 * Compute weighted task similarity between the current prompt and the session's
 * established goal/task stored in memory.
 *
 * Returns a breakdown object for debugging and mode selection.
 *
 * @param {string} prompt       — current user prompt
 * @param {string} taskType     — classified task type (from outputPolicy)
 * @param {object} memory       — loaded session memory
 * @returns {{
 *   composite:     number,          0.0–1.0 weighted similarity
 *   verbAlignment: number,          0.0–1.0
 *   fileOverlap:   number,          0.0–1.0
 *   taskTypeSame:  boolean,
 *   wordSim:       number,          0.0–1.0
 *   scopeAlignment:number,          0.0–1.0
 *   verbCategory:  string,          current prompt's verb category
 *   scope:         string,          current prompt's scope
 * }}
 */
function computeTaskSimilarity(prompt, taskType, memory) {
  const prevGoal    = memory.goal         ?? "";
  const prevTask    = memory.current_task ?? "";
  const prevText    = `${prevGoal} ${prevTask}`.trim();

  // 1. Verb category alignment
  const currentVerb  = classifyVerbCategory(prompt);
  const prevVerb     = classifyVerbCategory(prevText);
  let verbAlignment;
  if (currentVerb === "neutral" || prevVerb === "neutral") {
    verbAlignment = 0.5;  // unknown — neither reward nor penalize
  } else {
    verbAlignment = currentVerb === prevVerb ? 1.0 : 0.1;
  }

  // 2. File overlap — shared file mentions between current prompt and memory
  const currentFiles = extractFileMentions(prompt);
  const memFiles     = getMemoryFiles(memory);
  let fileOverlap = 0;
  if (currentFiles.size > 0 && memFiles.size > 0) {
    let shared = 0;
    for (const f of currentFiles) {
      if (memFiles.has(f)) shared++;
    }
    fileOverlap = shared / Math.max(currentFiles.size, memFiles.size);
  }

  // 3. Task type same — consistent classification signals continuation
  const prevTaskType = memory.last_task_type ?? "default";
  const taskTypeSame = taskType !== "default" && taskType === prevTaskType;

  // 4. Word overlap — 4+ char word similarity with previous goal/task
  const wordSim = prevText.length > 10 ? wordOverlap(prompt, prevText) : 0;

  // 5. Scope alignment — narrow/broad consistency
  const currentScope = classifyScope(prompt);
  const prevScope    = classifyScope(prevText);
  let scopeAlignment;
  if (currentScope === "medium" || prevScope === "medium") {
    scopeAlignment = 0.5;
  } else {
    scopeAlignment = currentScope === prevScope ? 1.0 : 0.2;
  }

  // Weighted composite (weights sum to 1.0)
  const composite = Math.min(1.0,
    verbAlignment   * 0.30 +
    fileOverlap     * 0.25 +
    (taskTypeSame ? 0.20 : 0.0) +
    wordSim         * 0.15 +
    scopeAlignment  * 0.10
  );

  return {
    composite,
    verbAlignment,
    fileOverlap,
    taskTypeSame,
    wordSim,
    scopeAlignment,
    verbCategory: currentVerb,
    scope:        currentScope,
  };
}

// ─── Mode Selection ───────────────────────────────────────────────────────────

/**
 * Select the session mode from the similarity breakdown and prompt signals.
 * Priority order is intentional — continuation signals are checked first.
 *
 * @param {object} sim      — return value of computeTaskSimilarity()
 * @param {string} prompt
 * @param {number} currentTurn
 * @returns {"continuation"|"fresh-task"|"same-files"|"exploration"|"execution"}
 */
function selectMode(sim, prompt, currentTurn) {
  // Always continuation on first few turns (no meaningful history to compare)
  if (currentTurn < 3) return "continuation";

  // User explicitly signalled continuation ("also fix...", "and then...", etc.)
  if (hasContinuationSignal(prompt)) return "continuation";

  // High similarity → same thread, continue
  if (sim.composite >= 0.60) return "continuation";

  // Exploration mode: broad architectural/design thinking
  // Triggers when the verb category is exploration AND either scope is broad
  // or similarity is low (different intent entirely, but conceptual work)
  if (sim.verbCategory === "exploration") {
    if (sim.scope === "broad" || sim.composite < 0.40) return "exploration";
  }

  // Same-files: same codebase area but different goal
  // High file overlap but overall low similarity means they changed what they're doing
  if (sim.fileOverlap >= 0.40 && sim.composite < 0.50) return "same-files";

  // Execution mode: narrow, targeted work on a different topic
  if (
    sim.verbCategory === "execution" &&
    sim.scope === "narrow" &&
    sim.composite < 0.50
  ) return "execution";

  // Fresh-task: very low similarity, no file overlap, different verb category
  if (sim.composite < 0.20) return "fresh-task";

  // Default: treat as continuation (conservative — don't drop context unnecessarily)
  return "continuation";
}

// ─── Mode Configuration ───────────────────────────────────────────────────────

const MODE_CONFIG = {
  continuation: {
    compressionOverride: null,    // use lifecycle default
    includeDecisions:    true,
    includeIssues:       true,
    rebuildDepth:        "full",
    triggerReset:        false,
    note:                "",      // transparent — no note needed
  },
  "fresh-task": {
    compressionOverride: "HIGH",
    includeDecisions:    false,   // old task decisions not relevant
    includeIssues:       false,   // old bugs not relevant
    rebuildDepth:        "constraints-only",
    triggerReset:        true,    // triggers applyTaskShiftReset in memory.js
    note:                "New task detected — execution history cleared. Project constraints preserved.",
  },
  "same-files": {
    compressionOverride: "MEDIUM",
    includeDecisions:    false,   // task-specific decisions not relevant
    includeIssues:       false,
    rebuildDepth:        "files-only",
    triggerReset:        false,
    note:                "New goal in same codebase area — file context preserved.",
  },
  exploration: {
    compressionOverride: "LOW",   // wider context for architectural reasoning
    includeDecisions:    true,    // architectural decisions are very relevant
    includeIssues:       false,   // specific bugs rarely relevant to design
    rebuildDepth:        "decisions-and-constraints",
    triggerReset:        false,
    note:                "Exploration mode — broader context for architectural reasoning.",
  },
  execution: {
    compressionOverride: "HIGH",  // tight focus on current task
    includeDecisions:    true,    // keep relevant prior decisions
    includeIssues:       true,    // bugs are relevant during execution
    rebuildDepth:        "minimal",
    triggerReset:        false,
    note:                "Execution mode — focused context for targeted implementation.",
  },
};

// ─── Default Strategy ─────────────────────────────────────────────────────────

const DEFAULT_STRATEGY = {
  sessionMode:    "continuation",
  taskSimilarity: 1.0,
  similarityBreakdown: {
    verbAlignment: 1.0, fileOverlap: 0, taskTypeSame: false,
    wordSim: 0, scopeAlignment: 1.0,
  },
  verbCategory:    "neutral",
  scope:           "medium",
  contextStrategy: {
    compressionOverride: null,
    includeDecisions:    true,
    includeIssues:       true,
    rebuildDepth:        "full",
    triggerReset:        false,
  },
  isModeChange:    false,
  note:            "",
};

function defaultStrategy() {
  return { ...DEFAULT_STRATEGY };
}

// ─── Main Analyzer ────────────────────────────────────────────────────────────

/**
 * Analyze the current session strategy: determine what mode fits the task
 * and how context should be filtered this turn.
 *
 * Non-fatal: returns defaultStrategy() on any error.
 *
 * @param {string} prompt       — current user prompt
 * @param {string} taskType     — classified task type (from outputPolicy)
 * @param {object} memory       — loaded session memory
 * @param {number} currentTurn  — current turn number
 * @returns {SessionStrategy}
 */
function analyzeSessionStrategy(prompt, taskType, memory, currentTurn) {
  try {
    if (!prompt || !memory) return defaultStrategy();

    const sim     = computeTaskSimilarity(prompt, taskType, memory);
    const mode    = selectMode(sim, prompt, currentTurn);
    const config  = MODE_CONFIG[mode];

    return {
      sessionMode:    mode,
      taskSimilarity: Math.round(sim.composite * 100) / 100,
      similarityBreakdown: {
        verbAlignment:  Math.round(sim.verbAlignment  * 100) / 100,
        fileOverlap:    Math.round(sim.fileOverlap    * 100) / 100,
        taskTypeSame:   sim.taskTypeSame,
        wordSim:        Math.round(sim.wordSim        * 100) / 100,
        scopeAlignment: Math.round(sim.scopeAlignment * 100) / 100,
      },
      verbCategory:    sim.verbCategory,
      scope:           sim.scope,
      contextStrategy: {
        compressionOverride: config.compressionOverride,
        includeDecisions:    config.includeDecisions,
        includeIssues:       config.includeIssues,
        rebuildDepth:        config.rebuildDepth,
        triggerReset:        config.triggerReset,
      },
      isModeChange: mode !== "continuation",
      note:         config.note,
    };
  } catch {
    return defaultStrategy();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  analyzeSessionStrategy,
  computeTaskSimilarity,
  selectMode,
  classifyVerbCategory,
  classifyScope,
  hasContinuationSignal,
  extractFileMentions,
  getMemoryFiles,
  defaultStrategy,
  MODE_CONFIG,
};
