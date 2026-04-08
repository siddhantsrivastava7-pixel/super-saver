/**
 * .claude/utils/modelRouter.js
 *
 * Model + Reasoning Router
 *
 * Adds intelligent model and reasoning-level selection without touching
 * any existing pipeline behavior. Operates as a pure advisory layer:
 *
 *   • Codex adapter — applies model + reasoning override to API call metadata
 *   • Claude adapter — injects a one-line [MODEL SUGGESTION] hint when appropriate
 *
 * Core principle: always choose the cheapest option that succeeds in ONE attempt.
 *
 * Features:
 *   1. Risk classification   — LOW / MEDIUM / HIGH from task signals
 *   2. Model routing         — Codex: maps risk → concrete model + reasoning level
 *   3. Claude suggestion     — Claude: advisory hint (only when confidence ≥ 0.7)
 *   4. Fallback escalation   — prior weak response → escalate one level this turn
 *   5. Weak output detection — analyzes last assistant response, flags if weak
 *
 * Hard rules:
 *   • Never route HIGH risk to the cheapest model
 *   • Confidence < 0.6 → escalate one level
 *   • last_turn_failed=true → escalate one level
 *   • Suggestions are suppressed when confidence < 0.7 (uncertain risk = no noise)
 *
 * INVARIANT: Every exported function is non-fatal.
 * Pure function — no I/O except detectWeakOutput (reads transcript).
 */

"use strict";

const path = require("path");
const { parseTranscript } = require(path.join(__dirname, "compressor.js"));

// ─── Model Tier Definitions ───────────────────────────────────────────────────

const MODELS = {
  low:    { model: "gpt-5.4-mini",   reasoning: "low"    },
  medium: { model: "gpt-5.3-codex",  reasoning: "medium" },
  high:   { model: "gpt-5.4",        reasoning: "medium" },
};

// ─── Risk Signals ─────────────────────────────────────────────────────────────

// HIGH-risk indicator keywords — broad, ambiguous, or system-level concerns
const HIGH_RISK_KEYWORDS = [
  "architecture", "design", "system", "debug", "debugging",
  "why", "issue", "issues", "unclear", "not sure", "broken",
  "migrate", "migration", "refactor", "restructure", "overhaul",
  "investigate", "trace", "root cause",
];

// LOW-risk indicator keywords — narrow, deterministic, self-contained
const LOW_RISK_KEYWORDS = [
  "rename", "format", "formatting", "summary", "summarize",
  "explain", "what is", "what does", "document", "comment",
  "list", "show me", "translate",
];

// Uncertainty phrases — user doesn't know what they want → higher risk
const UNCERTAINTY_PHRASES = [
  "maybe", "perhaps", "i think", "i'm not sure", "i am not sure",
  "not sure", "unclear", "seems like", "might be", "could be",
  "possibly", "i don't know", "i do not know", "somehow",
];

// Task types classified by inherent risk
const LOW_RISK_TASK_TYPES    = new Set(["explanation", "default"]);
const MEDIUM_RISK_TASK_TYPES = new Set(["code-fix", "test", "refactor", "review"]);
const HIGH_RISK_TASK_TYPES   = new Set(["implementation", "multi-step"]);

// Code task types — needed for weak output detection
const CODE_TASK_TYPES = new Set(["code-fix", "implementation", "refactor", "test"]);

// Weak output vague phrases — signs the model hedged without a real answer
const WEAK_OUTPUT_PHRASES = [
  "maybe ", "you could try", "one option is", "it might be",
  "could be ", "possibly ", "it seems like", "try ", "perhaps ",
  "i'm not certain", "i am not certain", "it depends",
  "not entirely sure", "unclear", "might want to",
];

// ─── Risk Classification ──────────────────────────────────────────────────────

/**
 * Classify the risk level of a task based on multiple signals.
 *
 * @param {string}   taskType — from outputPolicy.classifyTaskType()
 * @param {string}   prompt   — current user prompt
 * @param {string[]} files    — relevant files for this turn
 * @returns {{ risk: "low"|"medium"|"high", confidence: number, signals: string[] }}
 */
