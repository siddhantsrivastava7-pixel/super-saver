/**
 * .claude/utils/outputWaste.js
 *
 * Output Waste Analyzer
 *
 * Analyzes the most recent assistant response from the transcript and estimates
 * how many tokens were redundant — wasted on patterns that add no value.
 *
 * Why this matters:
 *   Super Saver already aggressively optimizes what goes IN (prompt, context,
 *   history). Output is the other half of the token budget. Common leaks:
 *
 *   - preamble            "Let me...", "Sure!", "I'll...", "Great question"
 *   - repeated_context    Response's opening restates what the prompt already said
 *   - unnecessary_prose   Paragraphs of setup text before a code block (code tasks)
 *   - avoidable_explanation  "As I mentioned", "As we discussed", "Note that"
 *   - verbose_structure   Excess markdown headings, horizontal rules, summary sections
 *
 * Detection method:
 *   Pure text heuristics — no ML, no API calls.
 *   All estimates are conservative to avoid false positives.
 *
 * Returns:
 *   {
 *     output_tokens_total:     number  — estimated total tokens in last response
 *     output_tokens_redundant: number  — estimated redundant tokens
 *     redundancy_pct:          number  — redundant / total × 100
 *     top_reason:              string  — highest-waste category ("none" if clean)
 *     has_waste:               boolean — true when redundancy >= WASTE_THRESHOLD
 *     categories: {
 *       preamble:              number,
 *       repeated_context:      number,
 *       unnecessary_prose:     number,
 *       avoidable_explanation: number,
 *       verbose_structure:     number,
 *     }
 *   }
 *
 * INVARIANT: analyzeOutputWaste() is non-fatal. Any exception returns EMPTY_RESULT.
 * This module has no I/O beyond calling parseTranscript() which handles its own errors.
 */

"use strict";

const path = require("path");

const { parseTranscript } = require(path.join(__dirname, "compressor.js"));

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum redundant tokens before we consider the response "wasteful" enough
// to inject feedback into the next turn's context.
const WASTE_THRESHOLD = 20;

// Minimum response length before analysis is meaningful (very short responses
// are likely clean single-line answers — skip analysis).
const MIN_RESPONSE_CHARS = 80;

// Task types where prose before a code block is classified as unnecessary
const CODE_TASK_TYPES = new Set(["code-fix", "implementation", "refactor", "test"]);

// ─── Waste Pattern Definitions ────────────────────────────────────────────────

// Preamble phrases — appear in the opening of a response, add no value.
// All lowercase for case-insensitive matching.
const PREAMBLE_PHRASES = [
  "let me ",
  "i'll ",
  "i will ",
  "i'm going to ",
  "i am going to ",
  "sure! ",
  "sure, ",
  "of course!",
  "of course,",
  "certainly!",
  "certainly,",
  "great question",
  "good question",
  "happy to help",
  "i'd be happy",
  "i can help",
  "i understand that",
  "thanks for",
  "absolutely!",
  "absolutely,",
];

// Avoidable self-referential explanation patterns.
// These add words without adding information.
const AVOIDABLE_PATTERNS = [
  /as i (mentioned|noted|said|explained|described)/gi,
  /as (we|you) discussed/gi,
  /as described (above|before|earlier|previously)/gi,
  /as (noted|mentioned) (above|before|previously)/gi,
  /as you (can see|know|noted|recall)/gi,
  /note that this (approach|method|solution|code|implementation)/gi,
  /this (approach|solution|method|code) works because/gi,
  /to summarize what (i|we) (did|discussed|covered)/gi,
  /in summary[,:]? (i|we|the)/gi,
];

// ─── Detectors ────────────────────────────────────────────────────────────────

/**
 * Detect preamble waste in the response opening.
 * Looks for softening/intro phrases in the first 200 chars.
 * Returns estimated redundant tokens.
 *
 * @param {string} response
 * @returns {number} estimated redundant tokens
 */
function detectPreamble(response) {
  const opening = response.slice(0, 220).toLowerCase();
  for (const phrase of PREAMBLE_PHRASES) {
    if (opening.includes(phrase)) {
      // Estimate preamble = first sentence (or up to 200 chars)
      const sentenceEnd = response.search(/[.!?\n]/);
      const preambleChars = sentenceEnd > 0 ? Math.min(sentenceEnd + 1, 200) : 120;
      return Math.ceil(preambleChars / 4);
    }
  }
  return 0;
}

