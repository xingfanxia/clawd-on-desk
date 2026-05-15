"use strict";

// src/workspace-detector.js — PAWPAL-2 Task 4.
//
// Polls the frontmost macOS app every DEFAULT_POLL_INTERVAL_MS (5000ms
// today) and routes the app name to a workspace category via a substring
// map in `prefs.workspaceAwareness.activeApp.categoryRules`. Emits
// debounced app-change events to subscribers. Pure signal source — does
// NOT trigger behaviors / nudges / mood changes. Later tasks (PAWPAL-2
// Task 7/8) wire the category into idle-variant selection and nudge
// biasing.
//
// Gating (silent no-op when any fails — no error logs, no probe calls):
//   - osPermission.isGranted("accessibility") === "granted"
//   - prefs.workspaceAwareness.enabled === true
//   - prefs.workspaceAwareness.activeApp.enabled === true
// Polling continues regardless — the gates apply at tick time, so flipping
// the user's prefs / OS permission resumes detection on the next tick
// without restart. `reload()` is provided for callers that want to force
// gate re-evaluation immediately after a prefs change.
//
// Debounce semantics:
//   The poll interval IS the debounce window (DEFAULT_DEBOUNCE_WINDOW_MS
//   equals DEFAULT_POLL_INTERVAL_MS by default) — a new app is only
//   confirmed when it's been observed in TWO consecutive ticks (≥ one
//   debounceWindowMs of stability). This prevents Cmd+Tab spam from
//   emitting a flood of change events.
//
//   State machine:
//     candidateApp     — last observed front-app name (changes every tick).
//     candidateSince   — timestamp when candidate first appeared.
//     confirmedApp     — last app we fired onAppChange for.
//     confirmedSince   — timestamp we promoted to confirmed.
//
//   On each tick:
//     - observed app === candidate AND (now - candidateSince) >= debounceWindowMs:
//         promote → if differs from confirmed, fire onAppChange.
//     - observed app !== candidate:
//         reset candidate to observed, candidateSince = now (no fire).
//
//   First-tick sequence (after start(), assuming defaults — 5000ms):
//     T=0:    observe "Code". candidate="Code", candidateSince=0. No fire.
//     T=5000: observe "Code". 5000-0 >= 5000 → confirm. Fire onAppChange.
//     T=10000: observe "Slack". reset candidate. No fire.
//     T=15000: observe "Slack". 15000-10000 >= 5000 → confirm. Fire.
//   So the FIRST confirmation arrives ~one debounceWindowMs after start();
//   subsequent ones take ~one debounceWindowMs of stability each. Matches
//   the plan's "≥5s stability" rule.
//
// Substring matching is case-insensitive with LONGEST-MATCH-WINS — so a
// rule set containing both "Code" and "Visual Studio Code" routes the
// app name "Visual Studio Code" to the LONGER (more specific) key. Without
// this, the shorter key would win arbitrarily (object key iteration order
// is insertion order in modern JS, but we don't want category routing to
// depend on prefs file ordering).

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEBOUNCE_WINDOW_MS = 5000;
const UNKNOWN_CATEGORY = "unknown";

