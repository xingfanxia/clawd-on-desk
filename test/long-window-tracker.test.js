"use strict";

// PAWPAL-2 Task 6 — long-window-tracker.js unit tests.
//
// The tracker is a pure signal source: subscribe to workspace-detector's
// confirmed app changes, track elapsed time on the current app, fire
// `onLongWindow({ app, durationMs })` once the user has stayed on the same
// app longer than the configured threshold (90 min default). These tests
// inject every dependency (workspaceDetector stub, prefs, time,
// setInterval/clearInterval) so the full state machine runs synchronously
// in milliseconds.
//
// Coverage (cases A-N from the plan):
//   A. Timer resets on app change.
//   B. Long-window fires at threshold.
//   C. Cooldown prevents spam (no re-fire within 30min of first fire).
//   D. Silent no-op when prefs.workspaceAwareness.enabled false.
//   E. Silent no-op when prefs.workspaceAwareness.longWindow.enabled false.
//   F. getCurrentWindowDurationMs returns null before first app change.
//   G. getCurrentWindowDurationMs returns null when gated off.
//   H. getCurrentWindowDurationMs returns sane ms after app change.
//   I. reload() doesn't reset cooldown (lastFireAt persists — fatigue tracking).
//   J. unsubscribe from onLongWindow removes listener.
//   K. stop() resets sameAppSince + current app (clean state on restart).
//   L. ctx-validation throws on setIntervalFn without clearIntervalFn.
//   M. workspaceDetector.onAppChange throwing during start() doesn't leak
//      the tick interval.
//   N. Sleep-wake simulation — advance time by 12h in one jump, fire
//      happens (proves Date.now-based comparison instead of setTimeout).

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initLongWindowTracker = require("../src/long-window-tracker");

// ── Fake-timer harness ────────────────────────────────────────────────────
//
// One interval in flight at most (the tracker's tick). Tests advance the
// clock manually between ticks so wall-clock never enters the picture.
function makeFakeTimers() {
  let nowMs = 0;
  let registered = null; // { fn, intervalMs, handle }
  let nextHandle = 1;
  return {
    now: () => nowMs,
    advance: (delta) => { nowMs += delta; },
    setNow: (t) => { nowMs = t; },
    setInterval: (fn, intervalMs) => {
      assert.strictEqual(registered, null, "fake setInterval expected single registration");
      registered = { fn, intervalMs, handle: nextHandle++ };
      return registered.handle;
    },
    clearInterval: (handle) => {
      if (registered && registered.handle === handle) registered = null;
    },
    // Fire the tick fn WITHOUT advancing the clock. Caller advances
    // explicitly via advance() between ticks.
    tick: () => {
      if (!registered) return;
      registered.fn();
    },
    intervalMs: () => (registered ? registered.intervalMs : null),
    isArmed: () => registered !== null,
  };
}

// workspaceDetector stub. Records onAppChange subscribers and lets the test
// fire them manually with arbitrary appInfo payloads. Mirrors Task 4's
// onAppChange contract: pass a callback, get back an unsubscribe fn.
function makeWorkspaceDetectorStub(opts) {
  const o = opts || {};
  const listeners = new Set();
  const stub = {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    onAppChange(cb) {
      stub.subscribeCalls += 1;
      if (o.throwOnSubscribe) throw new Error("simulated onAppChange failure");
      if (o.returnNonFunction) return undefined;
      listeners.add(cb);
      return function unsubscribe() {
        stub.unsubscribeCalls += 1;
        listeners.delete(cb);
      };
    },
    // Test driver: fake-fire an app change to all subscribers.
    fireAppChange(appInfo) {
      for (const cb of listeners) cb(appInfo);
    },
    listenerCount: () => listeners.size,
  };
  return stub;
}