/**
 * Detect repeated context: response's opening restates what the user already said.
 * Computes word overlap between the user's last prompt and the response's first third.
 * High overlap = Claude is echoing the problem statement back.
 *
 * @param {string} response
 * @param {string} lastUserPrompt
 * @returns {number} estimated redundant tokens
 */
function detectRepeatedContext(response, lastUserPrompt) {
  if (!lastUserPrompt || lastUserPrompt.length < 20) return 0;

  const promptWords = new Set(
    (lastUserPrompt.toLowerCase().match(/\b\w{4,}\b/g)) ?? []
  );
  if (promptWords.size < 3) return 0;

  // Analyze the first third of the response
  const firstThird = response.slice(0, Math.ceil(response.length / 3));
  const responseWords = (firstThird.toLowerCase().match(/\b\w{4,}\b/g)) ?? [];
  if (responseWords.length === 0) return 0;

  let repeated = 0;
  for (const word of responseWords) {
    if (promptWords.has(word)) repeated++;
  }

  const overlapRatio = repeated / responseWords.length;

  // Only flag when overlap is substantial (>45% of response-opening words came from prompt)
  if (overlapRatio > 0.45) {
    // Conservative estimate: overlap fraction × first-third chars, halved
    const wastefulChars = Math.ceil(firstThird.length * overlapRatio * 0.5);
    return Math.ceil(wastefulChars / 4);
  }
  return 0;
}

/**
 * Detect unnecessary prose before code blocks in code-producing tasks.
 * For bug-fix, implementation, refactor, and test tasks: anything more than
 * one short sentence (≤ 60 chars) before the first code block is overhead.
 *
 * @param {string} response
 * @param {string} taskType
 * @returns {number} estimated redundant tokens
 */
function detectUnnecessaryProse(response, taskType) {
  if (!CODE_TASK_TYPES.has(taskType)) return 0;

  const codeBlockIdx = response.indexOf("```");
  if (codeBlockIdx <= 0) return 0;  // no code block, or code starts immediately

  const preCode = response.slice(0, codeBlockIdx).trim();
  // Allow up to 80 chars of context (e.g. "Here's the fix:" or a brief note)
  if (preCode.length <= 80) return 0;

  const wastefulChars = preCode.length - 60;  // subtract 60-char "grace" period
  return Math.ceil(wastefulChars / 4);
}

/**
 * Detect avoidable self-referential explanations.
 * Phrases like "As I mentioned", "As you can see", "Note that this approach..."
 * add verbosity without adding information.
 *
 * @param {string} response
 * @returns {number} estimated redundant tokens
 */
function detectAvoidableExplanation(response) {
  let matchCount = 0;
  for (const pattern of AVOIDABLE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = response.match(pattern) ?? [];
    matchCount += matches.length;
  }
  // Conservative: each match ≈ 20 tokens for the phrase + surrounding sentence fragment
  return matchCount * 20;
}

/**
 * Detect verbose structural overhead: excess markdown headings and separators.
 * A response with 3+ heading lines or 2+ horizontal rules likely has more
 * structural boilerplate than the content warrants.
 *
 * @param {string} response
 * @returns {number} estimated redundant tokens
 */
