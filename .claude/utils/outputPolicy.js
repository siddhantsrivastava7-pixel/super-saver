/**
 * .claude/utils/outputPolicy.js
 *
 * Task-Aware Output Shaping
 *
 * Classifies the user's task type from the optimized prompt and returns
 * a specific output policy block. This replaces the generic
 * "keep answer concise" constraint with targeted instructions.
 *
 * Why task-specific policies?
 *   - "Fix the login bug" needs a patch, not an essay
 *   - "Explain how auth works" needs a direct answer, not code
 *   - "Refactor the service" needs diffs, not full rewrites
 *   Different outputs = different instructions = fewer wasted tokens
 *
 * Classification is deterministic keyword scoring (no ML, no API calls).
 * Falls back to "default" policy if no strong signal detected.
 */

"use strict";

// ─── Task Type Definitions ────────────────────────────────────────────────────

const TASK_TYPES = {
  "code-fix": {
    keywords: [
      "fix", "bug", "broken", "error", "crash", "not working", "failing",
      "exception", "regression", "incorrect", "wrong output", "doesn't work",
      "infinite loop", "null pointer", "undefined", "type error",
    ],
    weight: 3,
  },
  "explanation": {
    keywords: [
      "explain", "how does", "what is", "why does", "describe",
      "walk me through", "what does", "how do", "overview of",
      "understand", "tell me about", "what are", "how works",
    ],
    weight: 3,
  },
  "implementation": {
    keywords: [
      "create", "build", "implement", "add", "write", "develop",
      "make", "generate", "set up", "scaffold", "bootstrap", "new",
    ],
    weight: 2,
  },
  "test": {
    keywords: [
      "test", "spec", "coverage", "unit test", "integration test",
      "jest", "vitest", "mocha", "pytest", "write tests", "add tests",
    ],
    weight: 2,
  },
  "refactor": {
    keywords: [
      "refactor", "clean up", "restructure", "reorganize", "simplify",
      "improve readability", "extract", "decouple", "split", "modularize",
    ],
    weight: 2,
  },
  "review": {
    keywords: [
      "review", "check", "audit", "look at", "analyze", "assess",
      "evaluate", "what's wrong", "is this correct", "any issues",
    ],
    weight: 2,
  },
};

// ─── Output Policies ──────────────────────────────────────────────────────────

const OUTPUT_POLICIES = {
  "code-fix": {
    label: "patch mode",
    rules: [
      "Return the fix directly — no preamble or restatement of the problem.",
      "Show only changed lines with clear before/after markers or unified diff.",
      "Explain only if the root cause is non-obvious (1 sentence max).",
      "End with a verification command (e.g. `npm test`) if applicable.",
      "Do not reprint unchanged surrounding code unless necessary for context.",
    ],
  },
  "explanation": {
    label: "direct answer mode",
    rules: [
      "Answer the question directly in the first sentence.",
      "Keep total response to 3-6 sentences unless depth is explicitly needed.",
      "Do not repeat or restate the question.",
      "Use bullet points for lists, not dense paragraphs.",
      "Skip 'great question' or introductory filler.",
    ],
  },
  "implementation": {
    label: "implementation mode",
    rules: [
      "Return working code immediately — no lengthy introduction.",
      "Provide the complete implementation, not fragments or placeholders.",
      "Add inline comments only for non-obvious logic.",
      "Skip step-by-step narration — just deliver the result.",
      "Note any required imports or dependencies at the top.",
    ],
  },
  "test": {
    label: "test mode",
    rules: [
      "Return the complete test file content — no commentary around it.",
      "Test names must be self-documenting; skip inline comments explaining what tests do.",
      "Include only necessary imports and setup.",
      "Group tests logically by function/behavior being tested.",
      "Skip coverage commentary — just write the tests.",
    ],
  },
  "refactor": {
    label: "refactor mode",
    rules: [
      "Show the refactored result — not a plan or discussion.",
      "Use diffs over full file replacement when changes are limited.",
      "Explain restructuring decisions only if non-obvious (1 sentence each).",
      "Preserve existing behavior exactly unless bugs are evident.",
      "Do not introduce new features while refactoring.",
    ],
  },
  "review": {
    label: "review mode",
    rules: [
      "Lead with issues found, not praise.",
      "Use a short bulleted list: issue, location, fix.",
      "Severity-order issues: critical → major → minor.",
      "Skip 'looks good' commentary on clean sections.",
      "Suggest concrete fixes, not vague recommendations.",
    ],
  },
  "multi-step": {
    label: "plan mode",
    rules: [
      "Output the execution plan first as a numbered list.",
      "Keep each step to 1-2 sentences maximum.",
      "No verbose preamble before the plan.",
      "Mark dependencies between steps explicitly.",
      "Execute each step in sequence without asking for confirmation.",
    ],
  },
  "default": {
    label: "efficient mode",
    rules: [
      "Keep answer concise — omit anything that doesn't directly serve the task.",
      "Do not repeat context already present in the conversation.",
      "Avoid unnecessary explanation, commentary, or preamble.",
      "Return minimal output that fully solves the problem.",
    ],
  },
};

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify the task type from the prompt.
 *
 * @param {string}  prompt      - The optimized prompt text
 * @param {boolean} isMultiStep - True if optimizer detected multiple steps
 * @returns {string} Task type key
 */
function classifyTaskType(prompt, isMultiStep = false) {
  if (isMultiStep) return "multi-step";

  const lower = prompt.toLowerCase();
  const scores = {};

  for (const [type, config] of Object.entries(TASK_TYPES)) {
    scores[type] = 0;
    for (const kw of config.keywords) {
      if (lower.includes(kw)) {
        scores[type] += config.weight;
      }
    }
  }

  // Find highest scoring type
  let best = "default";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }

  // Minimum threshold — if nothing scored, use default
  return bestScore >= 2 ? best : "default";
}

// ─── Main Policy Function ─────────────────────────────────────────────────────

/**
 * Get the output policy block for injection into additionalContext.
 *
 * @param {string}  prompt      - Optimized prompt text
 * @param {boolean} isMultiStep - From optimizer.detectMultiStep()
 * @returns {{
 *   taskType: string,  // Detected task type
 *   block: string,     // Formatted policy block for injection
 * }}
 */
function getOutputPolicy(prompt, isMultiStep = false) {
  const taskType = classifyTaskType(prompt, isMultiStep);
  const policy = OUTPUT_POLICIES[taskType] ?? OUTPUT_POLICIES["default"];

  const header = `[${policy.label.toUpperCase()}]`;
  const rules = policy.rules.map((r) => `  - ${r}`).join("\n");

  return {
    taskType,
    block: `${header}\n${rules}`,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { classifyTaskType, getOutputPolicy };
