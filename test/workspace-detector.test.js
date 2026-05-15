"use strict";

// PAWPAL-2 Task 4 — workspace-detector.js unit tests.
//
// The detector is a pure signal source: poll the frontmost app, debounce
// rapid changes, route name → category via substring rules. These tests
// inject every dependency (osPermission, prefs, captureFrontApp, time,
// setInterval) so a single test process can exercise the full state
// machine in milliseconds without spawning osascript or waiting on real
// timers.
//
// Coverage matches Task 4's plan (cases A-J):
//   A. Poll fires only when permission granted AND prefs enabled.
//   B. Silent no-op when accessibility permission denied.
//   C. Silent no-op when prefs.workspaceAwareness.enabled === false.
//   D. Silent no-op when prefs.workspaceAwareness.activeApp.enabled === false.
//   E. Substring matching is case-insensitive.
//   F. Longest-match-wins ("Visual Studio Code" beats "Code").
//   G. Debounce — rapid switches within 5s emit only ONE confirmed change.
//   H. Category falls through to "unknown" when no rule matches.
//   I. reload() re-reads prefs (mutating the prefs mock between calls).
//   J. Unsubscribe (returned from onAppChange) actually removes the listener.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initWorkspaceDetector = require("../src/workspace-detector");

// ── Fake-time + fake-interval harness ─────────────────────────────────────
//
// The detector accepts injectable `now`, `setInterval`, `clearInterval` so
// tests can advance the clock synchronously and call the registered tick
// function directly. No flake from real wall-clock.
function makeFakeTimers() {
  let nowMs = 0;
  let registered = null; // { fn, intervalMs, handle }
  let nextHandle = 1;
  return {
    now: () => nowMs,
    advance: (delta) => { nowMs += delta; },
    setNow: (t) => { nowMs = t; },
    setInterval: (fn, intervalMs) => {
      // Only one interval in flight — matches the detector's contract
      // (`start()` is idempotent + immediately returns if already armed).
      assert.strictEqual(registered, null, "fake setInterval expected single registration");
      registered = { fn, intervalMs, handle: nextHandle++ };
      return registered.handle;
    },
    clearInterval: (handle) => {
      if (registered && registered.handle === handle) registered = null;
    },
    // Drive one tick: advance time by the interval, then run the tick fn.
    // Mirrors what a real timer would do, minus the wall-clock wait.
    tick: () => {
      if (!registered) return;
      nowMs += registered.intervalMs;
      registered.fn();
    },
    isArmed: () => registered !== null,
  };
}

// captureFrontApp stub — records calls, returns a preset name on the next
// call. Tests can change `nextName` between ticks to simulate app switches.
function makeFrontAppStub(initialName) {
  const state = { nextName: initialName, calls: 0 };
  function captureFrontApp(cb) {
    state.calls += 1;
    cb(state.nextName);
  }
  return { captureFrontApp, state };
}

// osPermission stub — `isGranted` returns whatever the current state says.
// Tests can flip it mid-run to simulate the user granting/revoking AX.
function makeOsPermissionStub(initialState) {
  const state = { current: initialState };
  return {
    state,
    osPermission: {
      isGranted: (kind) => (kind === "accessibility" ? state.current : "granted"),
    },
  };
}

// Default prefs builder — everything ON, with the standard category rules.
// Tests deviate by passing a partial override; missing fields are filled in
// to keep test bodies focused on the field actually under test.
function buildPrefs(overrides) {
  const base = {
    workspaceAwareness: {
      enabled: true,
      activeApp: {
        enabled: true,
        categoryRules: {
          "Code": "code",
          "Visual Studio Code": "code",
          "Cursor": "code",
          "Slack": "chat",
          "Notion": "docs",
          "YouTube": "video",
        },
      },
    },
  };
  if (!overrides) return base;
  // Deep-merge only one level — sufficient for the test cases below.
  const out = JSON.parse(JSON.stringify(base));
  if (overrides.workspaceAwareness) {
    Object.assign(out.workspaceAwareness, overrides.workspaceAwareness);
    if (overrides.workspaceAwareness.activeApp) {
      out.workspaceAwareness.activeApp = Object.assign(
        {},
        base.workspaceAwareness.activeApp,
        overrides.workspaceAwareness.activeApp,
      );
    }
  }
  return out;
}

