"use strict";

// src/system-monitor.js -- PAWPAL-2 Task 5.
//
// Two pure signal sources combined into one detector:
//
//   1. Typing rate -- keystrokes per minute over a rolling 60s window. Counter
//      is incremented by an injected `keystrokeSource` (subscribe/unsubscribe
//      interface). The source itself is platform-specific -- globally counting
//      keystrokes on macOS requires CGEventTap behind the Input Monitoring
//      TCC gate, which can only be implemented via native code. v1 ships
//      WITHOUT a native keystroke source -- `getTypingRate()` returns `null`
//      in production (and tests inject a fake source to exercise the
//      counting + decay logic). This is the truthful "unknown" semantic;
//      PAWPAL-2.2 will add a native source.
//
//   2. CPU pressure -- `execFile` invokes `top -l 1 -n 0` and parses the
//      "CPU usage:" line. Sums user + sys for 0-100% pressure. macOS-only
//      (Linux / Windows return `null`); 30s polling cadence. `top -l 1 -n 0`
//      returns immediately on a healthy macOS so we keep the spawn timeout
//      small (2000ms). Always invoked via the safe non-shell `execFile`
//      variant from child_process; only call site uses static argv, no
//      user input.
//
// On top of those samples sits a small state machine that fires
// `onStuckOnProblem` when BOTH conditions hold simultaneously:
//
//   - typing pause:     (now - lastKeystrokeAt) >= typingPauseThresholdMs  (default 30s)
//   - cpu sustained:    cpuStressSince !== null AND
//                        (now - cpuStressSince) >= cpuStressDurationMs    (default 2 min)
//
// To avoid spamming the nudge layer the fire has a 15-minute cooldown -- once
// a stuck event is emitted, no re-fire until 15 min after the first fire,
// regardless of the underlying conditions. State machine is silent when
// either signal is "unknown" (typing rate is null) -- null + threshold is a
// nonsense comparison.
//
// Gating (silent no-op when any fails -- no error logs, no spawn / source
// activity):
//   - prefs.workspaceAwareness.enabled === true
//   - prefs.workspaceAwareness.systemMonitor.enabled === true
//   - For typing rate ONLY: osPermission.isGranted("inputMonitoring") === "granted"
//     (CPU probe needs no permission; `top` runs as the user.)
//
// Like workspace-detector.js, polling continues regardless -- gates apply at
// tick time, so a prefs / OS-permission flip resumes detection on the next
// tick without restart. `reload()` re-evaluates gates immediately; it does
// NOT clear past `lastStuckFireAt` (stuck history is part of fatigue tracking
// -- re-firing inside the cooldown after a user pref toggle would be noise).

const DEFAULT_TYPING_POLL_MS = 1000;
const DEFAULT_CPU_POLL_MS = 30000;
const DEFAULT_TYPING_WINDOW_MS = 60000;
const STUCK_COOLDOWN_MS = 15 * 60_000;
const TOP_SPAWN_TIMEOUT_MS = 2000;

// macOS `top -l 1 -n 0` writes a "CPU usage:" header line. Format on
// Sonoma/Sequoia (and back to Mojave):
//   CPU usage: 12.34% user, 5.67% sys, 81.99% idle
// Decimals optional, spaces around commas may vary. `[\d.]+` is permissive
// enough to handle both `12` and `12.34`.
const TOP_CPU_REGEX = /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/i;

