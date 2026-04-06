/**
 * .claude/utils/outputPolicy.js
 *
 * Task-Aware Output Shaping (V2 — Stricter Rules + Follow-Up Detection)
 *
 * Classifies the user's task type from the optimized prompt and returns
 * a specific output policy block. This replaces generic "keep it short"
 * instructions with targeted, per-task prohibitions.
 *
 * V2 additions:
 *   - Explicit "NEVER" prohibitions per task type (not just positive rules)
 *   - "follow-up" task type for correction/delta-only mode
 *   - Estimated token savings per policy (for telemetry)
 *
 * Why task-specific policies?
 *   - "Fix the login bug" needs a patch, not an essay
 *   - "Explain how auth works" needs a direct answer, not code
 *   - "Refactor the service" needs diffs, not full rewrites
 *   - "That's wrong, try again" needs only the corrected delta
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
//
// Each policy is structured as:
//   do    — what to output
//   avoid — explicit anti-patterns to suppress (NEVER rules)
//
// Both are injected. The "avoid" list is the V2 addition: explicitly naming
// the redundancy patterns turns them from implicit assumptions to hard rules.

const OUTPUT_POLICIES = {
  "code-fix": {
    label:           "patch mode",
    estimatedSaved:  50,  // tokens saved vs. unguided response
    do: [
      "Return the fix immediately — start with the corrected code.",
      "Show only changed lines with before/after markers or unified diff.",
      "Explain root cause in 1 sentence only if it's non-obvious.",
      "End with a verification command if applicable.",
    ],
    avoid: [
      "NEVER restate the problem before the fix.",
      "NEVER show unchanged surrounding code unless essential for context.",
      "NEVER begin with 'Let me', 'I'll', 'Sure!', or any preamble.",
      "NEVER add a 'Summary' section after the patch.",
    ],
  },
  "explanation": {
    label:           "direct answer mode",
    estimatedSaved:  35,
    do: [
      "Answer in the first sentence — lead with the direct answer.",
      "Keep total response to 3-6 sentences unless depth is explicitly needed.",
      "Use bullet points for lists, not dense paragraphs.",
    ],
    avoid: [
      "NEVER restate or repeat the question before answering.",
      "NEVER begin with 'Great question', 'Sure!', 'Of course', or 'Let me explain'.",
      "NEVER add a 'Summary' or 'In conclusion' paragraph.",
      "NEVER hedge with 'As I mentioned above' — say it once.",
    ],
  },
  "implementation": {
    label:           "implementation mode",
    estimatedSaved:  45,
    do: [
      "Return working code immediately — no preamble or plan narration.",
      "Provide the complete implementation, not fragments or placeholders.",
      "Add inline comments only for non-obvious logic.",
      "Note required imports or dependencies at the top of the file.",
    ],
    avoid: [
      "NEVER write a multi-paragraph introduction before the code.",
      "NEVER narrate what you're about to do — just do it.",
      "NEVER add a 'How it works' section after the code unless asked.",
      "NEVER restate file names and paths already visible in context.",
    ],
  },
  "test": {
    label:           "test mode",
    estimatedSaved:  30,
    do: [
      "Return the complete test file — no commentary wrapper.",
      "Test names must be self-documenting.",
      "Include only necessary imports and setup.",
      "Group tests by function or behavior being tested.",
    ],
    avoid: [
      "NEVER add comments explaining what each test does — names suffice.",
      "NEVER include coverage commentary.",
      "NEVER add a prose introduction before the test file.",
      "NEVER reprint the code under test.",
    ],
  },
  "refactor": {
    label:           "refactor mode",
    estimatedSaved:  40,
    do: [
      "Show the refactored result — not a plan or discussion.",
      "Use diffs over full file replacement when changes are localized.",
      "Explain restructuring decisions only if non-obvious (1 sentence each).",
      "Preserve existing behavior exactly unless bugs are evident.",
    ],
    avoid: [
      "NEVER introduce new features while refactoring.",
      "NEVER reprint unchanged functions or sections.",
      "NEVER add a 'Before / After' comparison paragraph — the diff is the comparison.",
      "NEVER begin with 'I'll refactor' or similar narration.",
    ],
  },
  "review": {
    label:           "findings-only mode",
    estimatedSaved:  40,
    do: [
      "Lead with issues found — severity-ordered: critical → major → minor.",
      "Format each finding as: SEVERITY | location | concrete fix.",
      "Suggest specific, actionable fixes (not vague recommendations).",
    ],
    avoid: [
      "NEVER include a praise section or 'Overall this looks good' opener.",
      "NEVER add a 'Summary' section at the end.",
      "NEVER explain why good code is good — only flag problems.",
      "NEVER restate the code you're reviewing.",
    ],
  },
  "multi-step": {
    label:           "plan mode",
    estimatedSaved:  30,
    do: [
      "Output the numbered execution plan first.",
      "Keep each step to 1-2 sentences.",
      "Execute steps in sequence — mark dependencies explicitly.",
    ],
    avoid: [
      "NEVER add verbose preamble before the plan.",
      "NEVER ask for confirmation between steps.",
      "NEVER narrate as you execute ('Now I'm doing step 2...').",
      "NEVER summarize what you did after each step.",
    ],
  },
  "follow-up": {
    label:           "delta-only mode",
    estimatedSaved:  80,  // largest savings — avoids re-explaining the full solution
    do: [
      "Output ONLY what changed — the corrected lines, value, or section.",
      "If correcting code: show the diff or corrected function only.",
      "Maximum 2 sentences of context if the correction needs explanation.",
    ],
    avoid: [
      "NEVER re-explain the full solution that was already provided.",
      "NEVER re-list what was done correctly — only show what changed.",
      "NEVER begin with 'You're right', 'I apologize', or 'Let me fix that'.",
      "NEVER reprint unchanged parts of the previous response.",
    ],
  },
  "default": {
    label:           "efficient mode",
    estimatedSaved:  20,
    do: [
      "Keep answer concise — omit anything that doesn't directly serve the task.",
      "Return minimal output that fully solves the problem.",
    ],
    avoid: [
      "NEVER repeat context already present in the conversation.",
      "NEVER begin with preamble or filler ('Sure!', 'Of course', 'Let me...').",
      "NEVER add explanatory prose that wasn't requested.",
    ],
  },
};

// ─── Follow-Up Detection ─────────────────────────────────────────────────────

const FOLLOWUP_SIGNALS = [
  /^(that'?s?\s+)?(wrong|incorrect|not right|off|bad)/i,
  /^not (quite|right|what i|exactly)/i,
  /^(almost|close) (but|except|however)/i,
  /^(try again|redo that|fix that|do it again)/i,
  /^still (broken|failing|wrong|not working|the same)/i,
  /^you (missed|forgot|skipped|didn't)/i,
  /^(nope|no[,.]?\s+that)/i,
  /^(the|your) (output|response|answer|code|result) (is|was) (wrong|incorrect|off)/i,
];

/**
 * Detect if the prompt is a short correction — user is asking for a delta fix.
 * Returns true when the prompt is ≤120 chars AND matches a correction pattern.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
function isFollowUpCorrection(prompt) {
  const trimmed = prompt.trim();
  if (trimmed.length > 120) return false;
  return FOLLOWUP_SIGNALS.some((p) => p.test(trimmed));
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify the task type from the prompt.
 * Follow-up detection takes priority over keyword scoring.
 *
 * @param {string}  prompt      - The optimized prompt text
 * @param {boolean} isMultiStep - True if optimizer detected multiple steps
 * @returns {string} Task type key
 */