function buildDetector(opts) {
  const o = opts || {};
  const timers = o.timers || makeFakeTimers();
  const front = o.front || makeFrontAppStub("Cursor");
  const osPerm = o.osPerm || makeOsPermissionStub("granted");
  const prefsBox = { current: o.prefs || buildPrefs() };
  const detector = initWorkspaceDetector({
    getPrefs: () => prefsBox.current,
    osPermission: osPerm.osPermission,
    captureFrontApp: front.captureFrontApp,
    log: () => {},
    now: timers.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { detector, timers, front, osPerm, prefsBox };
}

// ── Case A: poll fires when permission granted AND prefs enabled ──────────
describe("workspace-detector: Case A — poll fires when permission granted AND prefs enabled", () => {
  it("calls captureFrontApp every tick once started", () => {
    const { detector, timers, front } = buildDetector();
    detector.start();
    assert.strictEqual(front.state.calls, 0, "no calls before first tick");
    timers.tick();
    assert.strictEqual(front.state.calls, 1, "one call after first tick");
    timers.tick();
    assert.strictEqual(front.state.calls, 2, "two calls after second tick");
    detector.stop();
  });
});

// ── Case B: silent no-op when accessibility permission denied ─────────────
describe("workspace-detector: Case B — silent no-op when permission denied", () => {
  it("does NOT call captureFrontApp when osPermission says denied", () => {
    const osPerm = makeOsPermissionStub("denied");
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ osPerm, front });
    detector.start();
    timers.tick();
    timers.tick();
    timers.tick();
    assert.strictEqual(front.state.calls, 0, "no captureFrontApp calls under denied gate");
    detector.stop();
  });

  it("resumes calling captureFrontApp when permission flips to granted mid-run", () => {
    const osPerm = makeOsPermissionStub("denied");
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ osPerm, front });
    detector.start();
    timers.tick();
    assert.strictEqual(front.state.calls, 0);
    osPerm.state.current = "granted";
    timers.tick();
    assert.strictEqual(front.state.calls, 1, "next tick under granted should call");
    detector.stop();
  });

  it("treats osPermission states 'unknown' / arbitrary strings as not-granted", () => {
    const osPerm = makeOsPermissionStub("unknown");
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ osPerm, front });
    detector.start();
    timers.tick();
    assert.strictEqual(front.state.calls, 0);
    detector.stop();
  });
});

// ── Case C: silent no-op when prefs.workspaceAwareness.enabled === false ──
describe("workspace-detector: Case C — silent no-op when workspaceAwareness.enabled false", () => {
  it("does NOT call captureFrontApp when root gate is off", () => {
    const prefs = buildPrefs({ workspaceAwareness: { enabled: false } });
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ prefs, front });
    detector.start();
    timers.tick();
    timers.tick();
    assert.strictEqual(front.state.calls, 0);
    detector.stop();
  });
});

// ── Case D: silent no-op when activeApp.enabled === false ─────────────────
describe("workspace-detector: Case D — silent no-op when activeApp.enabled false", () => {
  it("does NOT call captureFrontApp when sub-gate is off", () => {
    const prefs = buildPrefs({
      workspaceAwareness: { enabled: true, activeApp: { enabled: false } },
    });
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ prefs, front });
    detector.start();
    timers.tick();
    timers.tick();
    assert.strictEqual(front.state.calls, 0);
    detector.stop();
  });
});

