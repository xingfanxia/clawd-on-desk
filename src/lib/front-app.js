"use strict";

// src/lib/front-app.js — macOS frontmost-app probe.
//
// Single source of truth for "what app is in the foreground right now?"
// Two callers today:
//   1. src/permission.js — captures front app before hotkey resolve so it can
//      restore focus to the originating Terminal/Cursor afterward.
//   2. src/workspace-detector.js (PAWPAL-2 Task 4) — polls this every 5s to
//      track the active app and route it to a workspace category.
//
// Implementation: same osascript probe `permission.js#captureFrontApp` used
// before extraction. 500ms timeout — denied/missing AX permission can cause
// the first call to hang briefly. No-op on non-macOS (cb(null) immediately).
//
// `execFileOverride` is for test injection — tests pass a stub that mimics
// the node:child_process.execFile signature without spawning a real process.
//
// SECURITY: We use `execFile` (NOT the shell-spawning variant) with a static
// argv. No user input ever flows into the argv, so there's no shell
// metacharacter risk. Do NOT switch to the shell-spawning variant or
// template the argv from user input.

// `child_process` is required unconditionally even though `captureFrontApp`
// short-circuits to `cb(null)` on non-macOS. The platform check is per-call
// (so an injected `platform: "darwin"` opt at test time still spawns the
// stub), not per-module. A single require at module load is cheap and
// matches what `src/permission.js` was doing before the extraction.
const { execFile: defaultExecFile } = require("child_process");

const OSASCRIPT_TIMEOUT_MS = 500;
const OSASCRIPT_FRONT_APP_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

function captureFrontApp(cb, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const isMac = platform === "darwin";
  if (!isMac) { cb(null); return; }
  const runFn = o.execFileOverride || defaultExecFile;
  runFn(
    "osascript",
    ["-e", OSASCRIPT_FRONT_APP_SCRIPT],
    { timeout: OSASCRIPT_TIMEOUT_MS },
    (err, stdout) => {
      cb(err ? null : String(stdout || "").trim());
    },
  );
}

module.exports = {
  captureFrontApp,
  // Test-only — exposed so tests can assert against the actual probe string
  // / timeout without re-deriving constants from the implementation.
  __test: {
    OSASCRIPT_TIMEOUT_MS,
    OSASCRIPT_FRONT_APP_SCRIPT,
  },
};
