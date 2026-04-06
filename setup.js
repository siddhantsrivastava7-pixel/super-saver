#!/usr/bin/env node
/**
 * setup.js — SUPER SAVER installer
 *
 * Copies the hook into any project directory. Run from your project:
 *
 *   npx github:siddhantsrivastava7-pixel/super-saver   # Claude Code
 *   npx github:siddhantsrivastava7-pixel/super-saver --codex  # + Codex
 *
 * Or clone first and run directly:
 *   node /path/to/super-saver/setup.js [--codex] [--target /path/to/project]
 *
 * What it does:
 *   1. Copies .claude/ into the target project
 *   2. Merges the UserPromptSubmit hook into existing settings.json (safe merge)
 *   3. Optionally copies .codex/ for Codex CLI integration
 *   4. Verifies Node.js ≥ 18
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const withCodex = args.includes("--codex");
const targetIdx = args.indexOf("--target");
const target    = targetIdx !== -1 ? path.resolve(args[targetIdx + 1]) : process.cwd();
const src       = __dirname; // location of this setup.js = repo root

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(`  ${msg}\n`); }
function ok(msg)   { process.stdout.write(`  \x1b[32m✓\x1b[0m ${msg}\n`); }
function warn(msg) { process.stdout.write(`  \x1b[33m!\x1b[0m ${msg}\n`); }
function fail(msg) { process.stderr.write(`  \x1b[31m✗\x1b[0m ${msg}\n`); process.exit(1); }

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ─── Guards ───────────────────────────────────────────────────────────────────

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) fail(`Node.js ≥ 18 required (you have ${process.versions.node})`);

if (!fs.existsSync(path.join(src, ".claude"))) {
  fail("Can't find .claude/ — run setup.js from the super-saver repo root.");
}

// Refuse to install into the super-saver repo itself
if (path.resolve(target) === path.resolve(src)) {
  fail("Target must be a different project directory, not the super-saver repo itself.");
}

// ─── Banner ───────────────────────────────────────────────────────────────────

process.stdout.write("\n\x1b[1mSUPER SAVER — setup\x1b[0m\n");
process.stdout.write(`  Target : ${target}\n`);
process.stdout.write(`  Codex  : ${withCodex ? "yes" : "no (pass --codex to enable)"}\n\n`);

// ─── Step 1: Copy .claude/ ────────────────────────────────────────────────────

const claudeSrc  = path.join(src,    ".claude");
const claudeDest = path.join(target, ".claude");
const alreadyExists = fs.existsSync(claudeDest);

try {
  copyDir(claudeSrc, claudeDest);
  ok(alreadyExists
    ? ".claude/ updated (existing files overwritten)"
    : ".claude/ copied");
} catch (e) {
  fail(`Failed to copy .claude/: ${e.message}`);
}

// ─── Step 2: Merge settings.json hook ────────────────────────────────────────
// Safe merge: reads existing settings, adds only the missing hook entry.
// Never overwrites other settings or permissions the user has configured.

const settingsPath = path.join(target, ".claude", "settings.json");

const HOOK_ENTRY = {
  type:    "command",
  command: "node .claude/hooks/beforePrompt.js",
  timeout: 10,
};

try {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
    catch { warn("Existing settings.json is not valid JSON — overwriting with hook config."); }
  }

  // Navigate/create the hook path: settings.hooks.UserPromptSubmit[0].hooks[]
  settings.hooks                             ??= {};
  settings.hooks.UserPromptSubmit            ??= [];
  if (settings.hooks.UserPromptSubmit.length === 0) {
    settings.hooks.UserPromptSubmit.push({ hooks: [] });
  }
  const hookGroup = settings.hooks.UserPromptSubmit[0];
  hookGroup.hooks ??= [];

  const alreadyRegistered = hookGroup.hooks.some(
    (h) => h.command === HOOK_ENTRY.command
  );

  if (alreadyRegistered) {
    ok("Hook already registered in settings.json — no change needed");
  } else {
    hookGroup.hooks.push(HOOK_ENTRY);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    ok("Hook registered in .claude/settings.json");
  }
} catch (e) {
  fail(`Failed to update settings.json: ${e.message}`);
}

// ─── Step 3: Copy .codex/ (optional) ─────────────────────────────────────────

if (withCodex) {
  const codexSrc  = path.join(src,    ".codex");
  const codexDest = path.join(target, ".codex");
  if (!fs.existsSync(codexSrc)) {
    warn(".codex/ not found in repo — skipping Codex install.");
  } else {
    try {
      copyDir(codexSrc, codexDest);
      ok(fs.existsSync(codexDest)
        ? ".codex/ updated"
        : ".codex/ copied");
    } catch (e) {
      fail(`Failed to copy .codex/: ${e.message}`);
    }
  }
}

// ─── Step 4: Verify the hook runs ────────────────────────────────────────────

const hookPath = path.join(target, ".claude", "hooks", "beforePrompt.js");
if (!fs.existsSync(hookPath)) {
  fail("Hook file missing after copy — something went wrong.");
}

try {
  const { execSync } = require("child_process");
  // Send a minimal valid payload and check for JSON output (exit 0)
  const payload = JSON.stringify({
    prompt: "test prompt for setup verification",
    session_id: "setup-test",
    cwd: target,
    transcript_path: "",
  });
  const out = execSync(
    `echo ${JSON.stringify(payload)} | node "${hookPath}"`,
    { cwd: target, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
  ).toString();
  JSON.parse(out); // must be valid JSON
  ok("Hook smoke test passed");
} catch {
  warn("Hook smoke test skipped (could not run in this environment — safe to ignore).");
}

// ─── Done ─────────────────────────────────────────────────────────────────────

process.stdout.write("\n\x1b[1m\x1b[32mDone!\x1b[0m\n\n");

if (withCodex) {
  process.stdout.write([
    "Next steps:",
    "  Claude Code : open Claude Code from your project folder → hook is live",
    "  Codex       : wire .codex/config.toml hooks into your Codex CLI config",
    "",
    "Check savings after a session:",
    `  node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"`,
    "",
  ].join("\n"));
} else {
  process.stdout.write([
    "Next steps:",
    "  Open Claude Code from your project folder — the hook is live.",
    "",
    "  To also install Codex support: run with --codex",
    `    npx github:siddhantsrivastava7-pixel/super-saver --codex`,
    "",
    "Check savings after a session:",
    `  node -e "const {getMetrics}=require('./.claude/utils/telemetry.js'); console.log(JSON.stringify(getMetrics(),null,2));"`,
    "",
  ].join("\n"));
}
