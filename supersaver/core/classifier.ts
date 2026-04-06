/**
 * core/classifier.ts
 *
 * Classifies user prompts into task types using keyword scoring + heuristics.
 * No ML — pure string matching with weighted signals.
 *
 * Algorithm:
 *   1. Score each task type via keyword map (keyword → weight)
 *   2. Pick the highest-scoring type (ties: first in insertion order wins)
 *   3. Derive ambiguity, context_width, reasoning_depth from secondary signals
 *   4. Extract referenced filenames via regex
 */

import type { ClassificationResult, TaskType, Ambiguity, ContextWidth, ReasoningDepth } from "./types";

// ─── Keyword Scoring Map ──────────────────────────────────────────────────────
// Each task type maps to { keyword → score }.
// Higher score = stronger signal. Order matters: more specific types first.
// Multi-word phrases are matched as substrings on the lowercased prompt.

const KEYWORD_MAP: Record<TaskType, Record<string, number>> = {
  debug_complex: {
    "intermittent": 4,
    "race condition": 5,
    "memory leak": 5,
    "deadlock": 5,
    "investigate": 3,
    "not always": 3,
    "sometimes fails": 4,
    "flaky": 4,
    "performance issue": 4,
    "profile": 3,
    "concurrency": 4,
    "thread": 3,
  },
  architecture: {
    "architecture": 5,
    "system design": 5,
    "data model": 4,
    "schema design": 4,
    "design pattern": 4,
    "best approach": 3,
    "how should i structure": 4,
    "scalab": 3,  // matches "scalable", "scalability"
    "microservice": 4,
    "monolith": 3,
    "database design": 4,
  },
  refactor: {
    "refactor": 4,
    "clean up": 3,
    "restructure": 3,
    "reorganize": 3,
    "improve readability": 3,
    "simplify": 2,
    "extract": 2,
    "decouple": 3,
    "split into": 2,
    "move to": 2,
    "too long": 2,
    "messy": 2,
  },
  explanation: {
    "explain": 4,
    "how does": 3,
    "what is": 3,
    "why does": 3,
    "describe": 3,
    "walk me through": 4,
    "understand": 3,
    "what does": 3,
    "how do": 2,
    "what are": 2,
    "overview of": 3,
  },
  bug_fix: {
    "bug": 3,
    "not working": 3,
    "broken": 3,
    "crash": 3,
    "error": 2,
    "exception": 2,
    "fix": 2,
    "doesn't work": 3,
    "failing": 2,
    "incorrect": 2,
    "wrong output": 3,
    "regression": 3,
  },
  test_write: {
    "test": 3,
    "spec": 3,
    "unit test": 4,
    "write tests": 4,
    "add tests": 4,
    "coverage": 2,
    "jest": 2,
    "vitest": 2,
    "mocha": 2,
    "test case": 3,
    "mock": 2,
    "stub": 2,
  },
  tiny_edit: {
    "rename": 3,
    "typo": 3,
    "change the": 2,
    "update the": 2,
    "fix the spelling": 3,
    "swap": 2,
    "replace": 2,
    "add a comment": 3,
    "remove the": 2,
    "delete the": 2,
    "one line": 3,
    "small change": 3,
  },
};

// ─── File Detection ───────────────────────────────────────────────────────────
// Matches common source file patterns mentioned in the prompt.
const FILE_PATTERN =
  /\b[\w/-]+\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|h|json|yaml|yml|md|sh|env|toml|prisma|sql)\b/gi;

// ─── Task → Reasoning Depth ───────────────────────────────────────────────────
const REASONING_DEPTH_MAP: Record<TaskType, ReasoningDepth> = {
  debug_complex: "deep",
  architecture: "deep",
  refactor: "deep",
  explanation: "moderate",
  bug_fix: "moderate",
  test_write: "shallow",
  tiny_edit: "shallow",
};

// ─── Classifier ───────────────────────────────────────────────────────────────

export function classifyTask(prompt: string): ClassificationResult {
  const lower = prompt.toLowerCase();

  // Score every task type
  const scores: Record<string, number> = {};
  for (const taskType of Object.keys(KEYWORD_MAP) as TaskType[]) {
    scores[taskType] = 0;
    for (const [keyword, weight] of Object.entries(KEYWORD_MAP[taskType])) {
      if (lower.includes(keyword)) {
        scores[taskType] += weight;
      }
    }
  }

  // Pick highest-scoring type; ties resolved by insertion order (most specific first)
  let task_type: TaskType = "explanation"; // default fallback
  let maxScore = 0;
  for (const [t, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      task_type = t as TaskType;
    }
  }

  // Detect referenced filenames (deduplicated, original case preserved)
  const detected_files = [...new Set(prompt.match(FILE_PATTERN) ?? [])];

  // Ambiguity: short prompts and question-heavy prompts are more ambiguous
  const questionMarkCount = (prompt.match(/\?/g) ?? []).length;
  const ambiguity: Ambiguity =
    prompt.length < 40 || questionMarkCount > 2
      ? "high"
      : prompt.length < 120
      ? "medium"
      : "low";

  // Context width: how much of the codebase needs to be seen
  const context_width: ContextWidth =
    detected_files.length === 0
      ? "broad"
      : detected_files.length <= 2
      ? "narrow"
      : "medium";

  const reasoning_depth: ReasoningDepth = REASONING_DEPTH_MAP[task_type];

  return {
    task_type,
    ambiguity,
    context_width,
    reasoning_depth,
    detected_files,
    prompt_length: prompt.length,
  };
}
