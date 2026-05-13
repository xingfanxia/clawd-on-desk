"use strict";

// ── OS-level permission gate (Accessibility / Input Monitoring) ──
//
// PAWPAL-2 Task 3. Single source of truth for OS-permission state. Workspace-
// awareness detectors (active-app, system monitor, long-window) all share this
// module so they can:
//
//   1. Check `isGranted(kind)` synchronously before polling expensive APIs.
//   2. Call `promptGrant(kind)` to open the relevant System Settings pane
//      (deep-link via `shell.openExternal`) when the user opts in.
//   3. Subscribe via `subscribe(kind, cb)` so they get notified the moment the
//      user grants the permission in System Settings (no app relaunch needed).
//
// Detection mechanism (macOS):
//   - Accessibility: probe `osascript -e 'tell application "System Events" to
//     get name of first application process whose frontmost is true'` via
//     execFile (never the shell-spawning variant). Granted → returns the app
//     name. Denied → stderr contains `not authorized` / `Application isn't
//     running`. Same probe `permission.js#captureFrontApp` already uses, so
//     behavior matches everywhere.
//   - Input Monitoring: stubbed `"unknown"` in v1. Task 5 will replace with a
//     sentinel-keystroke detector. Detectors must tolerate the `"unknown"`
//     state (no false positive, no crash).
//
// Linux / Windows: hardcoded `"granted"`. No equivalent OS gate. Detectors
// branch off the higher-level prefs to no-op unsupported features on those
// platforms — this module just answers truthfully.
//
// Why factory + injection: `execFile`, `shell`, and `app.on(focus/blur)` are
// injected so tests can stub them without spawning real osascript or
// requiring an Electron process. The macOS default arguments fall back to
// real `child_process.execFile` when consumers don't override.
//
// Lifecycle: subscribe() returns an unsubscribe function. The polling
// interval only ticks while the app is foreground — when blurred, the timer
// is cleared and re-armed on next focus. This keeps battery quiet when the
// user is using another app.

const KINDS = ["accessibility", "inputMonitoring"];

// macOS System Settings deep-link URLs (whitelist). Anything outside this set
// is rejected by `os-permission:open-system-settings`. Do NOT broaden — the
// existing `settings:open-external` handler is also tight; we keep the
// security boundary explicit.
const SYSTEM_SETTINGS_URLS = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

// How long the osascript probe is allowed to block. 500ms keeps the main
// process responsive when the user hasn't granted yet (denied probes can
// hang briefly on first call).
const OSASCRIPT_TIMEOUT_MS = 500;

// Re-poll cadence inside `subscribe()`. 5s matches the spec.
const POLL_INTERVAL_MS = 5000;

// 30s = spec'd ceiling for the "user finished granting" window after
// shell.openExternal opens System Settings; foreground signal usually
// resolves the wait much sooner.
const PROMPT_REPOLL_DELAY_MS = 30000;

const DEFAULT_EXEC_FILE = require("child_process").execFile;

function isKindAllowed(kind) {
  return typeof kind === "string" && KINDS.indexOf(kind) !== -1;
}

// Pure detector for the macOS osascript probe. Returns Promise<"granted"|"denied">.
// `runFn` is injectable so tests can stub it without spawning a real
// osascript subprocess. `onError` (optional) is called when the failure
// looks like a real fault (timeout, missing binary, unknown stderr) rather
// than the user-never-granted case — lets operators distinguish the two.
function probeAccessibilityMac(runFn, onError) {
  return new Promise((resolve) => {
    runFn(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: OSASCRIPT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          // macOS accessibility-denied markers. `not authorized` is the
          // documented string; `(-1719)` and `Application isn't running` show
          // up on older Sequoia / Sonoma builds.
          const errText = String((stderr || "") + " " + (err.message || ""));
          const isPermissionDenial =
            /not authorized|not allowed assistive access|isn't running|-1719|-1743/i.test(errText);
          if (!isPermissionDenial && typeof onError === "function") {
            // Unknown failure (timeout, missing binary, etc.). Detector still
            // fails safe to "denied", but surface the underlying cause so
            // operators can distinguish from "user never granted".
            try { onError("probeAccessibilityMac:unexpected", err); } catch {}
          }
          resolve("denied");
          return;
        }
        const text = String(stdout || "").trim();
        resolve(text ? "granted" : "denied");
      },
    );
  });
}