// Default prefs builder — workspaceAwareness ON + longWindow ON with the
// 90-min threshold. Tests override shallowly.
function buildPrefs(overrides) {
  const base = {
    workspaceAwareness: {
      enabled: true,
      longWindow: {
        enabled: true,
        sameWindowThresholdMs: 5_400_000, // 90 min
      },
    },
  };
  if (!overrides) return base;
  const out = JSON.parse(JSON.stringify(base));
  if (overrides.workspaceAwareness) {
    Object.assign(out.workspaceAwareness, overrides.workspaceAwareness);
    if (overrides.workspaceAwareness.longWindow) {
      out.workspaceAwareness.longWindow = Object.assign(
        {},
        base.workspaceAwareness.longWindow,
        overrides.workspaceAwareness.longWindow,
      );
    }
  }
  return out;
}

// One-call assembly helper. Returns {tracker, timers, detector, prefsBox, logs}.
function buildTracker(opts) {
  const o = opts || {};
  const timers = o.timers || makeFakeTimers();
  const detector = o.detector || makeWorkspaceDetectorStub();
  const prefsBox = { current: o.prefs || buildPrefs() };
  const logs = [];
  const ctx = {
    getPrefs: () => prefsBox.current,
    workspaceDetector: detector,
    log: (level, msg, err) => { logs.push({ level, msg, err: err && err.message }); },
    now: timers.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
  if (o.tickIntervalMs) ctx.tickIntervalMs = o.tickIntervalMs;
  if (o.fireCooldownMs) ctx.fireCooldownMs = o.fireCooldownMs;
  const tracker = initLongWindowTracker(ctx);
  return { tracker, timers, detector, prefsBox, logs };
}

// Standard "Cursor" appInfo for tests that don't care about the app shape.
function appInfo(name, category) {
  return { name: name || "Cursor", category: category || "code", sinceMs: 0 };
}

// ── Case A: timer resets on app change ───────────────────────────────────
describe("long-window-tracker: Case A — timer resets on every app change", () => {
  it("re-anchors sameAppSince on each onAppChange", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    // T=0: first app change. sameAppSince = 0.
    detector.fireAppChange(appInfo("Cursor"));
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0);
    // T=10min: second app change. sameAppSince resets to 10min.
    timers.advance(10 * 60_000);
    detector.fireAppChange(appInfo("Slack", "chat"));
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0, "fresh app starts at zero");
    // T=15min: same Slack, but no new change event. Duration ticks up.
    timers.advance(5 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 5 * 60_000);
    // T=20min: third app change. sameAppSince resets to 20min.
    detector.fireAppChange(appInfo("Notion", "docs"));
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0);
    tracker.stop();
  });
});

// ── Case B: fires at threshold ───────────────────────────────────────────
describe("long-window-tracker: Case B — fires at sameWindowThresholdMs", () => {
  it("fires onLongWindow once sameAppSince crosses 90 min", () => {
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor")); // T=0
    // T=89min: not yet.
    timers.advance(89 * 60_000);
    timers.tick();
    assert.strictEqual(events.length, 0, "below threshold should not fire");
    // T=90min: at threshold. Should fire on next tick.
    timers.advance(60_000);
    timers.tick();
    assert.strictEqual(events.length, 1, "at threshold should fire");
    assert.strictEqual(events[0].app.name, "Cursor");
    assert.ok(events[0].durationMs >= 90 * 60_000, "durationMs should be >= threshold");
    tracker.stop();
  });

  it("fires only once per same-app stretch (no re-fire within cooldown)", () => {
    // This overlaps with Case C, but it's worth a direct assertion that one
    // sustained session doesn't spam fire on every tick after the threshold.
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(95 * 60_000);
    timers.tick(); // fires
    timers.advance(60_000);
    timers.tick(); // cooldown — no fire
    timers.advance(60_000);
    timers.tick(); // still cooldown
    assert.strictEqual(events.length, 1, "must not double-fire across consecutive ticks");
    tracker.stop();
  });
});