function classifyRisk(taskType, prompt, files) {
  try {
    const lower   = (prompt ?? "").toLowerCase();
    const fileCount = Array.isArray(files) ? files.length : 0;
    const signals   = [];

    // ── Signal 1: Task type ─────────────────────────────────────────────────
    let taskSignal = "medium";
    if (LOW_RISK_TASK_TYPES.has(taskType)) {
      taskSignal = "low";
      signals.push("task_type:low");
    } else if (HIGH_RISK_TASK_TYPES.has(taskType)) {
      taskSignal = "high";
      signals.push("task_type:high");
    } else if (MEDIUM_RISK_TASK_TYPES.has(taskType)) {
      signals.push("task_type:medium");
    }

    // ── Signal 2: High-risk keywords ────────────────────────────────────────
    const highKwHits = HIGH_RISK_KEYWORDS.filter((kw) => lower.includes(kw));
    if (highKwHits.length >= 2) {
      signals.push(`high_keywords:${highKwHits.slice(0, 3).join(",")}`);
    } else if (highKwHits.length === 1) {
      signals.push(`high_keyword:${highKwHits[0]}`);
    }

    // ── Signal 3: Low-risk keywords ─────────────────────────────────────────
    const lowKwHits = LOW_RISK_KEYWORDS.filter((kw) => lower.includes(kw));
    if (lowKwHits.length > 0) {
      signals.push(`low_keywords:${lowKwHits.slice(0, 2).join(",")}`);
    }

    // ── Signal 4: File count ────────────────────────────────────────────────
    if (fileCount >= 4) {
      signals.push("file_count:high");
    } else if (fileCount >= 2) {
      signals.push("file_count:medium");
    } else if (fileCount <= 1) {
      signals.push("file_count:low");
    }

    // ── Signal 5: Prompt length ─────────────────────────────────────────────
    const pLen = lower.length;
    if (pLen > 400) {
      signals.push("prompt_length:high");
    } else if (pLen > 200) {
      signals.push("prompt_length:medium");
    } else {
      signals.push("prompt_length:low");
    }

    // ── Signal 6: Uncertainty phrases ───────────────────────────────────────
    const uncertainHits = UNCERTAINTY_PHRASES.filter((p) => lower.includes(p));
    if (uncertainHits.length > 0) {
      signals.push(`uncertainty:${uncertainHits.slice(0, 2).join(",")}`);
    }

    // ── Score → Risk ────────────────────────────────────────────────────────
    // Each signal contributes to a score. Weighted sum → threshold bucketing.

    let score = 0;

    // Task type baseline
    if (taskSignal === "low")  score -= 1;
    if (taskSignal === "high") score += 2;

    // Keyword hits
    score += highKwHits.length * 1.5;
    score -= lowKwHits.length  * 0.8;

    // File count
    if (fileCount >= 4)  score += 2;
    else if (fileCount >= 2) score += 1;

    // Prompt length
    if (pLen > 400)  score += 1.5;
    else if (pLen > 200) score += 0.5;

    // Uncertainty
    score += uncertainHits.length * 1.2;

    // Floor/ceiling
    score = Math.max(-2, Math.min(8, score));

    let risk;
    if (score <= 0.5) {
      risk = "low";
    } else if (score <= 3.0) {
      risk = "medium";
    } else {
      risk = "high";
    }

    // ── Confidence ──────────────────────────────────────────────────────────
    // High confidence when signals point consistently in one direction.
    // Low confidence when high-risk and low-risk signals both appear.

    const conflictPenalty = (highKwHits.length > 0 && lowKwHits.length > 0) ? 0.15 : 0;
    const uncertaintyPenalty = Math.min(0.20, uncertainHits.length * 0.08);

    // More total signals → more confident classification
    const totalSignalStrength = Math.min(1, signals.length / 5);
    const baseConfidence      = 0.50 + totalSignalStrength * 0.40;
    const confidence          = Math.max(
      0.30,
      Math.min(0.95, baseConfidence - conflictPenalty - uncertaintyPenalty)
    );

    return { risk, confidence: Math.round(confidence * 100) / 100, signals };
  } catch {
    return { risk: "medium", confidence: 0.5, signals: ["error:fallback"] };
  }
}

// ─── Model Selection (Codex) ──────────────────────────────────────────────────

/**
 * Select the appropriate model and reasoning level for a Codex API call.
 *
 * Escalation rules (applied in priority order):
 *   1. HIGH risk → always HIGH model (hard rule, never cheap)
 *   2. lastTurnFailed → escalate one level (weak prior response)
 *   3. confidence < 0.6 → escalate one level (uncertain classification)
 *
 * @param {"low"|"medium"|"high"} risk
 * @param {number}                confidence — 0.0–1.0
 * @param {boolean}               lastTurnFailed — prior response was weak
 * @returns {{ model: string, reasoning: "low"|"medium"|"high", tier: string, escalated: boolean }}
 */
function selectModel(risk, confidence, lastTurnFailed = false) {
  try {
    let tier      = risk ?? "medium";
    let escalated = false;

    // Hard rule: HIGH risk never goes to cheap model
    if (tier === "high") {
      return { ...MODELS.high, tier: "high", escalated: false };
    }

    // Confidence < 0.6 → escalate (uncertain classification → safer model)
    if ((confidence ?? 0.5) < 0.6) {
      if (tier === "low") { tier = "medium"; escalated = true; }
      else if (tier === "medium") { tier = "high"; escalated = true; }
    }

    // Prior weak response → escalate (retry with stronger model)
    if (lastTurnFailed && !escalated) {
      if (tier === "low") { tier = "medium"; escalated = true; }
      else if (tier === "medium") { tier = "high"; escalated = true; }
    }

    // Cap at high (never exceed the top tier)
    if (!MODELS[tier]) tier = "high";

    return { ...MODELS[tier], tier, escalated };
  } catch {
    return { ...MODELS.medium, tier: "medium", escalated: false };
  }
}

// ─── Model Suggestion (Claude) ────────────────────────────────────────────────