function initWorkspaceDetector(ctx) {
  const c = ctx || {};
  if (typeof c.getPrefs !== "function") {
    throw new Error("workspace-detector: ctx.getPrefs is required");
  }
  if (!c.osPermission || typeof c.osPermission.isGranted !== "function") {
    throw new Error("workspace-detector: ctx.osPermission with isGranted() is required");
  }
  if (typeof c.captureFrontApp !== "function") {
    throw new Error("workspace-detector: ctx.captureFrontApp is required");
  }
  // setInterval/clearInterval must be passed as a pair. If a caller injects
  // a fake setInterval but forgets clearInterval (or vice versa), stop()
  // would mix real and fake timer plumbing — silently leaking the fake
  // timer in tests or trying to clearInterval a real handle with a stub.
  // Loud-fail at init is the project's standard for "you wired the ctx
  // wrong" — same shape as the three checks above.
  const hasSetInterval = typeof c.setInterval === "function";
  const hasClearInterval = typeof c.clearInterval === "function";
  if (hasSetInterval !== hasClearInterval) {
    throw new Error(
      "workspace-detector: ctx.setInterval and ctx.clearInterval must be provided together",
    );
  }

  const log = typeof c.log === "function" ? c.log : function noop() {};
  const now = typeof c.now === "function" ? c.now : () => Date.now();
  const setIntervalFn = hasSetInterval ? c.setInterval : setInterval;
  const clearIntervalFn = hasClearInterval ? c.clearInterval : clearInterval;
  // `Number.isFinite` already rejects non-numbers (unlike global `isFinite`,
  // which coerces), so the validated value is already a real number — no
  // Number() cast needed.
  const pollIntervalMs = Number.isFinite(c.pollIntervalMs) && c.pollIntervalMs > 0
    ? c.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const debounceWindowMs = Number.isFinite(c.debounceWindowMs) && c.debounceWindowMs > 0
    ? c.debounceWindowMs
    : DEFAULT_DEBOUNCE_WINDOW_MS;

  // Detector state.
  let intervalHandle = null;
  let candidateApp = null;
  let candidateSince = 0;
  let confirmedApp = null;
  let confirmedSince = 0;
  let confirmedCategory = null;
  // Subscribers receive { name, category, sinceMs } when the confirmed app
  // changes (or transitions from null → first confirmed app).
  const listeners = new Set();

  // Pre-computed sort key cache so the longest-match-wins sort doesn't
  // resort the rules map on every single tick. Invalidated on reload().
  let cachedRulesSnapshot = null;
  let cachedRulesSorted = null;

  function getPrefsSnapshot() {
    try {
      const p = c.getPrefs();
      return (p && typeof p === "object") ? p : null;
    } catch (err) {
      log("error", "workspace-detector: getPrefs threw", err);
      return null;
    }
  }

  function isGated() {
    // accessibility permission gate.
    try {
      const state = c.osPermission.isGranted("accessibility");
      if (state !== "granted") return true;
    } catch (err) {
      log("error", "workspace-detector: isGranted threw", err);
      return true;
    }
    // prefs gates.
    const prefs = getPrefsSnapshot();
    const wa = prefs && prefs.workspaceAwareness;
    if (!wa || !wa.enabled) return true;
    if (!wa.activeApp || !wa.activeApp.enabled) return true;
    return false;
  }

  // Returns the sorted-by-length-descending rules. Sort is cached behind
  // identity check on the rules object so repeated ticks pay the sort
  // cost only when prefs.workspaceAwareness.activeApp.categoryRules
  // actually changes (typical setSnapshot replaces the object).
  function getSortedRules() {
    const prefs = getPrefsSnapshot();
    const rules = prefs
      && prefs.workspaceAwareness
      && prefs.workspaceAwareness.activeApp
      && prefs.workspaceAwareness.activeApp.categoryRules;
    if (!rules || typeof rules !== "object") return [];
    if (rules === cachedRulesSnapshot && cachedRulesSorted) return cachedRulesSorted;
    cachedRulesSnapshot = rules;
    cachedRulesSorted = Object.keys(rules)
      .filter((k) => typeof k === "string" && k.length > 0)
      .sort((a, b) => b.length - a.length)
      .map((k) => ({ key: k, lower: k.toLowerCase(), category: rules[k] }));
    return cachedRulesSorted;
  }

  // Case-insensitive substring match with longest-match-wins. Returns the
  // category string or UNKNOWN_CATEGORY when no rule matches.
  function categorize(appName) {
    if (typeof appName !== "string" || !appName) return UNKNOWN_CATEGORY;
    const haystack = appName.toLowerCase();
    const rules = getSortedRules();
    for (const rule of rules) {
      if (haystack.indexOf(rule.lower) !== -1) {
        return rule.category;
      }
    }
    return UNKNOWN_CATEGORY;
  }

  function emitChange(payload) {
    for (const cb of listeners) {
      try { cb(payload); } catch (err) {
        log("error", "workspace-detector: onAppChange listener threw", err);
      }
    }
  }

  function processObservation(appName) {
    const t = now();
    if (typeof appName !== "string" || !appName) return;

    if (appName !== candidateApp) {
      // New candidate — start its debounce window.
      candidateApp = appName;
      candidateSince = t;
      return;
    }

    // Same as candidate. Has it been stable long enough?
    if (t - candidateSince < debounceWindowMs) return;

    // Stable. Promote to confirmed if it differs from the prior confirmed.
    if (appName === confirmedApp) return;
    confirmedApp = appName;
    confirmedSince = t;
    confirmedCategory = categorize(appName);
    emitChange({
      name: confirmedApp,
      category: confirmedCategory,
      sinceMs: confirmedSince,
    });
  }

  function tick() {
    if (isGated()) return;
    try {
      c.captureFrontApp((name) => {
        try {
          // Defensive: detector may have been stopped between schedule and
          // callback; dropping late captures keeps state consistent.
          if (!intervalHandle) return;
          processObservation(name);
        } catch (err) {
          // processObservation is loop-internal and side-effect-light today,
          // but the captureFrontApp callback is a hard async boundary — an
          // unhandled throw here would propagate out of the host's exec
          // callback into the platform plumbing. Mirror the defensive
          // try/catch around `emitChange` so the detector can never crash
          // the host process via a future change to processObservation.
          log("error", "workspace-detector: processObservation failed", err);
        }
      });
    } catch (err) {
      log("error", "workspace-detector: captureFrontApp threw", err);
    }
  }

  function start() {
    if (intervalHandle) return;
    intervalHandle = setIntervalFn(tick, pollIntervalMs);
  }

  function stop() {
    if (!intervalHandle) return;
    clearIntervalFn(intervalHandle);
    intervalHandle = null;
    // Reset debounce state so a subsequent start() doesn't promote a stale
    // candidate from the previous run.
    candidateApp = null;
    candidateSince = 0;
  }

  function getCurrentApp() {
    if (!confirmedApp) return null;
    return {
      name: confirmedApp,
      category: confirmedCategory,
      sinceMs: confirmedSince,
    };
  }

  function onAppChange(callback) {
    if (typeof callback !== "function") {
      throw new Error("workspace-detector: onAppChange callback must be a function");
    }
    listeners.add(callback);
    return function unsubscribe() {
      listeners.delete(callback);
    };
  }

  // Re-evaluate prefs on next tick. The detector reads prefs/permission at
  // tick time, so reload() is mostly a hint — it explicitly resets the
  // sort cache and clears the in-flight debounce candidate so a stale app
  // observed under the old config doesn't survive a rules change.
  function reload() {
    cachedRulesSnapshot = null;
    cachedRulesSorted = null;
    candidateApp = null;
    candidateSince = 0;
  }

  return {
    start,
    stop,
    getCurrentApp,
    onAppChange,
    reload,
    // Test-only — exposed so tests can drive a single tick without faking
    // setInterval (cleaner than measuring side effects of a real timer).
    __test: {
      tick,
      isGated,
      categorize,
      processObservation,
    },
  };
}

module.exports = initWorkspaceDetector;
module.exports.UNKNOWN_CATEGORY = UNKNOWN_CATEGORY;
module.exports.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
module.exports.DEFAULT_DEBOUNCE_WINDOW_MS = DEFAULT_DEBOUNCE_WINDOW_MS;