// ── Case C: cooldown prevents spam ───────────────────────────────────────
describe("long-window-tracker: Case C — cooldown prevents spam fires", () => {
  it("no second fire within 30min of first fire (still on same app)", () => {
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor")); // T=0
    timers.advance(90 * 60_000);
    timers.tick(); // first fire at T=90min
    assert.strictEqual(events.length, 1);
    // T=119min: 29min after first fire. Cooldown still active.
    timers.advance(29 * 60_000);
    timers.tick();
    assert.strictEqual(events.length, 1, "no second fire 29min after first");
    // T=120min: exactly 30min after first fire — cooldown elapsed.
    timers.advance(60_000);
    timers.tick();
    assert.strictEqual(events.length, 2, "should fire again at T+30min");
    tracker.stop();
  });

  it("cooldown anchor is lastFireAt, NOT sameAppSince", () => {
    // Verify the cooldown clock starts from the FIRE timestamp, not the
    // app-change timestamp. If it started from sameAppSince, the test below
    // would never re-fire (sameAppSince + cooldown < threshold would put us
    // back inside the threshold window).
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor")); // T=0
    timers.advance(90 * 60_000);
    timers.tick(); // fire at T=90min
    timers.advance(30 * 60_000);
    timers.tick(); // T=120min, cooldown just elapsed — fire
    assert.strictEqual(events.length, 2);
    timers.advance(30 * 60_000);
    timers.tick(); // T=150min, next cooldown elapsed — fire again
    assert.strictEqual(events.length, 3);
    tracker.stop();
  });
});

// ── Case D: silent no-op when workspaceAwareness.enabled === false ───────
describe("long-window-tracker: Case D — silent no-op when workspaceAwareness.enabled false", () => {
  it("does NOT fire onLongWindow when root gate is off", () => {
    const prefs = buildPrefs({ workspaceAwareness: { enabled: false } });
    const { tracker, timers, detector } = buildTracker({ prefs });
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(120 * 60_000);
    timers.tick();
    timers.tick();
    timers.tick();
    assert.strictEqual(events.length, 0, "no fire under root-gate-off");
    tracker.stop();
  });

  it("resumes firing when gate flips back to enabled (no restart needed)", () => {
    // Demonstrates that gates apply at tick time. The user can toggle the
    // feature off and back on without losing the same-app session.
    const prefsBox = { current: buildPrefs({ workspaceAwareness: { enabled: false } }) };
    const timers = makeFakeTimers();
    const detector = makeWorkspaceDetectorStub();
    const tracker = initLongWindowTracker({
      getPrefs: () => prefsBox.current,
      workspaceDetector: detector,
      log: () => {},
      now: timers.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor")); // sameAppSince recorded BUT gated → no fire
    timers.advance(120 * 60_000);
    timers.tick();
    assert.strictEqual(events.length, 0);
    // Flip gate on.
    prefsBox.current = buildPrefs();
    timers.tick();
    assert.strictEqual(events.length, 1, "should fire after gate flips on");
    tracker.stop();
  });
});

// ── Case E: silent no-op when longWindow.enabled === false ───────────────
describe("long-window-tracker: Case E — silent no-op when longWindow.enabled false", () => {
  it("does NOT fire when sub-gate is off (root still on)", () => {
    const prefs = buildPrefs({
      workspaceAwareness: { enabled: true, longWindow: { enabled: false } },
    });
    const { tracker, timers, detector } = buildTracker({ prefs });
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(120 * 60_000);
    timers.tick();
    assert.strictEqual(events.length, 0);
    tracker.stop();
  });
});

// ── Case F: getCurrentWindowDurationMs returns null before first app change ─
describe("long-window-tracker: Case F — null duration before first app change", () => {
  it("returns null right after start() (no app yet)", () => {
    const { tracker } = buildTracker();
    tracker.start();
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
    tracker.stop();
  });

  it("returns null before start() is called", () => {
    const { tracker } = buildTracker();
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
  });
});

// ── Case G: getCurrentWindowDurationMs returns null when gated off ───────
describe("long-window-tracker: Case G — null duration when gated off", () => {
  it("returns null when workspaceAwareness.enabled is false", () => {
    const prefs = buildPrefs({ workspaceAwareness: { enabled: false } });
    const { tracker, detector, timers } = buildTracker({ prefs });
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(10 * 60_000);
    // Even though sameAppSince is set internally, the gated read returns null.
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
    tracker.stop();
  });

  it("returns null when longWindow.enabled is false", () => {
    const prefs = buildPrefs({ workspaceAwareness: { longWindow: { enabled: false } } });
    const { tracker, detector, timers } = buildTracker({ prefs });
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(10 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
    tracker.stop();
  });
});

// ── Case H: getCurrentWindowDurationMs returns sane ms ───────────────────
describe("long-window-tracker: Case H — sane ms after first app change", () => {
  it("returns 0 immediately after the first app-change event", () => {
    const { tracker, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0);
    tracker.stop();
  });

  it("ticks up as the clock advances on the same app", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(5 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 5 * 60_000);
    timers.advance(20 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 25 * 60_000);
    tracker.stop();
  });

  it("resets to zero on a fresh app change even mid-stride", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(45 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 45 * 60_000);
    detector.fireAppChange(appInfo("Slack", "chat"));
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0);
    tracker.stop();
  });
});

