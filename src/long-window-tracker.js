"use strict";

// src/long-window-tracker.js — PAWPAL-2 Task 6.
//
// Tracks how long the user has stayed on the same app+window and fires
// `onLongWindow({ app, durationMs })` once that duration crosses
// `prefs.workspaceAwareness.longWindow.sameWindowThresholdMs` (default
// 5_400_000 ms = 90 min). Pure signal source — does NOT trigger any
// behaviors / nudges / state changes here; Task 7 wires onLongWindow into
// the nudge biasing layer ("you've been on Slack for 2 hours, want a
// break?").
//
// Source of truth for "what app are we on?" is the workspace-detector
// (Task 4) — we subscribe to its `onAppChange(cb)` and reset our internal
// `sameAppSince` timestamp on every confirmed change. Because the detector
// only fires onAppChange when an app has been observed for ≥
// debounceWindowMs (5s today), our "same app" boundary is naturally at
// confirmed-app-change granularity. We don't try to track individual
// windows within an app — Electron / macOS don't expose cross-app window
// transitions without a native accessibility module, so v1 ships
// app-granularity. The API uses the plan's `getCurrentWindowDurationMs()`
// naming for forward compatibility with Task 7's nudge surface.
//
// Why timestamp comparison instead of setTimeout:
//   The horizons here are LONG (90 min default, up to multiple hours).
//   `setTimeout(fn, 90*60_000)` is unreliable across system sleep / wake
//   on macOS — the timer pauses while the laptop is asleep and fires N
//   minutes late on resume, after the wall clock has already advanced
//   past the intended firing time. Our solution: arm a fast tick
//   (DEFAULT_TICK_INTERVAL_MS = 60s) and compare `now() - sameAppSince`
//   each tick. After a wake from sleep the next tick observes the full
//   elapsed delta and fires immediately. The 60s cadence is the maximum
//   firing lag, which is negligible relative to the 90-min threshold.
//
// Gating (silent no-op when any fails — no error logs, no listener
// invocations, no tick work):
//   - prefs.workspaceAwareness.enabled === true
//   - prefs.workspaceAwareness.longWindow.enabled === true
//   - workspaceDetector emits at least one onAppChange (so we have an app
//     to attribute the duration to)
// When the gate flips off mid-flight, `sameAppSince` is preserved — the
// next tick simply skips the fire. When the gate flips back on while
// still on the same app, we resume from the original sameAppSince (so a
// brief settings toggle doesn't reset the user's 89-minute-deep session).
//
// Cooldown:
//   DEFAULT_FIRE_COOLDOWN_MS = 30 min between fires. The cooldown clock
//   starts at lastFireAt, NOT at sameAppSince. So if the user is on the
//   same window for 90 min and we fire at T=90, the next allowable fire
//   is T=120 (30 min after the fire) — assuming they're STILL on the same
//   window. As soon as the app changes, sameAppSince resets and the user
//   must accumulate another 90 min on the new app before any fire can
//   happen. The cooldown only matters when the user stays on one app for
//   multiple multiples of the threshold (e.g., a 3-hour Slack session
//   would fire at T=90, then T=120, then T=180 — once per cooldown
//   window).
//
// First-fire semantics after start():
//   start() does NOT immediately have an app — it waits for the
//   workspaceDetector to emit its first onAppChange (which itself takes
//   ~debounceWindowMs after the detector starts). Once the first
//   confirmation arrives, sameAppSince is set. The first fire happens
//   when (now - sameAppSince) >= sameWindowThresholdMs, i.e., 90 min
//   AFTER the first confirmation, not 90 min after start(). Callers
//   should not expect a fire at exactly start()+90min.

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_FIRE_COOLDOWN_MS = 30 * 60_000;