/**
 * Generate a short advisory hint for Claude Code users.
 * Returns empty string when confidence is too low to be useful.
 *
 * @param {"low"|"medium"|"high"} risk
 * @param {number}                confidence — 0.0–1.0
 * @returns {string} — 1–2 lines, or "" when suppressed
 */
function generateModelSuggestion(risk, confidence) {
  try {
    // Only suggest when confident — low confidence → say nothing
    if ((confidence ?? 0) < 0.70) return "";

    if (risk === "low") {
      return "Simple task detected — you can switch to a cheaper model to save cost.";
    }
    if (risk === "high") {
      return "Complex task detected — consider switching to a stronger model for best results.";
    }
    // medium → current model is appropriate, no suggestion needed
    return "";
  } catch {
    return "";
  }
}

// ─── Weak Output Detection ────────────────────────────────────────────────────

/**
 * Analyze the most recent assistant response from the transcript.
 * Returns isWeak=true when the response shows clear signs of an incomplete
 * or hedged answer — triggering model escalation on the next turn.
 *
 * Weakness signals:
 *   - Vague/hedging language ("maybe", "could try", "might be", ...)
 *   - Missing code block for a code-oriented task
 *   - Suspiciously short response (< SHORT_THRESHOLD chars) for non-explanation tasks
 *
 * @param {string} transcriptPath — path to JSONL transcript
 * @param {string} taskType       — classified task type
 * @returns {{ isWeak: boolean, signals: string[] }}
 */
function detectWeakOutput(transcriptPath, taskType) {
  try {
    if (!transcriptPath) return { isWeak: false, signals: [] };

    const messages = parseTranscript(transcriptPath);
    if (!Array.isArray(messages) || messages.length === 0) {
      return { isWeak: false, signals: [] };
    }

    // Find the last assistant message
    let lastAssistant = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const c = messages[i].content;
        lastAssistant = Array.isArray(c)
          ? c.map((b) => (b.text ?? b.content ?? "")).join(" ")
          : String(c ?? "");
        break;
      }
    }

    if (lastAssistant.length < 20) return { isWeak: false, signals: [] };

    const lower   = lastAssistant.toLowerCase();
    const signals = [];

    // Signal 1: Vague / hedging language
    const vagueHits = WEAK_OUTPUT_PHRASES.filter((p) => lower.includes(p));
    if (vagueHits.length >= 2) {
      signals.push(`vague_language:${vagueHits.slice(0, 2).join(",")}`);
    }

    // Signal 2: Missing code block for a code task
    if (CODE_TASK_TYPES.has(taskType)) {
      const hasCode = lastAssistant.includes("```") || lastAssistant.includes("    ");
      if (!hasCode) {
        signals.push("missing_code:no_code_block_in_code_task");
      }
    }

    // Signal 3: Suspiciously short for non-trivial tasks
    const SHORT_THRESHOLD = 120;
    if (
      lastAssistant.length < SHORT_THRESHOLD &&
      taskType !== "explanation" &&
      taskType !== "default"
    ) {
      signals.push(`short_response:${lastAssistant.length}_chars`);
    }

    const isWeak = signals.length >= 2;
    return { isWeak, signals };
  } catch {
    return { isWeak: false, signals: [] };
  }
}

// ─── Convenience: Full Routing Result ────────────────────────────────────────

/**
 * Run the full routing pipeline for one turn.
 * Combines risk classification, model selection, suggestion, and weak detection.
 *
 * @param {{
 *   taskType:       string,
 *   prompt:         string,
 *   files:          string[],
 *   transcriptPath: string,
 *   lastTurnFailed: boolean,
 * }} params
 * @returns {{
 *   risk:           string,
 *   confidence:     number,
 *   signals:        string[],
 *   model:          string,
 *   reasoning:      string,
 *   tier:           string,
 *   escalated:      boolean,
 *   suggestion:     string,
 *   isWeak:         boolean,
 *   weakSignals:    string[],
 * }}
 */
function routeTurn(params) {
  try {
    const { taskType, prompt, files, transcriptPath, lastTurnFailed } = params ?? {};
    const riskResult  = classifyRisk(taskType, prompt, files);
    const modelResult = selectModel(riskResult.risk, riskResult.confidence, lastTurnFailed ?? false);
    const suggestion  = generateModelSuggestion(riskResult.risk, riskResult.confidence);
    const weakResult  = detectWeakOutput(transcriptPath, taskType);

    return {
      risk:        riskResult.risk,
      confidence:  riskResult.confidence,
      signals:     riskResult.signals,
      model:       modelResult.model,
      reasoning:   modelResult.reasoning,
      tier:        modelResult.tier,
      escalated:   modelResult.escalated,
      suggestion,
      isWeak:      weakResult.isWeak,
      weakSignals: weakResult.signals,
    };
  } catch {
    return {
      risk: "medium", confidence: 0.5, signals: [],
      model: MODELS.medium.model, reasoning: MODELS.medium.reasoning,
      tier: "medium", escalated: false,
      suggestion: "", isWeak: false, weakSignals: [],
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyRisk,
  selectModel,
  generateModelSuggestion,
  detectWeakOutput,
  routeTurn,
  MODELS,
};