// ── Case I: reload() does NOT reset cooldown ─────────────────────────────
describe("long-window-tracker: Case I — reload() preserves lastFireAt", () => {
  it("reload() does NOT clear lastFireAt (fatigue history persists)", () => {
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(90 * 60_000);
    timers.tick(); // fire
    assert.strictEqual(events.length, 1);
    const stateBefore = tracker.__test.getInternalState();
    assert.ok(stateBefore.lastFireAt !== null, "fire should have set lastFireAt");
    // Now reload. lastFireAt must persist.
    tracker.reload();
    const stateAfter = tracker.__test.getInternalState();
    assert.strictEqual(
      stateAfter.lastFireAt,
      stateBefore.lastFireAt,
      "reload() must NOT clear lastFireAt — past fires are fatigue tracking",
    );
    // Verify behaviorally: a tick inside the cooldown should still NOT
    // re-fire after the reload (cooldown is intact).
    timers.advance(10 * 60_000);
    timers.tick();
    assert.strictEqual(events.length, 1, "cooldown must survive reload()");
    tracker.stop();
  });
});

// ── Case J: unsubscribe from onLongWindow removes listener ───────────────
describe("long-window-tracker: Case J — onLongWindow unsubscribe", () => {
  it("after unsubscribe(), the listener stops receiving fires", () => {
    const { tracker, timers, detector } = buildTracker();
    const eventsA = [];
    const eventsB = [];
    const offA = tracker.onLongWindow((evt) => eventsA.push(evt));
    tracker.onLongWindow((evt) => eventsB.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(90 * 60_000);
    timers.tick(); // first fire
    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsB.length, 1);
    offA();
    // Drive a second fire after the cooldown.
    timers.advance(31 * 60_000);
    timers.tick();
    assert.strictEqual(eventsA.length, 1, "A should not receive the 2nd fire");
    assert.strictEqual(eventsB.length, 2, "B should still receive the 2nd fire");
    tracker.stop();
  });

  it("onLongWindow throws on non-function callback", () => {
    const { tracker } = buildTracker();
    assert.throws(() => tracker.onLongWindow(null), /must be a function/);
    assert.throws(() => tracker.onLongWindow("nope"), /must be a function/);
  });
});