function classifyTaskType(prompt, isMultiStep = false) {
  // Follow-up correction check: highest priority
  if (isFollowUpCorrection(prompt)) return "follow-up";

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
 * The block is structured as:
 *   [LABEL]
 *   DO:
 *     - positive rules
 *   AVOID:
 *     - explicit prohibitions (NEVER rules)
 *
 * @param {string}  prompt      - Optimized prompt text
 * @param {boolean} isMultiStep - From optimizer.detectMultiStep()
 * @returns {{
 *   taskType:       string,  // Detected task type
 *   block:          string,  // Formatted policy block for injection
 *   estimatedSaved: number,  // Estimated tokens saved by this policy vs. unguided
 * }}
 */
function getOutputPolicy(prompt, isMultiStep = false) {
  const taskType = classifyTaskType(prompt, isMultiStep);
  const policy   = OUTPUT_POLICIES[taskType] ?? OUTPUT_POLICIES["default"];

  const header  = `[${policy.label.toUpperCase()}]`;
  const doRules = policy.do.map((r)    => `  - ${r}`).join("\n");
  const avoidRules = policy.avoid.map((r) => `  - ${r}`).join("\n");

  const block = `${header}\nDO:\n${doRules}\nAVOID:\n${avoidRules}`;

  return {
    taskType,
    block,
    estimatedSaved: policy.estimatedSaved ?? 20,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyTaskType,
  getOutputPolicy,
  isFollowUpCorrection,
  OUTPUT_POLICIES,
};