// ── Case E: substring matching is case-insensitive ────────────────────────
describe("workspace-detector: Case E — case-insensitive substring matching", () => {
  it("matches 'cursor' against the 'Cursor' rule", () => {
    const { detector } = buildDetector();
    const cat = detector.__test.categorize("cursor");
    assert.strictEqual(cat, "code");
  });

  it("matches 'SLACK Desktop' against the 'Slack' rule", () => {
    const { detector } = buildDetector();
    const cat = detector.__test.categorize("SLACK Desktop");
    assert.strictEqual(cat, "chat");
  });

  it("matches mixed-case suffix variants", () => {
    const { detector } = buildDetector();
    assert.strictEqual(detector.__test.categorize("cURsOR"), "code");
    assert.strictEqual(detector.__test.categorize("YouTube Music"), "video");
  });
});

// ── Case F: longest-match-wins ────────────────────────────────────────────
describe("workspace-detector: Case F — longest substring wins", () => {
  it("'Visual Studio Code' matches 'Visual Studio Code', not 'Code'", () => {
    // Both rules are present; the longer key must win so categorization is
    // deterministic regardless of key insertion order in prefs.json.
    const { detector } = buildDetector();
    const cat = detector.__test.categorize("Visual Studio Code");
    assert.strictEqual(cat, "code");
  });

  it("longest-match still wins when a shorter rule has a DIFFERENT category", () => {
    // Constructed adversarial map where the shorter substring would route to
    // a different category. If longest-match-wins isn't implemented, the
    // short rule would win sometimes and the test would catch it.
    const prefs = buildPrefs({
      workspaceAwareness: {
        activeApp: {
          enabled: true,
          categoryRules: {
            "Code": "creative",                // shorter, different category
            "Visual Studio Code": "code",      // longer, correct category
          },
        },
      },
    });
    const { detector } = buildDetector({ prefs });
    assert.strictEqual(
      detector.__test.categorize("Visual Studio Code"),
      "code",
      "longest matching key must win even when shorter key has a different category",
    );
  });
});

// ── Case G: debounce — rapid switches collapse to ONE confirmed change ────
describe("workspace-detector: Case G — 5s debounce collapses rapid switches", () => {
  it("first confirmation requires ≥5s of stability (one full tick of repeat)", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    const seen = [];
    detector.onAppChange((evt) => seen.push(evt.name));
    detector.start();
    timers.tick(); // T=5: candidate=Cursor, no fire yet (debounce window starts here)
    assert.deepStrictEqual(seen, [], "first observation must NOT fire");
    timers.tick(); // T=10: candidate=Cursor still → 10-5 >= 5 → confirm
    assert.deepStrictEqual(seen, ["Cursor"]);
    detector.stop();
  });

  it("rapid Cmd+Tab spam emits ONE confirmed change (the steady-state app)", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    const seen = [];
    detector.onAppChange((evt) => seen.push({ name: evt.name, at: timers.now() }));
    detector.start();
    // Establish initial confirmed: Cursor at T=5 candidate, T=10 confirm.
    timers.tick();
    timers.tick();
    assert.deepStrictEqual(seen.map((e) => e.name), ["Cursor"]);
    // Now Cmd+Tab spam: each tick is a different app.
    front.state.nextName = "Slack"; timers.tick();
    front.state.nextName = "Notion"; timers.tick();
    front.state.nextName = "Cursor"; timers.tick();
    front.state.nextName = "Slack"; timers.tick();
    // None of these should have fired — each replaced the candidate.
    assert.deepStrictEqual(seen.map((e) => e.name), ["Cursor"], "rapid switches must NOT fire");
    // Settle on Slack for two ticks → fires.
    front.state.nextName = "Slack"; timers.tick();
    front.state.nextName = "Slack"; timers.tick();
    assert.deepStrictEqual(seen.map((e) => e.name), ["Cursor", "Slack"]);
    detector.stop();
  });

  it("same app over many ticks emits exactly ONE change", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    const seen = [];
    detector.onAppChange((evt) => seen.push(evt.name));
    detector.start();
    for (let i = 0; i < 10; i++) timers.tick();
    assert.strictEqual(seen.length, 1, `expected 1 emit, got ${seen.length}: ${JSON.stringify(seen)}`);
    assert.strictEqual(seen[0], "Cursor");
    detector.stop();
  });
});

