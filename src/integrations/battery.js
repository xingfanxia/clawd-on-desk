"use strict";

// src/integrations/battery.js — macOS battery monitor (PAWPAL-3).
//
// Polls `pmset -g batt` every BATTERY_POLL_MS and emits "battery.low" when:
//   (a) the system is running on battery (not AC),
//   (b) the remaining percentage drops below the configured threshold,
//   (c) we haven't already fired since entering the low state (edge-trigger
//       only — clears when battery is plugged back in or rises above threshold)
//
// Edge-trigger semantics: this is the "your cat carries the battery icon"
// nudge. The user gets the reminder ONCE per discharge cycle through the
// threshold. If they ignore it and the battery keeps dropping, we don't
// keep nudging — `longSit` and `longWindowBreak` already cover the "you've
// been at the screen too long" arc.
//
// Non-mac → silent no-op (the regex parser is mac-specific).

const BATTERY_POLL_MS = 60_000;

// Parse the output of `pmset -g batt`. Apple's format (as of macOS 14):
//   Now drawing from 'Battery Power'
//    -InternalBattery-0 (id=...)\t72%; discharging; 4:13 remaining present: true
// Or:
//   Now drawing from 'AC Power'
//    -InternalBattery-0 (id=...)\t100%; charged; 0:00 remaining present: true
//
// We only need: source (battery vs AC) and percentage.
function parseBatteryOutput(stdout) {
  if (typeof stdout !== "string") return null;
  const sourceMatch = stdout.match(/drawing from '([^']+)'/);
  const pctMatch = stdout.match(/(\d+)%/);
  if (!sourceMatch || !pctMatch) return null;
  const onBattery = /Battery Power/i.test(sourceMatch[1]);
  const pct = Number(pctMatch[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { onBattery, pct };
}

function createBatteryMonitor(deps) {
  const runFile = deps && typeof deps.runFile === "function" ? deps.runFile : null;
  const log = deps && typeof deps.log === "function" ? deps.log : () => {};
  const isMac = !!(deps && deps.isMac);

  let timer = null;
  const listeners = new Set();
  let lowThresholdPct = 20;
  let firedSinceEnteringLow = false;
  let lastOnBattery = null;

  async function tick() {
    if (!runFile) return;
    try {
      const result = await runFile("pmset", ["-g", "batt"], { timeout: 5000 });
      const parsed = parseBatteryOutput(result && result.stdout);
      if (!parsed) return;

      // Reset the "fired" latch when we transition off battery (charging /
      // plugged in) so the next discharge cycle can fire again.
      if (lastOnBattery === true && parsed.onBattery === false) {
        firedSinceEnteringLow = false;
      }
      lastOnBattery = parsed.onBattery;

      // Also clear the latch if the user is on battery but has risen above
      // the threshold (e.g. they plugged in briefly then unplugged at 25%).
      // Hysteresis prevents flapping right at the threshold boundary.
      if (parsed.onBattery && parsed.pct >= (lowThresholdPct + 5)) {
        firedSinceEnteringLow = false;
      }

      if (parsed.onBattery && parsed.pct <= lowThresholdPct && !firedSinceEnteringLow) {
        firedSinceEnteringLow = true;
        const event = { pct: parsed.pct, at: Date.now() };
        for (const cb of listeners) {
          try { cb(event); }
          catch (err) { log("error", "battery: listener threw", err); }
        }
      }
    } catch (err) {
      log("debug", "battery: poll failed", err && err.message);
    }
  }

  function start(prefsSub) {
    if (!isMac || timer) return;
    if (prefsSub && Number.isFinite(prefsSub.lowThresholdPct)
        && prefsSub.lowThresholdPct >= 0 && prefsSub.lowThresholdPct <= 100) {
      lowThresholdPct = prefsSub.lowThresholdPct;
    }
    tick();
    timer = setInterval(tick, BATTERY_POLL_MS);
  }

  // stop() takes an optional flag controlling whether the latch
  // (firedSinceEnteringLow / lastOnBattery) is reset. The registry's
  // reload() path calls stop({ keepLatch: true }) so an unrelated settings
  // change (e.g. toggling systemEvents.screenLock) does NOT cause a second
  // batteryLow nudge to fire immediately after the user is still at 15%
  // and was already nudged once. Full teardown (app exit, isMac=false at
  // boot) calls stop() with no args → latch reset.
  function stop(opts) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const keepLatch = !!(opts && opts.keepLatch);
    if (!keepLatch) {
      firedSinceEnteringLow = false;
      lastOnBattery = null;
    }
  }

  function onBatteryLow(cb) {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return {
    start, stop, onBatteryLow,
    __test: {
      tick,
      parseBatteryOutput,
      getListenerCount: () => listeners.size,
      getLowThresholdPct: () => lowThresholdPct,
      getFiredSinceEnteringLow: () => firedSinceEnteringLow,
      getLastOnBattery: () => lastOnBattery,
      BATTERY_POLL_MS,
    },
  };
}

module.exports = { createBatteryMonitor, parseBatteryOutput };
