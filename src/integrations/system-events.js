"use strict";

// src/integrations/system-events.js — Electron powerMonitor bridge (PAWPAL-3).
//
// Subscribes to system-level events via Electron's `powerMonitor` and
// re-emits them on three channels:
//   - "systemEvents.screenLock"   (suspend / lock-screen)
//   - "systemEvents.screenUnlock" (resume / unlock-screen — paired with lock)
//   - "systemEvents.acChange"     ({ onAc: boolean })
//
// We do NOT subscribe to powerMonitor unconditionally — each sub-toggle in
// prefs.integrations.systemEvents controls whether the corresponding raw
// event is forwarded to listeners. This keeps the noise budget tight (most
// users care about lock/unlock but not AC transitions, or vice versa).
//
// Network drop detection is intentionally NOT wired in v1 — Electron's
// `net.online` shape is well-defined but the user-experience question
// "should the pet freak out when wifi drops?" is contentious. Deferred to
// PAWPAL-3.1 once the rest of the integrations have been used in the wild.
//
// Non-mac: powerMonitor exists on Win/Linux too (lock-screen events are
// supported per Electron docs), so we DON'T gate this on isMac. The
// individual events that have no platform support simply never fire — the
// underlying powerMonitor handles that.

function createSystemEventsBridge(deps) {
  const powerMonitor = deps && deps.powerMonitor;
  const log = deps && typeof deps.log === "function" ? deps.log : () => {};
  // isMac is read but used only for log context — events fire regardless.

  const lockListeners = new Set();
  const unlockListeners = new Set();
  const acListeners = new Set();
  // prefsToggles.networkDrop is read from prefs but NOT yet wired to a real
  // listener — no nudge consumes it in v1. The slot exists so PAWPAL-3.1
  // can attach a `net.online` listener without re-touching the prefs
  // surface or the registry contract. If 3.1 doesn't ship within ~2
  // milestones, remove the slot from both prefs.js and this module.
  let prefsToggles = { screenLock: false, networkDrop: true, dockConnect: true };
  let started = false;

  // Cached bound handlers so we can off() exactly what we on()'d.
  let onLockHandler = null;
  let onUnlockHandler = null;
  let onSuspendHandler = null;
  let onResumeHandler = null;
  let onAcHandler = null;
  let onBatteryHandler = null;

  function emit(set, event) {
    for (const cb of set) {
      try { cb(event); }
      catch (err) { log("error", "systemEvents: listener threw", err); }
    }
  }

  function start(prefsSub) {
    if (started || !powerMonitor || typeof powerMonitor.on !== "function") return;
    started = true;
    if (prefsSub && typeof prefsSub === "object") {
      prefsToggles = {
        screenLock: !!prefsSub.screenLock,
        networkDrop: !!prefsSub.networkDrop,
        dockConnect: !!prefsSub.dockConnect,
      };
    }

    // lock / unlock — Electron raises both "suspend"/"resume" and
    // "lock-screen"/"unlock-screen" on macOS. We subscribe to both pairs;
    // either pair tripping is enough to count as a lock event. The dual
    // emission means a single screen-lock action will fire the listener
    // twice — de-duplication lives downstream in nudges.js via the
    // screenLocked nudge's cooldownMs (5s), not in this module. Each event
    // here carries `source` so a downstream consumer that DOES care can
    // distinguish the two (none currently do).
    if (prefsToggles.screenLock) {
      onLockHandler = () => emit(lockListeners, { at: Date.now(), source: "lock-screen" });
      onUnlockHandler = () => emit(unlockListeners, { at: Date.now(), source: "unlock-screen" });
      onSuspendHandler = () => emit(lockListeners, { at: Date.now(), source: "suspend" });
      onResumeHandler = () => emit(unlockListeners, { at: Date.now(), source: "resume" });
      try { powerMonitor.on("lock-screen", onLockHandler); }
      catch (err) { log("debug", "systemEvents: lock-screen subscribe failed", err && err.message); }
      try { powerMonitor.on("unlock-screen", onUnlockHandler); }
      catch (err) { log("debug", "systemEvents: unlock-screen subscribe failed", err && err.message); }
      try { powerMonitor.on("suspend", onSuspendHandler); }
      catch (err) { log("debug", "systemEvents: suspend subscribe failed", err && err.message); }
      try { powerMonitor.on("resume", onResumeHandler); }
      catch (err) { log("debug", "systemEvents: resume subscribe failed", err && err.message); }
    }

    // AC change — `dockConnect` in the spec maps cleanest to this signal
    // (dock = power source change on most setups). on-ac / on-battery events.
    if (prefsToggles.dockConnect) {
      onAcHandler = () => emit(acListeners, { onAc: true, at: Date.now() });
      onBatteryHandler = () => emit(acListeners, { onAc: false, at: Date.now() });
      try { powerMonitor.on("on-ac", onAcHandler); }
      catch (err) { log("debug", "systemEvents: on-ac subscribe failed", err && err.message); }
      try { powerMonitor.on("on-battery", onBatteryHandler); }
      catch (err) { log("debug", "systemEvents: on-battery subscribe failed", err && err.message); }
    }
  }

  function stop() {
    if (!started || !powerMonitor || typeof powerMonitor.off !== "function") {
      started = false;
      return;
    }
    started = false;
    if (onLockHandler) {
      try { powerMonitor.off("lock-screen", onLockHandler); } catch (_e) {}
      onLockHandler = null;
    }
    if (onUnlockHandler) {
      try { powerMonitor.off("unlock-screen", onUnlockHandler); } catch (_e) {}
      onUnlockHandler = null;
    }
    if (onSuspendHandler) {
      try { powerMonitor.off("suspend", onSuspendHandler); } catch (_e) {}
      onSuspendHandler = null;
    }
    if (onResumeHandler) {
      try { powerMonitor.off("resume", onResumeHandler); } catch (_e) {}
      onResumeHandler = null;
    }
    if (onAcHandler) {
      try { powerMonitor.off("on-ac", onAcHandler); } catch (_e) {}
      onAcHandler = null;
    }
    if (onBatteryHandler) {
      try { powerMonitor.off("on-battery", onBatteryHandler); } catch (_e) {}
      onBatteryHandler = null;
    }
  }

  function onScreenLock(cb) {
    if (typeof cb !== "function") return () => {};
    lockListeners.add(cb);
    return () => lockListeners.delete(cb);
  }
  function onScreenUnlock(cb) {
    if (typeof cb !== "function") return () => {};
    unlockListeners.add(cb);
    return () => unlockListeners.delete(cb);
  }
  function onAcChange(cb) {
    if (typeof cb !== "function") return () => {};
    acListeners.add(cb);
    return () => acListeners.delete(cb);
  }

  return {
    start, stop,
    onScreenLock, onScreenUnlock, onAcChange,
    __test: {
      isStarted: () => started,
      getLockListenerCount: () => lockListeners.size,
      getUnlockListenerCount: () => unlockListeners.size,
      getAcListenerCount: () => acListeners.size,
      getPrefsToggles: () => prefsToggles,
      getHandlers: () => ({
        lock: onLockHandler, unlock: onUnlockHandler,
        suspend: onSuspendHandler, resume: onResumeHandler,
        ac: onAcHandler, battery: onBatteryHandler,
      }),
    },
  };
}

module.exports = { createSystemEventsBridge };
