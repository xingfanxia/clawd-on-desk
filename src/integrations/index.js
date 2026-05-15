"use strict";

// src/integrations/index.js — PAWPAL-3 integrations registry.
//
// Owns the lifecycle of three macOS-native integration sources:
//   - music         (Apple Music Now Playing detector)
//   - battery       (pmset -g batt poller)
//   - systemEvents  (Electron powerMonitor: lock/unlock/AC)
//
// Same factory + injection pattern as the PAWPAL-2 detectors
// (workspace-detector, system-monitor, long-window-tracker). Each sub-
// detector exposes an event-emitter surface that nudges.js subscribes to
// via ctx.subscribeIntegration (wired in main.js).
//
// Sub-detectors are constructed unconditionally (no timers, no I/O at
// construction time). Each gates itself by its `enabled` pref at start;
// the registry layers the master `integrations.enabled` flag on top so a
// single off-switch in Settings tears all three down.

const { createMusicDetector } = require("./music");
const { createBatteryMonitor } = require("./battery");
const { createSystemEventsBridge } = require("./system-events");

function createIntegrationsRegistry(ctx) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("integrations: createIntegrationsRegistry requires a ctx object");
  }
  const log = typeof ctx.log === "function" ? ctx.log : () => {};

  const music = createMusicDetector({
    runFile: ctx.runFile,
    log,
    isMac: !!ctx.isMac,
  });
  const battery = createBatteryMonitor({
    runFile: ctx.runFile,
    log,
    isMac: !!ctx.isMac,
  });
  const systemEvents = createSystemEventsBridge({
    powerMonitor: ctx.powerMonitor,
    log,
    isMac: !!ctx.isMac,
  });

  let started = false;

  function readPrefs() {
    const p = (typeof ctx.getPrefs === "function" ? ctx.getPrefs() : null) || {};
    return p.integrations || {};
  }
  function masterEnabled() { return !!readPrefs().enabled; }
  function subEnabled(sourceId) {
    const sub = readPrefs()[sourceId];
    return !!(sub && sub.enabled);
  }

  function start() {
    if (started) return;
    started = true;
    const master = masterEnabled();
    if (master && subEnabled("music")) {
      try { music.start(readPrefs().music || {}); }
      catch (err) { log("error", "integrations: music.start failed", err); }
    }
    if (master && subEnabled("battery")) {
      try { battery.start(readPrefs().battery || {}); }
      catch (err) { log("error", "integrations: battery.start failed", err); }
    }
    if (master && subEnabled("systemEvents")) {
      try { systemEvents.start(readPrefs().systemEvents || {}); }
      catch (err) { log("error", "integrations: systemEvents.start failed", err); }
    }
  }

  // stop({ keepLatch }) — pass-through flag for detectors that maintain
  // edge-trigger state across stop/start cycles. battery.js uses this to
  // preserve `firedSinceEnteringLow` so toggling an unrelated sub-feature
  // in Settings doesn't re-fire the already-acknowledged batteryLow nudge.
  // music + systemEvents are stateless w.r.t. their last-fired latch
  // (music re-emits on the NEXT track-boundary; systemEvents has no
  // cooldown state) so the flag is a no-op for them.
  function stop(opts) {
    if (!started) return;
    started = false;
    for (const [name, detector] of [
      ["systemEvents", systemEvents],
      ["battery", battery],
      ["music", music],
    ]) {
      try { detector.stop(opts); }
      catch (err) { log("error", `integrations: ${name}.stop failed`, err); }
    }
  }

  function reload() {
    // Preserve battery latch across settings-driven reloads — see comment
    // on stop().
    stop({ keepLatch: true });
    start();
  }

  return {
    start, stop, reload,
    music, battery, systemEvents,
    __test: { isStarted: () => started, readPrefs, masterEnabled, subEnabled },
  };
}

module.exports = { createIntegrationsRegistry };