// ── Case H: category falls through to "unknown" when no rule matches ──────
describe("workspace-detector: Case H — unknown category fallback", () => {
  it("returns 'unknown' for an app name that matches no rule", () => {
    const { detector } = buildDetector();
    assert.strictEqual(detector.__test.categorize("FlightTracker"), "unknown");
  });

  it("returns 'unknown' for empty / null app name", () => {
    const { detector } = buildDetector();
    assert.strictEqual(detector.__test.categorize(""), "unknown");
    assert.strictEqual(detector.__test.categorize(null), "unknown");
    assert.strictEqual(detector.__test.categorize(undefined), "unknown");
  });

  it("getCurrentApp returns the unknown category in the payload", () => {
    const front = makeFrontAppStub("FlightTracker");
    const { detector, timers } = buildDetector({ front });
    const seen = [];
    detector.onAppChange((evt) => seen.push(evt));
    detector.start();
    timers.tick(); // candidate
    timers.tick(); // confirm
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].category, "unknown");
    assert.strictEqual(detector.getCurrentApp().category, "unknown");
    detector.stop();
  });
});

// ── Case I: reload() re-reads prefs ───────────────────────────────────────
describe("workspace-detector: Case I — reload() re-reads prefs", () => {
  it("a category-rules edit applied after reload changes subsequent categorization", () => {
    const front = makeFrontAppStub("CustomApp");
    // Start with rules that don't match CustomApp → "unknown".
    const prefsBox = { current: buildPrefs() };
    const detector = initWorkspaceDetector({
      getPrefs: () => prefsBox.current,
      osPermission: makeOsPermissionStub("granted").osPermission,
      captureFrontApp: front.captureFrontApp,
      log: () => {},
      now: () => 0,
    });
    assert.strictEqual(detector.__test.categorize("CustomApp"), "unknown");
    // Mutate prefs map to add the new rule. Without reload(), the detector's
    // sort cache still points at the old rules object — but since we
    // REPLACE the rules object below (not mutate it), identity changes and
    // the cache miss should refresh on its own. Also exercise reload()
    // explicitly to confirm it doesn't break anything.
    prefsBox.current = buildPrefs({
      workspaceAwareness: {
        activeApp: {
          enabled: true,
          categoryRules: { "CustomApp": "creative" },
        },
      },
    });
    detector.reload();
    assert.strictEqual(detector.__test.categorize("CustomApp"), "creative");
  });

  it("reload() clears the in-flight debounce candidate", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    detector.start();
    timers.tick(); // candidate=Cursor at T=5
    detector.reload();
    // After reload, candidate is cleared → next tick re-establishes it,
    // and the confirm fires on the tick AFTER that.
    const seen = [];
    detector.onAppChange((evt) => seen.push(evt.name));
    timers.tick(); // T=10: candidate=Cursor (fresh)
    assert.deepStrictEqual(seen, [], "reload should have reset the debounce candidate");
    timers.tick(); // T=15: confirm
    assert.deepStrictEqual(seen, ["Cursor"]);
    detector.stop();
  });
});