function initSystemMonitor(ctx) {
  const c = ctx || {};
  if (typeof c.getPrefs !== "function") {
    throw new Error("system-monitor: ctx.getPrefs is required");
  }
  if (!c.osPermission || typeof c.osPermission.isGranted !== "function") {
    throw new Error("system-monitor: ctx.osPermission with isGranted() is required");
  }
  // Pair-check timer injection (matches workspace-detector.js -- see Task 4
  // commit for rationale). Mixing real and fake plumbing silently leaks
  // timers in tests or attempts to clearInterval a real handle with a stub.
  const hasSetInterval = typeof c.setInterval === "function";
  const hasClearInterval = typeof c.clearInterval === "function";
  if (hasSetInterval !== hasClearInterval) {
    throw new Error(
      "system-monitor: ctx.setInterval and ctx.clearInterval must be provided together",
    );
  }

  const log = typeof c.log === "function" ? c.log : function noop() {};
  const now = typeof c.now === "function" ? c.now : () => Date.now();
  const setIntervalFn = hasSetInterval ? c.setInterval : setInterval;
  const clearIntervalFn = hasClearInterval ? c.clearInterval : clearInterval;
  const platform = c.platform || process.platform;
  const isMac = platform === "darwin";
  // execFile is injectable so CPU-probe tests don't spawn a real subprocess.
  // Default is the safe (non-shell) child_process.execFile; the only call
  // site below uses static "top" + static argv, no user input.
  const execFileFn = typeof c.execFile === "function" ? c.execFile : require("child_process").execFile;
  // keystrokeSource is the injected typing-event source. When null (v1
  // production), getTypingRate() returns null. Contract:
  //   source.subscribe(cb)   -> returns unsubscribe fn; cb is called with no
  //                            args on every observed keystroke.
  // Anything else (no subscribe method) -> treated as absent.
  const keystrokeSource = (c.keystrokeSource && typeof c.keystrokeSource.subscribe === "function")
    ? c.keystrokeSource
    : null;
  const typingPollMs = Number.isFinite(c.typingPollMs) && c.typingPollMs > 0
    ? c.typingPollMs
    : DEFAULT_TYPING_POLL_MS;
  const cpuPollMs = Number.isFinite(c.cpuPollMs) && c.cpuPollMs > 0
    ? c.cpuPollMs
    : DEFAULT_CPU_POLL_MS;
  const typingWindowMs = Number.isFinite(c.typingWindowMs) && c.typingWindowMs > 0
    ? c.typingWindowMs
    : DEFAULT_TYPING_WINDOW_MS;

  // -- State --------------------------------------------------------------
  let cpuIntervalHandle = null;
  let typingIntervalHandle = null;
  let unsubscribeKeystroke = null;

  // Rolling keystroke timestamps. Newer timestamps appended; entries older
  // than typingWindowMs trimmed lazily on each access. Array (not Set) so
  // duplicates from rapid bursts are preserved.
  const keystrokeStamps = [];
  let lastKeystrokeAt = null; // null until first keystroke observed

  // CPU pressure: cached last sample (0-100) or null on parse-fail / disabled.
  let cpuPressurePct = null;
  let cpuStressSince = null; // timestamp when crossed threshold; null otherwise
  let cpuParseFailedLogged = false; // log-once flag (avoid spamming on every poll)

  // Stuck-on-problem: 15-min cooldown between fires.
  let lastStuckFireAt = null;
  const stuckListeners = new Set();

  // -- Helpers ------------------------------------------------------------

  function getPrefsSnapshot() {
    try {
      const p = c.getPrefs();
      return (p && typeof p === "object") ? p : null;
    } catch (err) {
      log("error", "system-monitor: getPrefs threw", err);
      return null;
    }
  }

  function getThresholds() {
    const prefs = getPrefsSnapshot();
    const sys = prefs
      && prefs.workspaceAwareness
      && prefs.workspaceAwareness.systemMonitor;
    return {
      typingPauseThresholdMs: (sys && Number.isFinite(sys.typingPauseThresholdMs) && sys.typingPauseThresholdMs > 0)
        ? sys.typingPauseThresholdMs
        : 30000,
      cpuStressThresholdPct: (sys && Number.isFinite(sys.cpuStressThresholdPct) && sys.cpuStressThresholdPct > 0)
        ? sys.cpuStressThresholdPct
        : 70,
      cpuStressDurationMs: (sys && Number.isFinite(sys.cpuStressDurationMs) && sys.cpuStressDurationMs > 0)
        ? sys.cpuStressDurationMs
        : 120000,
    };
  }

  // Top-level feature gate. Returns true to no-op.
  function isFeatureGated() {
    const prefs = getPrefsSnapshot();
    const wa = prefs && prefs.workspaceAwareness;
    if (!wa || !wa.enabled) return true;
    if (!wa.systemMonitor || !wa.systemMonitor.enabled) return true;
    return false;
  }

  // Typing-specific gate (adds Input Monitoring permission on top of feature gate).
  function isTypingGated() {
    if (isFeatureGated()) return true;
    try {
      const state = c.osPermission.isGranted("inputMonitoring");
      if (state !== "granted") return true;
    } catch (err) {
      log("error", "system-monitor: osPermission.isGranted threw", err);
      return true;
    }
    return false;
  }

  // CPU-specific gate (just the feature gate + macOS platform check).
  function isCpuGated() {
    if (isFeatureGated()) return true;
    if (!isMac) return true;
    return false;
  }

  // -- Typing counter -----------------------------------------------------

  function recordKeystroke() {
    // Defensive: if the source pushes events while gated, we still record
    // the time -- but getTypingRate returns null under the gate, so the
    // recorded data only surfaces once the user re-enables. (Trimming on
    // each access keeps memory bounded.) However, if no keystrokeSource is
    // wired we never reach here, so the v1 production path has no buffer
    // at all.
    const t = now();
    keystrokeStamps.push(t);
    lastKeystrokeAt = t;
  }

  // Drop entries outside the rolling window. Called from getTypingRate and
  // the typing-poll tick (which also drives the stuck-on-problem evaluator).
  function trimKeystrokes() {
    if (keystrokeStamps.length === 0) return;
    const cutoff = now() - typingWindowMs;
    let dropCount = 0;
    while (dropCount < keystrokeStamps.length && keystrokeStamps[dropCount] < cutoff) {
      dropCount += 1;
    }
    if (dropCount > 0) keystrokeStamps.splice(0, dropCount);
  }

  // -- CPU probe ----------------------------------------------------------

  function parseTopCpuLine(stdout) {
    // Return null on any failure -- defensive against future macOS `top`
    // format changes. Log ONCE per session via cpuParseFailedLogged.
    if (typeof stdout !== "string" || !stdout) return null;
    const match = stdout.match(TOP_CPU_REGEX);
    if (!match) return null;
    const user = parseFloat(match[1]);
    const sys = parseFloat(match[2]);
    if (!Number.isFinite(user) || !Number.isFinite(sys)) return null;
    const pressure = user + sys;
    // Sanity clamp -- extreme parse mishaps shouldn't propagate nonsense.
    if (pressure < 0 || pressure > 100) return null;
    return pressure;
  }

  function sampleCpuPressure() {
    if (isCpuGated()) return;
    try {
      execFileFn(
        "top",
        ["-l", "1", "-n", "0"],
        { timeout: TOP_SPAWN_TIMEOUT_MS },
        function onTopResult(err, stdout) {
          // Defensive: monitor may have been stopped between schedule and
          // callback; dropping late samples keeps state consistent (mirrors
          // workspace-detector's late-capture guard).
          if (!cpuIntervalHandle) return;
          if (err) {
            if (!cpuParseFailedLogged) {
              log("warn", "system-monitor: top spawn failed", err);
              cpuParseFailedLogged = true;
            }
            cpuPressurePct = null;
            return;
          }
          const pressure = parseTopCpuLine(stdout);
          if (pressure === null) {
            if (!cpuParseFailedLogged) {
              log("warn", "system-monitor: top parse failed", new Error("CPU line not recognized"));
              cpuParseFailedLogged = true;
            }
            cpuPressurePct = null;
            return;
          }
          cpuPressurePct = pressure;
          updateCpuStressWindow();
          evaluateStuckOnProblem();
        },
      );
    } catch (err) {
      if (!cpuParseFailedLogged) {
        log("error", "system-monitor: top spawn threw", err);
        cpuParseFailedLogged = true;
      }
      cpuPressurePct = null;
    }
  }

  // Maintain `cpuStressSince` based on the latest cpuPressurePct sample.
  // Crossing-up: stamp `cpuStressSince = now()` (start of stress window).
  // Crossing-down: reset to null. Staying-above: leave `cpuStressSince` alone.
  function updateCpuStressWindow() {
    if (cpuPressurePct === null) return;
    const { cpuStressThresholdPct } = getThresholds();
    if (cpuPressurePct >= cpuStressThresholdPct) {
      if (cpuStressSince === null) cpuStressSince = now();
    } else {
      cpuStressSince = null;
    }
  }

  // -- Typing poll (used for stuck-on-problem evaluation when source exists) --

  function typingTick() {
    if (isTypingGated()) return;
    trimKeystrokes();
    evaluateStuckOnProblem();
  }

  // -- Stuck-on-problem evaluator -----------------------------------------
  //
  // Fires onStuckOnProblem when BOTH conditions hold:
  //   - typing pause: lastKeystrokeAt !== null AND (now - lastKeystrokeAt) >= typingPauseThresholdMs
  //   - cpu sustained: cpuStressSince !== null AND (now - cpuStressSince) >= cpuStressDurationMs
  // PLUS the cooldown gate: lastStuckFireAt === null OR (now - lastStuckFireAt) >= STUCK_COOLDOWN_MS.
  //
  // Skipped silently when:
  //   - No keystrokeSource wired (lastKeystrokeAt stays null forever)
  //   - Typing gate closed (could falsely meet "pause >= 30s")
  //   - CPU gate closed (cpuStressSince stays null)
  // In those cases the typing or CPU signal is "unknown" -- comparing
  // unknown to a threshold is nonsense.
  function evaluateStuckOnProblem() {
    if (isFeatureGated()) return;
    // Typing signal is unknown if no source is wired OR the typing gate is
    // closed (no permission). Without a typing signal the "stuck"
    // determination can't be made -- return silently.
    if (!keystrokeSource) return;
    if (isTypingGated()) return;
    if (lastKeystrokeAt === null) return;
    // CPU signal is unknown if the CPU gate is closed OR the last probe failed.
    if (cpuStressSince === null) return;

    const t = now();
    const { typingPauseThresholdMs, cpuStressDurationMs } = getThresholds();
    const typingPaused = (t - lastKeystrokeAt) >= typingPauseThresholdMs;
    const cpuSustained = (t - cpuStressSince) >= cpuStressDurationMs;
    if (!typingPaused || !cpuSustained) return;

    // Cooldown: don't re-fire within 15 min of the last fire.
    if (lastStuckFireAt !== null && (t - lastStuckFireAt) < STUCK_COOLDOWN_MS) return;

    lastStuckFireAt = t;
    const payload = {
      at: t,
      cpuPressurePct,
      typingPauseMs: t - lastKeystrokeAt,
      cpuStressDurationMs: t - cpuStressSince,
    };
    for (const cb of stuckListeners) {
      try { cb(payload); } catch (err) {
        log("error", "system-monitor: onStuckOnProblem listener threw", err);
      }
    }
  }

  // -- Public API ---------------------------------------------------------

  function start() {
    if (cpuIntervalHandle || typingIntervalHandle) return;

    // CPU poll always runs (gates re-checked at tick time -> silent no-op
    // when off). The 30s cadence is forgiving on battery even when the
    // feature is disabled, since each tick is a single isFeatureGated() +
    // !isMac check before any spawn.
    cpuIntervalHandle = setIntervalFn(sampleCpuPressure, cpuPollMs);

    // Typing-poll + keystroke-source subscription only fire when a real
    // source is wired (v1 production: no source -> no work). Tests inject
    // a fake source to exercise the counting / decay path.
    if (keystrokeSource) {
      typingIntervalHandle = setIntervalFn(typingTick, typingPollMs);
      try {
        const off = keystrokeSource.subscribe(recordKeystroke);
        unsubscribeKeystroke = (typeof off === "function") ? off : null;
      } catch (err) {
        log("error", "system-monitor: keystrokeSource.subscribe threw", err);
        unsubscribeKeystroke = null;
      }
    }
  }

  function stop() {
    if (cpuIntervalHandle) {
      clearIntervalFn(cpuIntervalHandle);
      cpuIntervalHandle = null;
    }
    if (typingIntervalHandle) {
      clearIntervalFn(typingIntervalHandle);
      typingIntervalHandle = null;
    }
    if (typeof unsubscribeKeystroke === "function") {
      try { unsubscribeKeystroke(); } catch (err) {
        log("error", "system-monitor: keystrokeSource unsubscribe threw", err);
      }
      unsubscribeKeystroke = null;
    }
    // Reset window state so a subsequent start() doesn't carry stress
    // history from before the stop.
    cpuStressSince = null;
    // Keep cpuParseFailedLogged across stop/start (it's a session-wide
    // log-once flag; restart doesn't reset the operator's noise budget).
  }

  // Returns keystrokes/min over the rolling typingWindowMs window. Returns
  // null when:
  //   - No keystrokeSource is wired (v1 production), OR
  //   - Typing gate is closed (feature off or no Input Monitoring permission), OR
  //   - No keystrokes recorded yet.
  function getTypingRate() {
    if (!keystrokeSource) return null;
    if (isTypingGated()) return null;
    trimKeystrokes();
    if (keystrokeStamps.length === 0) return null;
    // Rate in keystrokes/min. Window is in ms, so multiply by 60_000.
    return (keystrokeStamps.length * 60000) / typingWindowMs;
  }

  // Returns last sampled CPU pressure (0-100) or null when:
  //   - Non-macOS platform, OR
  //   - Feature gate closed, OR
  //   - Last `top` parse failed.
  function getCpuPressure() {
    if (isCpuGated()) return null;
    return cpuPressurePct;
  }

  function onStuckOnProblem(callback) {
    if (typeof callback !== "function") {
      throw new Error("system-monitor: onStuckOnProblem callback must be a function");
    }
    stuckListeners.add(callback);
    return function unsubscribe() {
      stuckListeners.delete(callback);
    };
  }

  // Re-evaluate prefs on next tick. Detector reads prefs/permission at tick
  // time so reload() is mostly cosmetic, but it explicitly:
  //   - Resets cpuStressSince (the in-flight stress window -- a threshold
  //     change mid-window would otherwise compare a new threshold against
  //     a stale start time).
  //   - Does NOT reset lastStuckFireAt -- past stuck events are fatigue
  //     history, NOT something a user-pref toggle should wipe out.
  function reload() {
    cpuStressSince = null;
  }

  return {
    start,
    stop,
    getTypingRate,
    getCpuPressure,
    onStuckOnProblem,
    reload,
    // Test-only -- direct access to the internal tick fns + parser without
    // faking real timers. Same shape as workspace-detector.js __test.
    __test: {
      sampleCpuPressure,
      typingTick,
      evaluateStuckOnProblem,
      parseTopCpuLine,
      recordKeystroke,
      isFeatureGated,
      isTypingGated,
      isCpuGated,
      getInternalState: () => ({
        cpuPressurePct,
        cpuStressSince,
        lastKeystrokeAt,
        lastStuckFireAt,
        keystrokeStampCount: keystrokeStamps.length,
      }),
    },
  };
}

module.exports = initSystemMonitor;
module.exports.DEFAULT_TYPING_POLL_MS = DEFAULT_TYPING_POLL_MS;
module.exports.DEFAULT_CPU_POLL_MS = DEFAULT_CPU_POLL_MS;
module.exports.DEFAULT_TYPING_WINDOW_MS = DEFAULT_TYPING_WINDOW_MS;
module.exports.STUCK_COOLDOWN_MS = STUCK_COOLDOWN_MS;
module.exports.TOP_SPAWN_TIMEOUT_MS = TOP_SPAWN_TIMEOUT_MS;
module.exports.TOP_CPU_REGEX = TOP_CPU_REGEX;
