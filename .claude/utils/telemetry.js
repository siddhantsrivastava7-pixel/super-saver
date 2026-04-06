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
    prompts_processed:            0,
    cache_hits:                   0,
    cache_misses:                 0,
    total_estimated_saved_tokens: 0,
    savings_pct_sum:              0,
    // Breakdown totals
    prompt_saved_tokens:          0,
    history_saved_tokens:         0,
    read_cache_saved_tokens:      0,
    output_policy_saved_tokens:   0,
    lifecycle_saved_tokens:       0,
    // Lifecycle mode counters
    lifecycle_normal_turns:       0,
    lifecycle_compact_turns:      0,
    lifecycle_rebuild_turns:      0,
    session_started:              new Date().toISOString(),
    last_updated:                 new Date().toISOString(),
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
      taskType      = "unknown",
      originalChars = 0,
      cacheHits     = 0,
      relevantFiles = [],
      updatedSavings,
      lifecycleMode = "normal",
    } = fields;

    const state    = loadState();
    const prevSaved = state.total_estimated_saved_tokens;
    const nowSaved  = updatedSavings?.total_estimated_saved_tokens ?? 0;
    const turnSaved = Math.max(0, nowSaved - prevSaved);

    const origTokens  = Math.ceil(originalChars / 4);
    const cacheTotal  = relevantFiles.length;
    const cacheMisses = Math.max(0, cacheTotal - cacheHits);

    // Per-turn efficiency: what fraction of total-would-have-sent did we save?
    const wouldHaveSent = origTokens + turnSaved;
    const turnPct = wouldHaveSent > 0
      ? Math.round((turnSaved / wouldHaveSent) * 100)
      : 0;

    // Per-turn breakdown from updatedSavings (diff from previous state)
    const prevPromptSaved  = state.prompt_saved_tokens         || 0;
    const prevHistSaved    = state.history_saved_tokens        || 0;
    const prevCacheSaved   = state.read_cache_saved_tokens     || 0;
    const prevPolicySaved  = state.output_policy_saved_tokens  || 0;

    const turnPromptSaved  = Math.max(0, (updatedSavings?.prompt_saved_tokens         || 0) - prevPromptSaved);
    const turnHistSaved    = Math.max(0, (updatedSavings?.history_saved_tokens        || 0) - prevHistSaved);
    const turnCacheSaved   = Math.max(0, (updatedSavings?.read_cache_saved_tokens     || 0) - prevCacheSaved);
    const turnPolicySaved  = Math.max(0, (updatedSavings?.output_policy_saved_tokens  || 0) - prevPolicySaved);

    const turnLifecycleSaved = Math.max(
      0,
      (updatedSavings?.lifecycle_saved_tokens || 0) - (state.lifecycle_saved_tokens || 0)
    );

    appendLog({
      ts:                    new Date().toISOString(),
      turn:                  state.prompts_processed + 1,
      task:                  taskType,
      saved:                 turnSaved,
      hits:                  cacheHits,
      misses:                cacheMisses,
      pct:                   turnPct,
      lifecycle_mode:        lifecycleMode,
      // Breakdown
      prompt_saved:          turnPromptSaved,
      history_saved:         turnHistSaved,
      cache_saved:           turnCacheSaved,
      policy_saved:          turnPolicySaved,
      lifecycle_saved:       turnLifecycleSaved,
    });

    state.prompts_processed            += 1;
    state.cache_hits                   += cacheHits;
    state.cache_misses                 += cacheMisses;
    state.total_estimated_saved_tokens  = nowSaved;
    state.savings_pct_sum              += turnPct;
    // Sync breakdown totals from updatedSavings
    state.prompt_saved_tokens          = updatedSavings?.prompt_saved_tokens         || state.prompt_saved_tokens         || 0;
    state.history_saved_tokens         = updatedSavings?.history_saved_tokens        || state.history_saved_tokens        || 0;
    state.read_cache_saved_tokens      = updatedSavings?.read_cache_saved_tokens     || state.read_cache_saved_tokens     || 0;
    state.output_policy_saved_tokens   = updatedSavings?.output_policy_saved_tokens  || state.output_policy_saved_tokens  || 0;
    state.lifecycle_saved_tokens       = updatedSavings?.lifecycle_saved_tokens      || state.lifecycle_saved_tokens      || 0;
    // Increment lifecycle mode counter for this turn
    if (lifecycleMode === "rebuild")      state.lifecycle_rebuild_turns = (state.lifecycle_rebuild_turns || 0) + 1;
    else if (lifecycleMode === "compact") state.lifecycle_compact_turns = (state.lifecycle_compact_turns || 0) + 1;
    else                                  state.lifecycle_normal_turns  = (state.lifecycle_normal_turns  || 0) + 1;
    state.last_updated                  = new Date().toISOString();
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
      // Breakdown
      prompt_saved_tokens:                s.prompt_saved_tokens         || 0,
      history_saved_tokens:               s.history_saved_tokens        || 0,
      read_cache_saved_tokens:            s.read_cache_saved_tokens     || 0,
      output_policy_saved_tokens:         s.output_policy_saved_tokens  || 0,
      lifecycle_saved_tokens:             s.lifecycle_saved_tokens      || 0,
      // Lifecycle mode distribution
      lifecycle_normal_turns:             s.lifecycle_normal_turns      || 0,
      lifecycle_compact_turns:            s.lifecycle_compact_turns     || 0,
      lifecycle_rebuild_turns:            s.lifecycle_rebuild_turns     || 0,
      session_started:                    s.session_started,
      last_updated:                       s.last_updated,
    };
  } catch {
    return null;
  }
}

module.exports = { recordTurn, getMetrics };
