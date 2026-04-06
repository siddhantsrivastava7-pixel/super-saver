/**
 * .claude/utils/telemetry.js
 *
 * Lightweight Observability Layer
 *
 * Tracks per-turn metrics in a self-contained state file and writes a
 * compact rolling JSONL log. Intentionally separate from memory.js so
 * telemetry never contaminates the session memory schema.
 *
 * Files written:
 *   .claude/logs/telemetry-state.json  — aggregate counters (JSON, human-readable)
 *   .claude/logs/telemetry.jsonl       — per-turn log (JSONL, rolling cap)
 *
 * Log line format (one JSON object per turn):
 *   {"ts":"2024-01-15T10:32:15.000Z","turn":2,"task":"code-fix","saved":18,"hits":1,"misses":0,"pct":23}
 *
 * Telemetry state example:
 *   {
 *     "prompts_processed": 12,
 *     "cache_hits": 8,
 *     "cache_misses": 4,
 *     "total_estimated_saved_tokens": 1842,
 *     "savings_pct_sum": 276,
 *     "session_started": "2024-01-15T10:30:00.000Z",
 *     "last_updated": "2024-01-15T11:45:22.000Z"
 *   }
 *
 * getMetrics() output:
 *   {
 *     "prompts_processed": 12,
 *     "cache_hits": 8,
 *     "cache_misses": 4,
 *     "total_estimated_saved_tokens": 1842,
 *     "average_estimated_savings_percent": 23,
 *     "session_started": "2024-01-15T10:30:00.000Z",
 *     "last_updated": "2024-01-15T11:45:22.000Z"
 *   }
 *
 * INVARIANT: Every function in this module is non-fatal.
 * Telemetry failures must never propagate to the caller.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const { computeTurnProof } = require(path.join(__dirname, "proofEngine.js"));

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_DIR    = path.resolve(__dirname, "../logs");
const STATE_FILE = path.join(LOG_DIR, "telemetry-state.json");
const LOG_FILE   = path.join(LOG_DIR, "telemetry.jsonl");

// Max lines before oldest entries are pruned
const MAX_LOG_LINES = 200;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

/**
 * Load aggregate telemetry state from disk.
 * Returns a fresh default if the file is missing or corrupted.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    prompts_processed:                0,
    cache_hits:                       0,
    cache_misses:                     0,
    total_estimated_saved_tokens:     0,
    total_tokens_processed_estimate:  0,
    savings_pct_sum:                  0,
    // Breakdown totals
    prompt_saved_tokens:              0,
    history_saved_tokens:             0,
    read_cache_saved_tokens:          0,
    output_policy_saved_tokens:       0,
    lifecycle_saved_tokens:           0,
    // Lifecycle mode counters
    lifecycle_normal_turns:           0,
    lifecycle_compact_turns:          0,
    lifecycle_rebuild_turns:          0,
    // V2: Proof engine (before vs after, derived from savings — additive)
    estimated_total_tokens_without_optimizer: 0,
    estimated_total_tokens_with_optimizer:    0,
    estimated_total_tokens_saved:             0,
    estimated_efficiency_percent:             0,
    // V2: Tool tracker (additive per-turn accumulation)
    tool_calls_estimate:              0,
    file_reads_estimate:              0,
    redundant_reads_estimate:         0,
    tool_suppressed_turns:            0,
    estimated_tool_cost_tokens:       0,   // tokens tool calls would cost (cumulative)
    estimated_suppression_saved:      0,   // tokens saved by suppression (cumulative)
    // V4: Output waste tracking
    output_tokens_analyzed:           0,   // total output tokens examined across turns
    output_tokens_redundant_estimated: 0,  // total estimated redundant output tokens
    output_waste_turns:               0,   // turns where waste was detected
    session_started:                  new Date().toISOString(),
    last_updated:                     new Date().toISOString(),
  };
}

function saveState(s) {
  ensureDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf-8");
  } catch {}
}

/**
 * Append a log entry with a rolling cap.
 * Rewrites the file when it exceeds MAX_LOG_LINES (avoids unbounded growth).
 * Falls back to simple append if rewrite fails.
 */
