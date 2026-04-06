/**
 * .claude/utils/optimizer.js
 *
 * Prompt Optimization Engine
 *
 * Transforms messy, verbose user prompts into structured, minimal task
 * descriptions — without losing the user's intent.
 *
 * Pipeline:
 *   1. Filler word removal
 *   2. Phrase replacement (verbose idioms → concise equivalents)
 *   3. Instruction merging (multi-step → numbered list)
 *   4. Task structuring (imperative, action-first format)
 *   5. Constraint injection (output efficiency rules)
 *
 * Example:
 *   Input:  "hey can you maybe fix this login thing it's kinda broken"
 *   Output: "Fix login bug. Ensure correct redirect handling. Keep minimal changes."
 */

"use strict";

// ─── Filler Word Removal ──────────────────────────────────────────────────────
// These words consume tokens without carrying semantic meaning.
// Applied carefully — only when the pattern is clearly padding.

const FILLER_PATTERNS = [
  // Hedge words / softeners
  [/\bmaybe\b/gi, ""],
  [/\bkinda\b/gi, ""],
  [/\bsorta\b/gi, ""],
  [/\bbasically\b/gi, ""],
  [/\bactually\b/gi, ""],
  [/\bessentially\b/gi, ""],
  [/\bjust\b(?=\s+(a|an|the|to|for))/gi, ""], // "just a", "just to" — not "just do"
  [/\bsimply\b/gi, ""],
  [/\bpretty much\b/gi, ""],
  [/\bkind of\b/gi, ""],
  [/\bsort of\b/gi, ""],

  // Filler openers
  [/^(hey|hi|hello)[,!.]?\s*/i, ""],
  [/^(so|well|okay|ok)[,!.]?\s*/i, ""],
  [/^(um|uh|hmm)[,!.]?\s*/i, ""],

  // Polite hedges (safe to remove — intent preserved)
  [/\bplease\b/gi, ""],
  [/\bkindly\b/gi, ""],
  [/\bcould you\b/gi, ""],
  [/\bwould you mind\b/gi, ""],
  [/\bi was wondering if (you could)?\b/gi, ""],
  [/\bdo you think you could\b/gi, ""],
  [/\bif (it'?s?\s+)?possible[,]?\s*/gi, ""],
  [/\bif you don'?t mind[,]?\s*/gi, ""],

  // Vague qualifiers
  [/\ba (little|bit|tiny bit)\b/gi, ""],
  [/\bslightly\b/gi, ""],
  [/\bsomewhat\b/gi, ""],
];

// ─── Phrase Replacements ──────────────────────────────────────────────────────
// Swap verbose phrases for shorter semantic equivalents.

const REPLACEMENTS = [
  // Classic wordiness
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bmake use of\b/gi, "use"],
  [/\bis able to\b/gi, "can"],
  [/\bwith the exception of\b/gi, "except"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bat the present time\b/gi, "currently"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],

  // Code-specific verbose phrases
  [/\bthe (thing|stuff|code|function|file)\s+that\b/gi, "the $1"],
  [/\bit'?s?\s+(kinda|kind of|sorta|sort of|pretty much)?\s+broken/gi, "is broken"],
  [/\bnot (working|functioning) (correctly|properly|right)\b/gi, "broken"],
  [/\bdoesn'?t (work|function) (correctly|properly|as expected)\b/gi, "is broken"],
  [/\bthe way (it|this) (works|is working|was working)\b/gi, "its behavior"],
  [/\b(there'?s?\s+a|there is a)\s+(bug|issue|problem|error)\s+with\b/gi, "fix"],
  [/\bi want (you )?to\b/gi, ""],
  [/\bi need (you )?to\b/gi, ""],
  [/\bcan you\b/gi, ""],
  [/\bwould you\b/gi, ""],
];

// ─── Instruction Merger ───────────────────────────────────────────────────────

/**
 * Detects multi-step instructions scattered in a paragraph
 * and restructures them as an explicit numbered list.
 *
 * Triggers when 3+ action verbs appear in a prompt.
 */
const ACTION_VERBS = [
  "fix", "add", "remove", "delete", "update", "change", "refactor",
  "create", "write", "implement", "test", "check", "verify", "ensure",
  "rename", "move", "extract", "merge", "split", "optimize", "debug",
  "deploy", "configure", "install", "setup", "build", "run",
];

function detectMultiStep(prompt) {
  const lower = prompt.toLowerCase();
  const matches = ACTION_VERBS.filter((v) => {
    const re = new RegExp(`\\b${v}\\b`, "i");
    return re.test(lower);
  });
  return matches.length >= 3;
}

/**
 * Split a multi-step prompt into individual instructions.
 * Splits on: "and", "also", "then", "after that", sentence boundaries with action verbs.
 */
function splitIntoSteps(prompt) {
  // Split on connectives that typically join independent tasks
  const steps = prompt
    .split(/\s*(?:,\s*(?:and|also|then)|;\s*|(?<=[.!?])\s+(?=[A-Z])|\band\s+(?:also\s+)?(?=(?:fix|add|remove|delete|update|change|refactor|create|write|implement|test|check|verify|ensure|rename|move|deploy)\b))/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 8); // Filter out tiny fragments

  return steps.length > 1 ? steps : [prompt];
}

// ─── Output Constraint Injection ─────────────────────────────────────────────

const EFFICIENCY_CONSTRAINTS = `For efficiency: keep answer concise, do not repeat context, avoid unnecessary explanation, return minimal output.`;

// ─── Task Structurer ─────────────────────────────────────────────────────────

/**
 * Convert a sentence fragment into an imperative action.
 * Ensures the task starts with an action verb.
 *
 * "the login page is broken" → "Fix login page."
 * "authentication isn't working" → "Fix authentication."
 */
function toImperative(text) {
  const trimmed = text.trim().replace(/[.!?]+$/, "").trim();

  // Already starts with an action verb — just capitalize
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (ACTION_VERBS.includes(firstWord)) {
    return capitalize(trimmed) + ".";
  }

  // "there is/are a <bug|issue|problem|error> in X" → "Fix X."
  const thereIsBugPattern = /^there\s+(?:is|are)\s+a\s+(?:bug|issue|problem|error)\s+(?:in|with)\s+(.+)/i;
  const tib = trimmed.match(thereIsBugPattern);
  if (tib) {
    return `Fix ${tib[1]}.`;
  }

  // "there is/are a <issue>" (any subject) → "Fix: <issue description>"
  const thereIsPattern = /^there\s+(?:is|are)\s+(.+)/i;
  const ti = trimmed.match(thereIsPattern);
  if (ti) {
    return `Fix: ${ti[1]}.`;
  }

  // Starts with "the X is/isn't Y" → infer Fix/Update
  // Exclude "there" as subject (handled above) to avoid "Update there: ..."
  const brokenPattern = /^(?!there\b)(the\s+)?(.+?)\s+(is|are|isn'?t|aren'?t|doesn'?t|don'?t)\s+(.+)/i;
  const m = trimmed.match(brokenPattern);
  if (m) {
    const subject = m[2];
    const issue = m[4];
    if (/broken|working|function/i.test(issue)) {
      return `Fix ${subject}.`;
    }
    return `Update ${subject}: ${issue}.`;
  }

  // Fallback: prepend nothing, just capitalize
  return capitalize(trimmed) + ".";
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Main Optimizer ───────────────────────────────────────────────────────────

/**
 * Optimize a user prompt for minimal token usage.
 *
 * @param {string} rawPrompt - The original user prompt
 * @returns {{
 *   optimizedTask: string,   // The cleaned, structured task description
 *   constraints: string,     // Efficiency constraints to append
 *   originalChars: number,
 *   optimizedChars: number
 * }}
 */
function optimizePrompt(rawPrompt) {
  const originalChars = rawPrompt.length;
  let text = rawPrompt;

  // Pass 1: Phrase replacements (before filler removal to avoid partial matches)
  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  // Pass 2: Filler word removal
  for (const [pattern, replacement] of FILLER_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  // Pass 3: Normalize whitespace
  text = text
    .replace(/[ \t]+/g, " ")       // collapse spaces
    .replace(/\n{3,}/g, "\n\n")    // collapse blank lines
    .replace(/\s+([.!?,;:])/g, "$1") // remove space before punctuation
    .trim();

  // Pass 4: Structure multi-step tasks into numbered lists
  let optimizedTask;
  if (detectMultiStep(text)) {
    const steps = splitIntoSteps(text);
    if (steps.length > 1) {
      const numberedSteps = steps
        .map((step, i) => `${i + 1}. ${toImperative(step)}`)
        .join("\n");
      optimizedTask = numberedSteps;
    } else {
      optimizedTask = toImperative(text);
    }
  } else {
    // Single task: convert to clean imperative
    optimizedTask = toImperative(text);
  }

  return {
    optimizedTask,
    constraints: EFFICIENCY_CONSTRAINTS,
    originalChars,
    optimizedChars: optimizedTask.length,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { optimizePrompt, detectMultiStep, EFFICIENCY_CONSTRAINTS };