function initLongWindowTracker(ctx) {
  const c = ctx || {};
  if (typeof c.getPrefs !== "function") {
    throw new Error("long-window-tracker: ctx.getPrefs is required");
  }
  if (!c.workspaceDetector || typeof c.workspaceDetector.onAppChange !== "function") {
    throw new Error(
      "long-window-tracker: ctx.workspaceDetector with onAppChange() is required",
    );
  }
  // Pair-check timer injection (matches workspace-detector.js / system-monitor.js).
  // Mixing real and fake plumbing silently leaks timers in tests or attempts
  // to clearInterval a real handle with a stub.
  const hasSetInterval = typeof c.setInterval === "function";
  const hasClearInterval = typeof c.clearInterval === "function";
  if (hasSetInterval !== hasClearInterval) {
    throw new Error(
      "long-window-tracker: ctx.setInterval and ctx.clearInterval must be provided together",
    );
  }

  const log = typeof c.log === "function" ? c.log : function noop() {};
  const now = typeof c.now === "function" ? c.now : () => Date.now();
  const setIntervalFn = hasSetInterval ? c.setInterval : setInterval;
  const clearIntervalFn = hasClearInterval ? c.clearInterval : clearInterval;
  const tickIntervalMs = Number.isFinite(c.tickIntervalMs) && c.tickIntervalMs > 0
    ? c.tickIntervalMs
    : DEFAULT_TICK_INTERVAL_MS;
  const fireCooldownMs = Number.isFinite(c.fireCooldownMs) && c.fireCooldownMs > 0
    ? c.fireCooldownMs
    : DEFAULT_FIRE_COOLDOWN_MS;

  // -- State --------------------------------------------------------------
  let intervalHandle = null;
  let unsubscribeAppChange = null;
  // The currently-tracked app (last confirmed app from workspaceDetector).
  // Carries the full payload shape from Task 4: { name, category, sinceMs }.
  let currentApp = null;
  // Timestamp when we started counting the CURRENT same-window window. Updated
  // on every onAppChange. null until the first onAppChange arrives.
  let sameAppSince = null;
  // Cooldown anchor: last fire timestamp. null until first fire. Persists
  // across reload() — see comment in reload() for rationale.
  let lastFireAt = null;
  const listeners = new Set();

  // -- Helpers ------------------------------------------------------------

  function getPrefsSnapshot() {
    try {
      const p = c.getPrefs();
      return (p && typeof p === "object") ? p : null;
    } catch (err) {
      log("error", "long-window-tracker: getPrefs threw", err);
      return null;
    }
  }

  function getSameWindowThresholdMs() {
    const prefs = getPrefsSnapshot();
    const lw = prefs && prefs.workspaceAwareness && prefs.workspaceAwareness.longWindow;
    if (lw && Number.isFinite(lw.sameWindowThresholdMs) && lw.sameWindowThresholdMs > 0) {
      return lw.sameWindowThresholdMs;
    }
    return 5_400_000; // 90 min default — mirrors prefs schema default
  }

  // Feature gate. Returns true to no-op.
  function isGated() {
    const prefs = getPrefsSnapshot();
    const wa = prefs && prefs.workspaceAwareness;
    if (!wa || !wa.enabled) return true;
    if (!wa.longWindow || !wa.longWindow.enabled) return true;
    return false;
  }

  // onAppChange callback. Resets the same-app window on every confirmed change.
  // This is the boundary that ENDs the previous window (regardless of whether
  // it was about to fire) and STARTS a fresh one. We do NOT preserve any
  // cross-app state — different apps are independent fatigue accumulators.
  function handleAppChange(appInfo) {
    if (!appInfo || typeof appInfo !== "object" || typeof appInfo.name !== "string") {
      return;
    }
    currentApp = appInfo;
    sameAppSince = now();
    // Note: lastFireAt is NOT reset here. If we fired 10 min ago for Slack
    // and the user switches to VSCode, the next eligible fire is bounded by
    // BOTH (a) reaching threshold on VSCode AND (b) clearing the cooldown
    // measured from the last fire. The cooldown is a global noise budget
    // across the whole user experience, not per-app.
  }

  function emitLongWindow(payload) {
    for (const cb of listeners) {
      try { cb(payload); } catch (err) {
        log("error", "long-window-tracker: onLongWindow listener threw", err);
      }
    }
  }

  // Periodic check. Compares timestamps (not setTimeout) so sleep/wake
  // doesn't drift — see header comment.
  function tick() {
    if (isGated()) return;
    if (sameAppSince === null || currentApp === null) return;
    const t = now();
    const durationMs = t - sameAppSince;
    if (durationMs < getSameWindowThresholdMs()) return;
    // Cooldown: don't re-fire within fireCooldownMs of the last fire.
    if (lastFireAt !== null && (t - lastFireAt) < fireCooldownMs) return;
    lastFireAt = t;
    emitLongWindow({ app: currentApp, durationMs });
  }

  // -- Public API ---------------------------------------------------------

  function start() {
    if (intervalHandle) return;
    // Subscribe FIRST. If onAppChange throws, we bail BEFORE arming the
    // tick interval — otherwise the tick would fire forever with no app
    // ever attributed (sameAppSince stays null, all ticks no-op). This is
    // the Task 5 review lesson: half-wired subscribe leaks a pointless
    // interval that exists only to do nothing.
    try {
      const off = c.workspaceDetector.onAppChange(handleAppChange);
      if (typeof off !== "function") {
        log("error", "long-window-tracker: onAppChange did not return an unsubscribe fn",
          new Error("invalid onAppChange contract"));
        return;
      }
      unsubscribeAppChange = off;
    } catch (err) {
      log("error", "long-window-tracker: workspaceDetector.onAppChange threw", err);
      unsubscribeAppChange = null;
      return;
    }
    intervalHandle = setIntervalFn(tick, tickIntervalMs);
  }

  function stop() {
    if (intervalHandle) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
    if (typeof unsubscribeAppChange === "function") {
      try { unsubscribeAppChange(); } catch (err) {
        log("error", "long-window-tracker: unsubscribe threw", err);
      }
      unsubscribeAppChange = null;
    }
    // Reset cycle-local state so a subsequent start() starts clean. Without
    // this, a quick stop()→start() cycle would treat the user as still
    // sitting on whatever app was current at stop time — even though the
    // restart should be a fresh observation. Lesson from Task 5's review.
    // Keep lastFireAt across stop/start — it's session-wide fatigue history,
    // intentionally outliving any single detector cycle (same rationale as
    // system-monitor's lastStuckFireAt).
    currentApp = null;
    sameAppSince = null;
  }

  // Returns ms since the current app was confirmed, or null when:
  //   - tracker not started yet (no subscription / no first onAppChange), OR
  //   - feature gated off (workspaceAwareness or longWindow disabled), OR
  //   - workspaceDetector hasn't emitted its first onAppChange yet (the
  //     detector itself takes ~debounceWindowMs to confirm the front app).
  // Callers should treat null as "unknown duration", not zero.
  function getCurrentWindowDurationMs() {
    if (isGated()) return null;
    if (sameAppSince === null) return null;
    return now() - sameAppSince;
  }

  function onLongWindow(callback) {
    if (typeof callback !== "function") {
      throw new Error("long-window-tracker: onLongWindow callback must be a function");
    }
    listeners.add(callback);
    return function unsubscribe() {
      listeners.delete(callback);
    };
  }

  // Re-evaluate prefs on next tick. Reads happen at tick time so reload() is
  // largely cosmetic, but we keep it for parity with workspace-detector /
  // system-monitor. Crucially does NOT reset lastFireAt — past fires are
  // fatigue history, NOT something a user-pref toggle should wipe out
  // (mirrors system-monitor's reload() contract). Also does NOT reset
  // sameAppSince — the current same-window window survives a reload,
  // matching the principle that reload is "re-read config" not "restart".
  function reload() {
    // Intentional no-op for now. State reads are tick-time, prefs are
    // read fresh on each tick. The hook exists so callers (main.js subscribe
    // to workspaceAwareness changes) have a uniform shape across all three
    // detectors.
  }

  return {
    start,
    stop,
    getCurrentWindowDurationMs,
    onLongWindow,
    reload,
    // Test-only — direct access to internals without needing real timers /
    // mocked workspaceDetector ticks beyond what the tests already inject.
    __test: {
      tick,
      isGated,
      handleAppChange,
      getInternalState: () => ({
        currentApp,
        sameAppSince,
        lastFireAt,
        listenerCount: listeners.size,
        hasInterval: intervalHandle !== null,
        hasUnsubscribe: typeof unsubscribeAppChange === "function",
      }),
    },
  };
}

module.exports = initLongWindowTracker;
module.exports.DEFAULT_TICK_INTERVAL_MS = DEFAULT_TICK_INTERVAL_MS;
module.exports.DEFAULT_FIRE_COOLDOWN_MS = DEFAULT_FIRE_COOLDOWN_MS;