function createOsPermission(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const isMac = platform === "darwin";
  // DEFAULT_EXEC_FILE is the stdlib child_process.execFile (NOT exec). Safe
  // here because the only call site uses static "osascript" + a static argv,
  // never user input — no shell metacharacter risk. `o.execFile` lets tests
  // inject a stub without spawning a real subprocess.
  const runFn = o.execFile || DEFAULT_EXEC_FILE;
  // shell.openExternal — required to open System Settings deep-link on macOS.
  // Tests stub this. Non-macOS callers never reach `shell` so it's safe to
  // leave it nullable.
  const shell = o.shell || null;
  const onError = typeof o.onError === "function" ? o.onError : null;
  // Test hook: override the re-poll delay so tests can exercise the timeout
  // path without waiting 30s. Production code never sets this.
  const promptRepollDelayMs = Number.isFinite(o.promptRepollDelayMs)
    ? Math.max(0, Number(o.promptRepollDelayMs))
    : PROMPT_REPOLL_DELAY_MS;
  // Foreground tracker — tests can inject; default uses
  // app.on("browser-window-focus"/"browser-window-blur").
  // Defaults to `true` (foreground) when no tracker is supplied so a plain
  // require + isGranted() works in non-Electron contexts (tests, CLI use).
  const foregroundTracker = o.foregroundTracker || null;
  let foreground = foregroundTracker ? !!foregroundTracker.isForeground() : true;
  let unsubscribeForeground = null;

  // Cached permission state per kind. `"unknown"` until first probe completes.
  // `isGranted()` returns the cache synchronously; `refresh()` populates it.
  const cache = {
    accessibility: isMac ? "unknown" : "granted",
    inputMonitoring: isMac ? "unknown" : "granted",
  };

  // Subscriber callbacks per kind. Each entry: { callback, intervalId }.
  const subscribers = new Map();
  for (const kind of KINDS) subscribers.set(kind, []);

  function logError(context, err) {
    if (onError) {
      // Host's onError must never throw, but defensive catch keeps subscriber
      // notification (and the surrounding probe lifecycle) from being
      // derailed by a buggy host handler. Defense in depth, not silent-failure.
      try { onError(context, err); } catch {}
    } else if (err) {
      // No host handler — surface to console so the failure is visible.
      // eslint-disable-next-line no-console
      console.warn(`[os-permission] ${context}:`, (err && err.message) || err);
    }
  }

  // Run the platform-appropriate probe. Updates cache, fires subscribers when
  // the value actually changes. Returns Promise<state>.
  async function refresh(kind) {
    if (!isKindAllowed(kind)) {
      throw new Error(`os-permission: invalid kind "${String(kind)}"`);
    }
    if (!isMac) {
      cache[kind] = "granted";
      return "granted";
    }
    let next;
    if (kind === "accessibility") {
      try {
        next = await probeAccessibilityMac(runFn, logError);
      } catch (err) {
        logError("probe accessibility", err);
        next = "denied";
      }
    } else {
      // inputMonitoring — Task 5 will replace with a real probe. v1 stays
      // `"unknown"` so the detector knows the gate hasn't been checked yet
      // and can prompt the user when it tries to attach a keyboard listener.
      next = cache[kind];
    }
    const prev = cache[kind];
    cache[kind] = next;
    if (next !== prev) notifySubscribers(kind, next);
    return next;
  }

  function notifySubscribers(kind, state) {
    const list = subscribers.get(kind) || [];
    for (const entry of list) {
      try { entry.callback(state); } catch (err) { logError(`subscribe-callback:${kind}`, err); }
    }
  }

  function isGranted(kind) {
    if (!isKindAllowed(kind)) return "denied";
    return cache[kind];
  }

  // Open the System Settings pane for `kind` via `shell.openExternal`. Returns
  // Promise<boolean> — true if the link was opened, false if rejected.
  async function openSystemSettings(kind) {
    if (!isKindAllowed(kind)) return false;
    if (!isMac) return false;
    const url = SYSTEM_SETTINGS_URLS[kind];
    if (!url) return false;
    if (!shell || typeof shell.openExternal !== "function") {
      logError("openSystemSettings", new Error("shell.openExternal unavailable"));
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      logError(`openSystemSettings:${kind}`, err);
      return false;
    }
  }

  // Open deep-link, wait for foreground (or timeout), re-probe, resolve.
  // The modal/UX layer lives in the Settings UI (Task 10) — this module
  // intentionally stays UX-free.
  async function promptGrant(kind) {
    if (!isKindAllowed(kind)) return "denied";
    if (!isMac) {
      cache[kind] = "granted";
      return "granted";
    }
    const opened = await openSystemSettings(kind);
    if (!opened) return cache[kind] === "granted" ? "granted" : "denied";

    // Wait the documented re-poll window OR the next foreground event,
    // whichever comes first. Foreground = user has finished in Settings and
    // come back to the app.
    await waitForForegroundOrTimeout(promptRepollDelayMs);
    await refresh(kind);
    return cache[kind] === "granted" ? "granted" : "denied";
  }

  function waitForForegroundOrTimeout(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      // Hoist `off` so the timeout path can release the foreground listener.
      // Without this, repeated timeout-only promptGrant cycles leak one
      // listener each into foregroundTracker.
      let off = null;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof off === "function") off();
        resolve();
      }, timeoutMs);
      if (foregroundTracker && typeof foregroundTracker.onForeground === "function") {
        off = foregroundTracker.onForeground(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (typeof off === "function") off();
          resolve();
        });
      }
    });
  }

  // Subscribe to permission-state changes. Polling only runs while the app is
  // foreground — backgrounded apps idle the interval to keep battery quiet.
  function subscribe(kind, callback) {
    if (!isKindAllowed(kind)) {
      throw new Error(`os-permission: invalid kind "${String(kind)}"`);
    }
    if (typeof callback !== "function") {
      throw new Error("os-permission: subscribe callback must be a function");
    }
    const entry = { callback, intervalId: null };
    subscribers.get(kind).push(entry);

    // Initial probe so the subscriber gets an up-to-date value soon after
    // attaching (don't make every consumer call refresh manually).
    refresh(kind).catch((err) => logError(`subscribe-initial-refresh:${kind}`, err));

    function startInterval() {
      if (entry.intervalId) return;
      entry.intervalId = setInterval(() => {
        refresh(kind).catch((err) => logError(`subscribe-poll:${kind}`, err));
      }, POLL_INTERVAL_MS);
    }
    function stopInterval() {
      if (!entry.intervalId) return;
      clearInterval(entry.intervalId);
      entry.intervalId = null;
    }

    if (foreground) startInterval();

    // Stash the start/stop helpers so the central foreground broadcaster
    // below can fan them out on focus/blur.
    entry.startInterval = startInterval;
    entry.stopInterval = stopInterval;

    return function unsubscribe() {
      stopInterval();
      const list = subscribers.get(kind);
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  // Wire up the single foreground tracker → fan out to all subscribers.
  // (Done once per factory instance so we don't pile up listeners on
  // app focus/blur — tests can re-create the factory cleanly.)
  if (foregroundTracker) {
    if (typeof foregroundTracker.onForeground === "function") {
      const offOn = foregroundTracker.onForeground(() => {
        foreground = true;
        for (const kind of KINDS) {
          for (const entry of subscribers.get(kind)) {
            entry.startInterval && entry.startInterval();
          }
        }
      });
      const offOff = typeof foregroundTracker.onBackground === "function"
        ? foregroundTracker.onBackground(() => {
            foreground = false;
            for (const kind of KINDS) {
              for (const entry of subscribers.get(kind)) {
                entry.stopInterval && entry.stopInterval();
              }
            }
          })
        : null;
      unsubscribeForeground = () => {
        try { typeof offOn === "function" && offOn(); } catch {}
        try { typeof offOff === "function" && offOff(); } catch {}
      };
    }
  }

  function dispose() {
    for (const kind of KINDS) {
      for (const entry of subscribers.get(kind)) {
        if (entry.intervalId) clearInterval(entry.intervalId);
      }
      subscribers.set(kind, []);
    }
    if (typeof unsubscribeForeground === "function") {
      try { unsubscribeForeground(); } catch {}
      unsubscribeForeground = null;
    }
  }

  return {
    isGranted,
    promptGrant,
    subscribe,
    refresh,
    openSystemSettings,
    dispose,
  };
}

// Build an Electron-app-aware foreground tracker. Used by `main.js` when
// wiring this module into the live runtime. Tests typically inject a stub
// instead.
function makeElectronForegroundTracker(app) {
  if (!app || typeof app.on !== "function") return null;
  const focusListeners = new Set();
  const blurListeners = new Set();
  let cachedForeground = true;
  app.on("browser-window-focus", () => {
    cachedForeground = true;
    for (const cb of focusListeners) {
      try { cb(); } catch {}
    }
  });
  app.on("browser-window-blur", () => {
    // browser-window-blur fires when ANY window loses focus, including when
    // focus transfers between two of our own windows. Use a microtask to let
    // a focus event for the new window arrive first; only flip to background
    // if the app is still blurred after that.
    setImmediate(() => {
      // Defensive: during app teardown / app.quit(), require("electron") or
      // BrowserWindow.getFocusedWindow() can throw or return null abruptly.
      // Treat any failure as "no focused window" so the background path
      // still runs (which is the safe default during quit).
      let stillFocused = null;
      try {
        const electron = require("electron");
        stillFocused = electron.BrowserWindow && electron.BrowserWindow.getFocusedWindow();
      } catch { /* app teardown — treat as background */ }
      if (stillFocused) return;
      cachedForeground = false;
      for (const cb of blurListeners) {
        try { cb(); } catch {}
      }
    });
  });
  return {
    isForeground: () => cachedForeground,
    onForeground: (cb) => {
      focusListeners.add(cb);
      return () => focusListeners.delete(cb);
    },
    onBackground: (cb) => {
      blurListeners.add(cb);
      return () => blurListeners.delete(cb);
    },
  };
}

module.exports = {
  createOsPermission,
  makeElectronForegroundTracker,
  KINDS,
  SYSTEM_SETTINGS_URLS,
  // Test-only — exposed for direct unit tests of the pure probe + URL-whitelist
  // logic without standing up the factory.
  __test: {
    probeAccessibilityMac,
    isKindAllowed,
    OSASCRIPT_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    PROMPT_REPOLL_DELAY_MS,
  },
};