function detectVerboseStructure(response) {
  const headingLines = (response.match(/^#{1,3} .+/gm) ?? []).length;
  const hrLines      = (response.match(/^-{3,}$/gm) ?? []).length;
  const boldSections = (response.match(/^\*\*[^*]+\*\*$/gm) ?? []).length;

  // Allow 2 headings and 1 HR before penalizing; each excess = ~3 tokens
  const excess =
    Math.max(0, headingLines - 2) * 3 +
    Math.max(0, hrLines - 1)      * 3 +
    Math.max(0, boldSections - 2) * 2;

  return excess;
}

// ─── Main Analyzer ────────────────────────────────────────────────────────────

const EMPTY_RESULT = {
  output_tokens_total:     0,
  output_tokens_redundant: 0,
  redundancy_pct:          0,
  top_reason:              "none",
  has_waste:               false,
  categories: {
    preamble:              0,
    repeated_context:      0,
    unnecessary_prose:     0,
    avoidable_explanation: 0,
    verbose_structure:     0,
  },
};

/**
 * Analyze the last assistant response from the transcript for output waste.
 *
 * Non-fatal: returns EMPTY_RESULT on any error or when no response is available.
 *
 * @param {string} transcriptPath - path to the JSONL transcript file
 * @param {string} lastUserPrompt - the user's last prompt (current turn or prior)
 * @param {string} taskType       - classified task type (from outputPolicy)
 * @returns {WasteResult}
 */
function analyzeOutputWaste(transcriptPath, lastUserPrompt, taskType) {
  try {
    // Parse the transcript and extract the last assistant message
    const messages = parseTranscript(transcriptPath);
    if (messages.length === 0) return EMPTY_RESULT;

    // Find the last assistant message (the most recent response to analyze)
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    if (assistantMessages.length === 0) return EMPTY_RESULT;

    const lastResponse = assistantMessages[assistantMessages.length - 1].content;
    if (!lastResponse || lastResponse.length < MIN_RESPONSE_CHARS) return EMPTY_RESULT;

    // Also find the last USER message before that response (for repeated context check).
    // We use lastUserPrompt as the primary signal since it's already available.
    const promptForComparison = lastUserPrompt || "";

    // Run all detectors
    const categories = {
      preamble:              detectPreamble(lastResponse),
      repeated_context:      detectRepeatedContext(lastResponse, promptForComparison),
      unnecessary_prose:     detectUnnecessaryProse(lastResponse, taskType),
      avoidable_explanation: detectAvoidableExplanation(lastResponse),
      verbose_structure:     detectVerboseStructure(lastResponse),
    };

    const redundant = Object.values(categories).reduce((a, b) => a + b, 0);
    const total     = Math.ceil(lastResponse.length / 4);
    const pct       = total > 0 ? Math.round((redundant / total) * 100) : 0;

    // Top reason = category with highest estimated waste (for feedback message)
    const topReason = Object.entries(categories)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)[0]?.[0] ?? "none";

    return {
      output_tokens_total:     total,
      output_tokens_redundant: redundant,
      redundancy_pct:          pct,
      top_reason:              topReason,
      has_waste:               redundant >= WASTE_THRESHOLD,
      categories,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// ─── Feedback Formatter ───────────────────────────────────────────────────────

// Human-readable names for waste categories
const CATEGORY_LABELS = {
  preamble:              "preamble phrases",
  repeated_context:      "repeated context",
  unnecessary_prose:     "prose before code",
  avoidable_explanation: "avoidable explanation",
  verbose_structure:     "verbose structure",
};

/**
 * Format a short, actionable feedback block from a waste analysis result.
 * Injected into the next turn's context as [OUTPUT WASTE] to guide Claude.
 *
 * Intentionally kept to 3 lines — the feedback itself should model terse output.
 *
 * @param {WasteResult} wasteResult
 * @returns {string} — empty string if no significant waste
 */
function formatWasteFeedback(wasteResult) {
  if (!wasteResult.has_waste) return "";

  // Summarize the top waste categories found
  const activeCategories = Object.entries(wasteResult.categories)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => CATEGORY_LABELS[k] ?? k);

  const categoryList = activeCategories.join(" · ");

  // Direct, actionable — mirrors the output style we want Claude to use
  return [
    `Prior response: ~${wasteResult.output_tokens_redundant} redundant tokens (${wasteResult.redundancy_pct}% waste)`,
    `Patterns detected: ${categoryList}`,
    `This turn: skip preamble, don't restate the task. Output the solution directly.`,
  ].join("\n");
}

// ─── Follow-Up Correction Detection ─────────────────────────────────────────
//
// When the user's current prompt is a short correction or refinement,
// Claude should produce only a delta — not re-explain the full solution.

const FOLLOWUP_PATTERNS = [
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
 * Detect if the current prompt is a short follow-up correction.
 * Used to switch to "delta-only mode" in the output policy.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
function isFollowUpCorrection(prompt) {
  const trimmed = prompt.trim();
  // Follow-ups are typically short (< 120 chars)
  if (trimmed.length > 120) return false;
  const lower = trimmed.toLowerCase();
  return FOLLOWUP_PATTERNS.some((p) => p.test(lower));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  analyzeOutputWaste,
  formatWasteFeedback,
  isFollowUpCorrection,
  // Exposed for testing
  detectPreamble,
  detectRepeatedContext,
  detectUnnecessaryProse,
  detectAvoidableExplanation,
  detectVerboseStructure,
  WASTE_THRESHOLD,
  MIN_RESPONSE_CHARS,
  CATEGORY_LABELS,
};