// ── Case J: unsubscribe actually removes the listener ────────────────────
describe("workspace-detector: Case J — unsubscribe removes the listener", () => {
  it("once unsubscribed, the callback never fires again", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    const seen = [];
    const off = detector.onAppChange((evt) => seen.push(evt.name));
    detector.start();
    timers.tick(); timers.tick(); // confirm Cursor
    assert.deepStrictEqual(seen, ["Cursor"]);
    off();
    // Switch to Slack — should NOT fire to the unsubscribed listener.
    front.state.nextName = "Slack";
    timers.tick(); timers.tick();
    assert.deepStrictEqual(seen, ["Cursor"], "unsubscribed listener must not receive further events");
    detector.stop();
  });

  it("unsubscribe affects only the unsubscribed listener, others still fire", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    const seenA = [];
    const seenB = [];
    const offA = detector.onAppChange((evt) => seenA.push(evt.name));
    detector.onAppChange((evt) => seenB.push(evt.name));
    detector.start();
    timers.tick(); timers.tick();
    assert.deepStrictEqual(seenA, ["Cursor"]);
    assert.deepStrictEqual(seenB, ["Cursor"]);
    offA();
    front.state.nextName = "Slack";
    timers.tick(); timers.tick();
    assert.deepStrictEqual(seenA, ["Cursor"], "A should not have received the Slack event");
    assert.deepStrictEqual(seenB, ["Cursor", "Slack"], "B should still receive the Slack event");
    detector.stop();
  });
});