// ── Case K: stop() resets sameAppSince + currentApp ──────────────────────
describe("long-window-tracker: Case K — stop() resets cycle-local state", () => {
  it("getCurrentWindowDurationMs returns null after stop()→start() cycle", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(45 * 60_000);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 45 * 60_000);
    tracker.stop();
    // Restart immediately. Without the reset, the stored sameAppSince=0 would
    // still report 45min (or more after the next advance). With the reset,
    // duration is null until the next onAppChange.
    tracker.start();
    assert.strictEqual(
      tracker.getCurrentWindowDurationMs(),
      null,
      "pre-stop sameAppSince must NOT survive the restart",
    );
    // Internal state should also reflect the reset.
    const state = tracker.__test.getInternalState();
    assert.strictEqual(state.currentApp, null);
    assert.strictEqual(state.sameAppSince, null);
    tracker.stop();
  });

  it("preserves lastFireAt across stop()→start() (fatigue history)", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.onLongWindow(() => {});
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(90 * 60_000);
    timers.tick();
    const stateBefore = tracker.__test.getInternalState();
    assert.ok(stateBefore.lastFireAt !== null);
    tracker.stop();
    tracker.start();
    const stateAfter = tracker.__test.getInternalState();
    assert.strictEqual(
      stateAfter.lastFireAt,
      stateBefore.lastFireAt,
      "stop()→start() must preserve lastFireAt",
    );
    tracker.stop();
  });
});