function appendLog(entry) {
  ensureDir();
  try {
    let lines = [];
    try {
      lines = fs.readFileSync(LOG_FILE, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {}

    if (lines.length >= MAX_LOG_LINES) {
      lines = lines.slice(-(MAX_LOG_LINES - 1));
    }
    lines.push(JSON.stringify(entry));
    fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf-8");
  } catch {
    // Fallback: blind append (may grow unbounded, but better than silence)
    try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch {}
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a completed pipeline turn.
 * Called by pipeline.js at the end of runPipeline().
 *
 * @param {{
 *   taskType:        string,   — classified task type (e.g. "code-fix")
 *   originalChars:   number,   — raw prompt character count
 *   optimizedChars:  number,   — optimized prompt character count
 *   cacheHits:       number,   — files served from registry
 *   relevantFiles:   string[], — all files considered this turn
 *   updatedSavings:  object,   — memory.savings after this turn
 *   lifecycleMode?:  string,   — "normal"|"compact"|"rebuild"
 * }} fields
 */
function recordTurn(fields) {
  try {
    const {
      taskType       = "unknown",
      originalChars  = 0,
      optimizedChars = 0,
      cacheHits      = 0,
      relevantFiles  = [],
      lifecycleMode  = "normal",
      turnStats,
      proofStats     = {},
      toolStats        = {},
      outputWasteStats = {},
    } = fields;

    // turnStats contains the per-turn deltas from savings.js.
    // Using these instead of session totals means telemetry accumulates correctly
    // across multiple Claude Code sessions — even when memory.savings resets.
    const ts = turnStats ?? {};
    const turnSaved    = ts.total_saved    ?? 0;
    const optimTokens  = ts.optimized_tokens ?? Math.ceil((optimizedChars || originalChars) / 4);

    const origTokens  = Math.ceil(originalChars / 4);
    const cacheTotal  = relevantFiles.length;
    const cacheMisses = Math.max(0, cacheTotal - cacheHits);

    // Per-turn efficiency: what fraction of total-would-have-sent did we save?
    const wouldHaveSent = origTokens + turnSaved;
    const turnPct = wouldHaveSent > 0
      ? Math.round((turnSaved / wouldHaveSent) * 100)
      : 0;

    // Per-turn proof: before vs after for THIS TURN (not cumulative session)
    const turnProof = computeTurnProof({ optimizedChars: optimizedChars || originalChars, turnStats: ts });

    const state = loadState();

    appendLog({
      ts:              new Date().toISOString(),
      turn:            state.prompts_processed + 1,
      task:            taskType,
      saved:           turnSaved,
      hits:            cacheHits,
      misses:          cacheMisses,
      pct:             turnPct,
      lifecycle_mode:  lifecycleMode,
      // Per-turn breakdown (directly from turnStats — no diff arithmetic needed)
      prompt_saved:    ts.prompt_saved    ?? 0,
      history_saved:   ts.history_saved   ?? 0,
      cache_saved:     ts.cache_saved     ?? 0,
      policy_saved:    ts.policy_saved    ?? 0,
      lifecycle_saved: ts.lifecycle_saved ?? 0,
      // Per-turn proof: "Turn N → saved X tokens (without: Y, with: Z)"
      proof_without:   turnProof.without_tokens,
      proof_with:      turnProof.with_tokens,
      per_turn_saved_tokens: turnProof.saved_tokens,
    });

    // Additive accumulation — each field += this turn's contribution.
    // Never assign session totals here: memory.savings resets each session,
    // which would silently overwrite the telemetry cross-session running total.
    state.prompts_processed            += 1;
    state.cache_hits                   += cacheHits;
    state.cache_misses                 += cacheMisses;
    state.savings_pct_sum              += turnPct;
    state.total_estimated_saved_tokens += turnSaved;
    state.total_tokens_processed_estimate += optimTokens + turnSaved;
    state.prompt_saved_tokens          += ts.prompt_saved    ?? 0;
    state.history_saved_tokens         += ts.history_saved   ?? 0;
    state.read_cache_saved_tokens      += ts.cache_saved     ?? 0;
    state.output_policy_saved_tokens   += ts.policy_saved    ?? 0;
    state.lifecycle_saved_tokens       += ts.lifecycle_saved ?? 0;
    // Lifecycle mode counters
    if (lifecycleMode === "rebuild")      state.lifecycle_rebuild_turns = (state.lifecycle_rebuild_turns ?? 0) + 1;
    else if (lifecycleMode === "compact") state.lifecycle_compact_turns = (state.lifecycle_compact_turns ?? 0) + 1;
    else                                  state.lifecycle_normal_turns  = (state.lifecycle_normal_turns  ?? 0) + 1;

    // V2: Proof engine — sync from latest session proof (not additive —
    // these are derived fields that always reflect the latest computed values)
    if (proofStats && typeof proofStats.estimated_total_tokens_without_optimizer === "number") {
      state.estimated_total_tokens_without_optimizer = proofStats.estimated_total_tokens_without_optimizer;
      state.estimated_total_tokens_with_optimizer    = proofStats.estimated_total_tokens_with_optimizer;
      state.estimated_total_tokens_saved             = proofStats.estimated_total_tokens_saved;
      state.estimated_efficiency_percent             = proofStats.estimated_efficiency_percent;
    }

    // V2: Tool tracker — additive per-turn accumulation
    state.tool_calls_estimate     += toolStats.tool_calls_estimate  ?? 0;
    state.file_reads_estimate     += toolStats.file_reads_this_turn ?? 0;
    state.redundant_reads_estimate += toolStats.redundant_reads     ?? 0;
    if (toolStats.is_suppressed) {
      state.tool_suppressed_turns = (state.tool_suppressed_turns ?? 0) + 1;
    }
    state.estimated_tool_cost_tokens  += toolStats.estimated_tool_cost_tokens  ?? 0;
    state.estimated_suppression_saved += toolStats.estimated_suppression_saved ?? 0;

    // V4: Output waste — additive accumulation
    state.output_tokens_analyzed           += outputWasteStats.output_tokens_total     ?? 0;
    state.output_tokens_redundant_estimated += outputWasteStats.output_tokens_redundant ?? 0;
    if (outputWasteStats.has_waste) {
      state.output_waste_turns = (state.output_waste_turns ?? 0) + 1;
    }

    state.last_updated = new Date().toISOString();
    saveState(state);

  } catch {
    // Telemetry must never break the pipeline
  }
}

/**
 * Return aggregate metrics suitable for display or monitoring.
 * Returns null if no data has been recorded yet.
 */
function getMetrics() {
  try {
    const s = loadState();
    const n = s.prompts_processed;
    return {
      prompts_processed:                  n,
      cache_hits:                         s.cache_hits,
      cache_misses:                       s.cache_misses,
      total_estimated_saved_tokens:       s.total_estimated_saved_tokens,
      average_estimated_savings_percent:  n > 0
        ? Math.round(s.savings_pct_sum / n)
        : 0,
      total_tokens_processed_estimate:    s.total_tokens_processed_estimate ?? 0,
      // Breakdown
      prompt_saved_tokens:                s.prompt_saved_tokens         ?? 0,
      history_saved_tokens:               s.history_saved_tokens        ?? 0,
      read_cache_saved_tokens:            s.read_cache_saved_tokens     ?? 0,
      output_policy_saved_tokens:         s.output_policy_saved_tokens  ?? 0,
      lifecycle_saved_tokens:             s.lifecycle_saved_tokens      ?? 0,
      // Lifecycle mode distribution
      lifecycle_normal_turns:             s.lifecycle_normal_turns      ?? 0,
      lifecycle_compact_turns:            s.lifecycle_compact_turns     ?? 0,
      lifecycle_rebuild_turns:            s.lifecycle_rebuild_turns     ?? 0,
      // V2: Proof engine
      estimated_total_tokens_without_optimizer: s.estimated_total_tokens_without_optimizer ?? 0,
      estimated_total_tokens_with_optimizer:    s.estimated_total_tokens_with_optimizer    ?? 0,
      estimated_total_tokens_saved:             s.estimated_total_tokens_saved             ?? 0,
      estimated_efficiency_percent:             s.estimated_efficiency_percent             ?? 0,
      // V2: Tool tracker
      tool_calls_estimate:                s.tool_calls_estimate         ?? 0,
      file_reads_estimate:                s.file_reads_estimate         ?? 0,
      redundant_reads_estimate:           s.redundant_reads_estimate    ?? 0,
      tool_suppressed_turns:              s.tool_suppressed_turns       ?? 0,
      estimated_tool_cost_tokens:         s.estimated_tool_cost_tokens  ?? 0,
      estimated_suppression_saved:        s.estimated_suppression_saved ?? 0,
      // V4: Output waste
      output_tokens_analyzed:             s.output_tokens_analyzed              ?? 0,
      output_tokens_redundant_estimated:  s.output_tokens_redundant_estimated   ?? 0,
      output_waste_turns:                 s.output_waste_turns                  ?? 0,
      session_started:                    s.session_started,
      last_updated:                       s.last_updated,
    };
  } catch {
    return null;
  }
}

module.exports = { recordTurn, getMetrics };