// ── Lifecycle: start/stop semantics ──────────────────────────────────────
describe("workspace-detector: start/stop lifecycle", () => {
  it("start() is idempotent — calling twice does not register two intervals", () => {
    const { detector, timers, front } = buildDetector();
    detector.start();
    detector.start(); // second call should be a no-op (fake setInterval asserts single registration)
    timers.tick();
    assert.strictEqual(front.state.calls, 1);
    detector.stop();
  });

  it("stop() clears the interval and getCurrentApp returns the last confirmed app", () => {
    const front = makeFrontAppStub("Cursor");
    const { detector, timers } = buildDetector({ front });
    detector.start();
    timers.tick(); timers.tick();
    assert.deepStrictEqual(detector.getCurrentApp(), {
      name: "Cursor",
      category: "code",
      sinceMs: 10000, // two 5s ticks → confirmedSince = T=10000
    });
    detector.stop();
    assert.strictEqual(timers.isArmed(), false, "stop() must clear the interval");
    // After stop, ticks must not be re-armed automatically.
  });

  it("getCurrentApp returns null when no app has been confirmed yet", () => {
    const { detector, timers } = buildDetector();
    assert.strictEqual(detector.getCurrentApp(), null);
    detector.start();
    timers.tick(); // first tick only sets candidate, no confirm
    assert.strictEqual(detector.getCurrentApp(), null);
    detector.stop();
  });

  // Late-capture guard: in production captureFrontApp is async (osascript
  // subprocess + 500ms timeout). If the detector is stopped between the
  // tick scheduling the probe and the probe's callback firing, the
  // `if (!intervalHandle) return;` guard drops the result. Without it, a
  // late capture could promote a candidate after stop() and emit a stale
  // event to subscribers (a real-world race during app quit).
  //
  // We use a `mode` switch (immediate vs deferred) so the SAME captureFrontApp
  // reference passed to the detector at construction time can change
  // behavior partway through the test — needed because the detector binds
  // ctx.captureFrontApp at init, not per-call.
  it("drops a late captureFrontApp callback that fires after stop()", () => {
    let mode = "immediate";
    let immediateName = "Cursor";
    let deferredCb = null;
    const captureFrontApp = (cb) => {
      if (mode === "immediate") cb(immediateName);
      else deferredCb = cb;
    };
    const timers = makeFakeTimers();
    const detector = initWorkspaceDetector({
      getPrefs: () => buildPrefs(),
      osPermission: makeOsPermissionStub("granted").osPermission,
      captureFrontApp,
      log: () => {},
      now: timers.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    // First confirm via the immediate path so we have a known confirmedApp.
    detector.start();
    timers.tick(); timers.tick();
    const before = detector.getCurrentApp();
    assert.deepStrictEqual(before && before.name, "Cursor");

    // Switch to deferred mode. Each tick now schedules a probe whose
    // callback (deferredCb) we hold; firing it later simulates osascript
    // returning after the detector was already stopped.
    mode = "deferred";
    const seen = [];
    detector.onAppChange((evt) => seen.push(evt.name));
    timers.tick(); // schedules deferred probe
    timers.tick(); // overwrites deferredCb with the latest pending probe

    detector.stop();
    // Fire the held callback AFTER stop. The guard must drop it.
    assert.strictEqual(typeof deferredCb, "function", "deferred callback should have been captured");
    deferredCb("Slack");
    assert.deepStrictEqual(seen, [], "late capture must not emit onAppChange after stop()");
    const after = detector.getCurrentApp();
    assert.deepStrictEqual(after && after.name, "Cursor", "late capture must not mutate confirmedApp");
  });
});

// ── Constructor argument validation ──────────────────────────────────────
describe("workspace-detector: ctx validation", () => {
  it("throws when getPrefs is missing", () => {
    assert.throws(() => initWorkspaceDetector({
      osPermission: { isGranted: () => "granted" },
      captureFrontApp: () => {},
    }), /getPrefs/);
  });

  it("throws when osPermission is missing", () => {
    assert.throws(() => initWorkspaceDetector({
      getPrefs: () => ({}),
      captureFrontApp: () => {},
    }), /osPermission/);
  });

  it("throws when captureFrontApp is missing", () => {
    assert.throws(() => initWorkspaceDetector({
      getPrefs: () => ({}),
      osPermission: { isGranted: () => "granted" },
    }), /captureFrontApp/);
  });

  // Loud-fail at init when timer plumbing is half-wired. Prevents tests
  // (or future callers) from mixing real and injected timers, which would
  // silently leak handles on stop().
  it("throws when setInterval is provided without clearInterval", () => {
    assert.throws(() => initWorkspaceDetector({
      getPrefs: () => ({}),
      osPermission: { isGranted: () => "granted" },
      captureFrontApp: () => {},
      setInterval: () => 1,
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });

  it("throws when clearInterval is provided without setInterval", () => {
    assert.throws(() => initWorkspaceDetector({
      getPrefs: () => ({}),
      osPermission: { isGranted: () => "granted" },
      captureFrontApp: () => {},
      clearInterval: () => {},
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });
});

// ── front-app wrapper smoke tests (PAWPAL-2 review #7) ───────────────────
// captureFrontApp is currently exercised only in production by the
// detector and permission.js. These tests pin the wrapper's contract: it
// trims whitespace on success, and returns null on error. Both behaviors
// are load-bearing for upstream callers (workspace-detector treats null
// as "no observation this tick"; permission.js skips focus restore on
// null).
describe("front-app: captureFrontApp wrapper contract", () => {
  const { captureFrontApp } = require("../src/lib/front-app");

  it("trims whitespace from osascript stdout and forwards to cb", () => {
    const stub = (_cmd, _args, _opts, cb) => cb(null, "  Cursor  \n", "");
    let received;
    captureFrontApp(
      (name) => { received = name; },
      { platform: "darwin", execFileOverride: stub },
    );
    assert.strictEqual(received, "Cursor");
  });

  it("forwards null to cb when execFile errors (timeout / not-authorized / etc.)", () => {
    const stub = (_cmd, _args, _opts, cb) => cb(new Error("timeout"), "", "");
    let received = "sentinel";
    captureFrontApp(
      (name) => { received = name; },
      { platform: "darwin", execFileOverride: stub },
    );
    assert.strictEqual(received, null);
  });

  it("short-circuits to cb(null) on non-mac platforms without spawning anything", () => {
    let spawnCount = 0;
    const stub = () => { spawnCount += 1; };
    let received = "sentinel";
    captureFrontApp(
      (name) => { received = name; },
      { platform: "linux", execFileOverride: stub },
    );
    assert.strictEqual(received, null);
    assert.strictEqual(spawnCount, 0, "non-mac path must NOT spawn");
  });
});