// ── Case L: ctx-validation throws on half-wired timers ───────────────────
describe("long-window-tracker: Case L — ctx validation (pair-check timers)", () => {
  it("throws when setInterval provided without clearInterval", () => {
    assert.throws(() => initLongWindowTracker({
      getPrefs: () => ({}),
      workspaceDetector: { onAppChange: () => () => {} },
      setInterval: () => 1,
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });

  it("throws when clearInterval provided without setInterval", () => {
    assert.throws(() => initLongWindowTracker({
      getPrefs: () => ({}),
      workspaceDetector: { onAppChange: () => () => {} },
      clearInterval: () => {},
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });

  it("throws when getPrefs is missing", () => {
    assert.throws(() => initLongWindowTracker({
      workspaceDetector: { onAppChange: () => () => {} },
    }), /getPrefs/);
  });

  it("throws when workspaceDetector is missing", () => {
    assert.throws(() => initLongWindowTracker({
      getPrefs: () => ({}),
    }), /workspaceDetector/);
  });

  it("throws when workspaceDetector lacks onAppChange", () => {
    assert.throws(() => initLongWindowTracker({
      getPrefs: () => ({}),
      workspaceDetector: {},
    }), /onAppChange/);
  });
});

// ── Case M: subscribe failure doesn't leak the tick interval ─────────────
describe("long-window-tracker: Case M — subscribe failure cleanup", () => {
  it("does NOT register the tick interval when onAppChange throws", () => {
    const detector = makeWorkspaceDetectorStub({ throwOnSubscribe: true });
    const { tracker, timers, logs } = buildTracker({ detector });
    tracker.start();
    // tick interval (60s default) must NOT be armed.
    assert.strictEqual(timers.isArmed(), false, "tick must NOT arm when subscribe throws");
    // The throw was logged.
    const errLogs = logs.filter((l) => /onAppChange threw/i.test(l.msg));
    assert.strictEqual(errLogs.length, 1);
    // getCurrentWindowDurationMs stays null (no subscription = no app data).
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
    // stop() must not throw.
    tracker.stop();
    assert.strictEqual(timers.isArmed(), false);
  });

  it("does NOT register the tick interval when onAppChange returns non-function", () => {
    const detector = makeWorkspaceDetectorStub({ returnNonFunction: true });
    const { tracker, timers, logs } = buildTracker({ detector });
    tracker.start();
    assert.strictEqual(timers.isArmed(), false, "tick must NOT arm when onAppChange returns garbage");
    // The contract violation was logged.
    const errLogs = logs.filter((l) => /onAppChange did not return an unsubscribe/i.test(l.msg));
    assert.strictEqual(errLogs.length, 1);
    tracker.stop();
  });
});

// ── Case N: sleep-wake — 12h jump still fires ────────────────────────────
describe("long-window-tracker: Case N — sleep/wake simulation (timestamp-based)", () => {
  it("fires after a 12h time jump (no drift across simulated sleep)", () => {
    // The whole point of comparing Date.now() rather than relying on
    // setTimeout — a real sleep/wake cycle pauses setTimeout but advances
    // the wall clock. Our tick observes the elapsed delta and fires
    // immediately on the next tick after wake.
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor")); // T=0
    // Simulate a 12-hour sleep: jump the clock without intermediate ticks.
    timers.advance(12 * 60 * 60_000);
    // First tick after wake.
    timers.tick();
    assert.strictEqual(events.length, 1, "post-wake tick should fire the long-window event");
    assert.ok(
      events[0].durationMs >= 12 * 60 * 60_000,
      "durationMs should reflect the full 12h wall-clock delta",
    );
    tracker.stop();
  });

  it("fires correctly across multiple sleep cycles", () => {
    // Sleep 12h → wake (fire) → use for 5min → sleep 2h → wake (no fire,
    // cooldown active) → use for 28min more → cooldown elapses, fire again.
    const { tracker, timers, detector } = buildTracker();
    const events = [];
    tracker.onLongWindow((evt) => events.push(evt));
    tracker.start();
    detector.fireAppChange(appInfo("Cursor"));
    timers.advance(12 * 60 * 60_000); // 12h sleep
    timers.tick();
    assert.strictEqual(events.length, 1, "first fire after 12h sleep");
    // Active use for 5min, then 2h sleep.
    timers.advance(5 * 60_000 + 2 * 60 * 60_000);
    timers.tick();
    // We're now 12h + 5min + 2h after sameAppSince. Cooldown anchor is at
    // 12h. 2h+5min after the fire = past the 30-min cooldown → fires.
    assert.strictEqual(events.length, 2, "fires after cooldown clears over a sleep cycle");
    tracker.stop();
  });
});

// ── Lifecycle: start/stop semantics ──────────────────────────────────────
describe("long-window-tracker: start/stop lifecycle", () => {
  it("start() is idempotent — calling twice does not double-subscribe or double-arm", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    assert.strictEqual(detector.subscribeCalls, 1);
    assert.strictEqual(timers.isArmed(), true);
    tracker.start();
    assert.strictEqual(detector.subscribeCalls, 1, "second start() must be a no-op");
    tracker.stop();
  });

  it("stop() unsubscribes and clears the interval", () => {
    const { tracker, timers, detector } = buildTracker();
    tracker.start();
    assert.strictEqual(detector.subscribeCalls, 1);
    assert.strictEqual(detector.unsubscribeCalls, 0);
    tracker.stop();
    assert.strictEqual(detector.unsubscribeCalls, 1, "stop() must unsubscribe");
    assert.strictEqual(timers.isArmed(), false, "stop() must clear the interval");
  });

  it("stop() before start() is a safe no-op", () => {
    const { tracker } = buildTracker();
    assert.doesNotThrow(() => tracker.stop());
  });
});

// ── Module constants ─────────────────────────────────────────────────────
describe("long-window-tracker: module constants", () => {
  it("exposes the documented defaults via module.exports", () => {
    assert.strictEqual(initLongWindowTracker.DEFAULT_TICK_INTERVAL_MS, 60_000);
    assert.strictEqual(initLongWindowTracker.DEFAULT_FIRE_COOLDOWN_MS, 30 * 60_000);
  });
});

// ── Defensive: ignore malformed appInfo from workspaceDetector ───────────
describe("long-window-tracker: malformed onAppChange payloads", () => {
  it("ignores null / non-object payloads (no crash, no state change)", () => {
    const { tracker, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange(null);
    detector.fireAppChange(undefined);
    detector.fireAppChange("Cursor");
    detector.fireAppChange(42);
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null, "no valid app should have been recorded");
    tracker.stop();
  });

  it("ignores payloads without a string `name`", () => {
    const { tracker, detector } = buildTracker();
    tracker.start();
    detector.fireAppChange({ category: "code" }); // no name
    detector.fireAppChange({ name: null, category: "code" });
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), null);
    // Valid one works.
    detector.fireAppChange({ name: "Cursor", category: "code" });
    assert.strictEqual(tracker.getCurrentWindowDurationMs(), 0);
    tracker.stop();
  });
});
