"use strict";

// PAWPAL-2 Task 5 — system-monitor.js unit tests.
//
// The monitor combines two pure signal sources (typing rate, CPU pressure)
// into a single state machine that fires onStuckOnProblem. These tests
// inject every external (execFile, keystrokeSource, prefs, osPermission,
// now, setInterval/clearInterval) so we exercise every branch — gating,
// cooldown, parse failure, ctx validation — without spawning real `top`
// or waiting on real keystroke events.
//
// Coverage (cases A-L from the plan):
//   A. Typing rate decays correctly across 60s window.
//   B. getTypingRate returns null when no keystrokeSource wired.
//   C. CPU parse handles standard macOS `top` output.
//   D. CPU parse returns null on garbage output (and logs once).
//   E. Stuck-on-problem fires when BOTH typing pause >= 30s AND CPU >= 2 min.
//   F. Stuck-on-problem 15-min cooldown — no re-fire within 15 min.
//   G. Silent no-op when prefs.workspaceAwareness.systemMonitor.enabled false.
//   H. Silent no-op when osPermission.inputMonitoring not granted.
//   I. Non-macOS getCpuPressure returns null (no execFile calls).
//   J. ctx-validation throws when setIntervalFn provided without clearIntervalFn.
//   K. reload() does NOT clear lastStuckFireAt (documented behavior — past
//      stuck history is fatigue tracking, NOT something a pref toggle wipes).
//   L. unsubscribe (from onStuckOnProblem) removes the listener.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initSystemMonitor = require("../src/system-monitor");

// ── Fake-timer harness ────────────────────────────────────────────────────
//
// The monitor registers TWO intervals when a keystrokeSource is wired (typing
// + CPU); one interval when not (CPU only). Our harness tracks both, lets
// the test drive each independently. nowMs is advanced explicitly between
// `tick` calls.
function makeFakeTimers() {
  let nowMs = 0;
  const registered = new Map(); // handle -> { fn, intervalMs }
  let nextHandle = 1;
  return {
    now: () => nowMs,
    advance: (delta) => { nowMs += delta; },
    setNow: (t) => { nowMs = t; },
    setInterval: (fn, intervalMs) => {
      const handle = nextHandle++;
      registered.set(handle, { fn, intervalMs });
      return handle;
    },
    clearInterval: (handle) => {
      registered.delete(handle);
    },
    // Tick a specific interval by its intervalMs (matches against any
    // registered interval). Doesn't auto-advance time — caller decides.
    tickByInterval: (intervalMs) => {
      for (const entry of registered.values()) {
        if (entry.intervalMs === intervalMs) entry.fn();
      }
    },
    // Fire the typing-poll tick (1s default). Does NOT advance the clock;
    // caller advances explicitly via advance() between ticks.
    tickTyping: function () { this.tickByInterval(1000); },
    // Fire the CPU-poll tick (30s default). Same advance discipline.
    tickCpu: function () { this.tickByInterval(30000); },
    countIntervals: () => registered.size,
    isArmed: (intervalMs) => Array.from(registered.values()).some((e) => e.intervalMs === intervalMs),
  };
}

// keystrokeSource stub. Exposes `tap()` to inject a synthetic keystroke
// event (the monitor's recordKeystroke callback fires through subscribe).
function makeKeystrokeSource() {
  const listeners = new Set();
  return {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    subscribe(cb) {
      this.subscribeCalls += 1;
      listeners.add(cb);
      return () => {
        this.unsubscribeCalls += 1;
        listeners.delete(cb);
      };
    },
    tap() {
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
  };
}

// execFile stub. Returns a configurable response on each call. `responses`
// is a queue — pop one per call; falls back to the last entry once drained.
// Each response: { err?, stdout? }.
function makeExecFileStub(responses) {
  const state = {
    calls: 0,
    queue: Array.isArray(responses) ? [...responses] : [{ err: null, stdout: "" }],
    last: null,
  };
  function execFile(cmd, args, opts, cb) {
    state.calls += 1;
    state.last = { cmd, args, opts };
    const resp = state.queue.length > 1 ? state.queue.shift() : state.queue[0];
    // Cb is async in the real implementation; for tests we fire it
    // synchronously so we don't need an event-loop tick to observe state.
    cb(resp.err || null, resp.stdout || "", resp.stderr || "");
  }
  return { execFile, state };
}

// osPermission stub. State is mutable so tests can flip grants mid-run.
function makeOsPermissionStub(initial) {
  const state = {
    accessibility: (initial && initial.accessibility) || "granted",
    inputMonitoring: (initial && initial.inputMonitoring) || "granted",
  };
  return {
    state,
    osPermission: {
      isGranted: (kind) => state[kind] || "denied",
    },
  };
}

// Default prefs — feature ON, typing pause 30s, CPU 70%/2min. Tests override
// shallowly via the overrides arg.
function buildPrefs(overrides) {
  const base = {
    workspaceAwareness: {
      enabled: true,
      systemMonitor: {
        enabled: true,
        typingPauseThresholdMs: 30000,
        cpuStressThresholdPct: 70,
        cpuStressDurationMs: 120000,
      },
    },
  };
  if (!overrides) return base;
  const out = JSON.parse(JSON.stringify(base));
  if (overrides.workspaceAwareness) {
    Object.assign(out.workspaceAwareness, overrides.workspaceAwareness);
    if (overrides.workspaceAwareness.systemMonitor) {
      out.workspaceAwareness.systemMonitor = Object.assign(
        {},
        base.workspaceAwareness.systemMonitor,
        overrides.workspaceAwareness.systemMonitor,
      );
    }
  }
  return out;
}

// One-call assembly helper. Returns { monitor, timers, exec, osPerm, source, prefsBox, logs }.
function buildMonitor(opts) {
  const o = opts || {};
  const timers = o.timers || makeFakeTimers();
  const osPerm = o.osPerm || makeOsPermissionStub();
  const exec = o.exec || makeExecFileStub([{ err: null, stdout: "CPU usage: 12.34% user, 5.67% sys, 81.99% idle\n" }]);
  const source = o.source === null ? null : (o.source || makeKeystrokeSource());
  const prefsBox = { current: o.prefs || buildPrefs() };
  const logs = [];
  const ctx = {
    getPrefs: () => prefsBox.current,
    osPermission: osPerm.osPermission,
    log: (level, msg, err) => { logs.push({ level, msg, err: err && err.message }); },
    now: timers.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    execFile: exec.execFile,
    platform: o.platform || "darwin",
  };
  if (source) ctx.keystrokeSource = source;
  const monitor = initSystemMonitor(ctx);
  return { monitor, timers, exec, osPerm, source, prefsBox, logs };
}

// ── Case A: typing rate decays across the 60s window ─────────────────────
describe("system-monitor: Case A — typing rate decays across 60s window", () => {
  it("counts keystrokes within the rolling window and decays them out", () => {
    const { monitor, timers, source } = buildMonitor();
    monitor.start();
    // Inject 10 keystrokes at T=0.
    for (let i = 0; i < 10; i += 1) source.tap();
    // Default window is 60s, so all 10 are inside. Rate = 10 * 60s/60s = 10/min.
    assert.strictEqual(monitor.getTypingRate(), 10);
    // Advance 30s, add 5 more keystrokes. Total = 15, all within window.
    timers.advance(30000);
    for (let i = 0; i < 5; i += 1) source.tap();
    assert.strictEqual(monitor.getTypingRate(), 15);
    // Advance to T=60001 — the original 10 from T=0 should fall out
    // (cutoff = 60001 - 60000 = 1, so anything before T=1 dropped).
    timers.advance(30001);
    // Only the 5 keystrokes at T=30000 remain. Rate = 5/min.
    assert.strictEqual(monitor.getTypingRate(), 5);
    // Advance another 30s+ so even those fall out. Rate -> null
    // (empty window).
    timers.advance(30001);
    assert.strictEqual(monitor.getTypingRate(), null, "empty window should return null");
    monitor.stop();
  });
});

// ── Case B: getTypingRate returns null when no keystrokeSource wired ─────
describe("system-monitor: Case B — null typing rate when no keystrokeSource", () => {
  it("returns null even after the typing tick runs (no source attached)", () => {
    const { monitor, timers } = buildMonitor({ source: null });
    monitor.start();
    timers.advance(5000);
    timers.tickTyping(); // no typing interval registered without source
    assert.strictEqual(monitor.getTypingRate(), null);
    monitor.stop();
  });

  it("does NOT register a typing-poll interval when no keystrokeSource is wired", () => {
    const { monitor, timers } = buildMonitor({ source: null });
    monitor.start();
    // CPU poll registered (30s) but typing poll (1s) should not be.
    assert.strictEqual(timers.isArmed(30000), true, "CPU poll should be armed");
    assert.strictEqual(timers.isArmed(1000), false, "typing poll should NOT be armed without source");
    monitor.stop();
  });
});

// ── Case C: CPU parse handles standard macOS `top` output ────────────────
describe("system-monitor: Case C — CPU parse handles standard macOS top output", () => {
  it("parses 'CPU usage: 12.34% user, 5.67% sys, 81.99% idle' into 18.01% pressure", () => {
    const { monitor } = buildMonitor();
    const pressure = monitor.__test.parseTopCpuLine(
      "CPU usage: 12.34% user, 5.67% sys, 81.99% idle\n",
    );
    // 12.34 + 5.67 = 18.01. Use closeTo because floats.
    assert.ok(Math.abs(pressure - 18.01) < 1e-6, `expected ~18.01, got ${pressure}`);
  });

  it("parses integer-only output (no decimals)", () => {
    const { monitor } = buildMonitor();
    const pressure = monitor.__test.parseTopCpuLine(
      "CPU usage: 50% user, 20% sys, 30% idle\n",
    );
    assert.strictEqual(pressure, 70);
  });

  it("ignores surrounding lines and matches only the CPU usage line", () => {
    const { monitor } = buildMonitor();
    const output = "Processes: 542 total\nLoad Avg: 1.20, 1.15, 1.10\nCPU usage: 30% user, 10% sys, 60% idle\nSharedLibs: ...\n";
    const pressure = monitor.__test.parseTopCpuLine(output);
    assert.strictEqual(pressure, 40);
  });

  it("getCpuPressure reflects the parsed sample after a poll tick", () => {
    const exec = makeExecFileStub([
      { err: null, stdout: "CPU usage: 45.5% user, 14.5% sys, 40.0% idle\n" },
    ]);
    const { monitor, timers } = buildMonitor({ exec });
    monitor.start();
    timers.tickCpu();
    assert.strictEqual(monitor.getCpuPressure(), 60);
    monitor.stop();
  });
});

// ── Case D: CPU parse returns null on garbage output ─────────────────────
describe("system-monitor: Case D — CPU parse returns null on garbage and log-once", () => {
  it("returns null when stdout doesn't contain a CPU usage line", () => {
    const { monitor } = buildMonitor();
    assert.strictEqual(monitor.__test.parseTopCpuLine("garbage output\n"), null);
    assert.strictEqual(monitor.__test.parseTopCpuLine(""), null);
    assert.strictEqual(monitor.__test.parseTopCpuLine(null), null);
  });

  it("returns null when values would be out of [0,100] (defensive against parse mishap)", () => {
    const { monitor } = buildMonitor();
    // 200 + 50 = 250 — out of range, return null.
    assert.strictEqual(
      monitor.__test.parseTopCpuLine("CPU usage: 200% user, 50% sys, 0% idle\n"),
      null,
    );
  });

  it("logs the parse failure only ONCE per session (avoids spam)", () => {
    const exec = makeExecFileStub([
      { err: null, stdout: "first garbage" },
      { err: null, stdout: "second garbage" },
      { err: null, stdout: "third garbage" },
    ]);
    const { monitor, timers, logs } = buildMonitor({ exec });
    monitor.start();
    timers.tickCpu();
    timers.tickCpu();
    timers.tickCpu();
    const parseFailLogs = logs.filter((l) => /parse failed/i.test(l.msg));
    assert.strictEqual(parseFailLogs.length, 1, `expected exactly 1 parse-fail log, got ${parseFailLogs.length}`);
    // getCpuPressure should be null after garbage.
    assert.strictEqual(monitor.getCpuPressure(), null);
    monitor.stop();
  });

  it("logs the spawn failure (err arg) only ONCE per session", () => {
    const exec = makeExecFileStub([
      { err: new Error("boom"), stdout: "" },
      { err: new Error("boom"), stdout: "" },
    ]);
    const { monitor, timers, logs } = buildMonitor({ exec });
    monitor.start();
    timers.tickCpu();
    timers.tickCpu();
    const spawnFailLogs = logs.filter((l) => /spawn failed/i.test(l.msg));
    assert.strictEqual(spawnFailLogs.length, 1);
    monitor.stop();
  });
});

// ── Case E: stuck-on-problem fires when BOTH conditions hold ─────────────
describe("system-monitor: Case E — stuck-on-problem requires BOTH typing pause AND CPU sustain", () => {
  it("fires when typing pause >= 30s AND CPU >= 70% sustained >= 2 min", () => {
    // Sequence: keystrokes, then 30s+ silence, while CPU stays high for 2 min+.
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 5% sys, 15% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    // T=0: user types. lastKeystrokeAt = 0.
    source.tap();
    // T=30: CPU poll lands. cpuPressurePct = 85 -> cpuStressSince = 30000.
    timers.advance(30000);
    timers.tickCpu();
    // Now typing pause = 30s (>= threshold). CPU sustained = 0 (just started). Not yet.
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    timers.tickTyping(); // evaluator sees both gates: typing OK, CPU not yet sustained.
    assert.strictEqual(stuckEvents.length, 0, "should NOT fire — CPU not sustained yet");
    // Advance another 2 min so CPU has been > 70% for >= 120s.
    timers.advance(120000);
    timers.tickCpu(); // re-confirm CPU is still high; cpuStressSince persists.
    timers.tickTyping(); // now typing pause >= 150s AND CPU sustained 120s. Fires.
    assert.strictEqual(stuckEvents.length, 1, "should fire when both conditions met");
    assert.ok(stuckEvents[0].typingPauseMs >= 30000);
    assert.ok(stuckEvents[0].cpuStressDurationMs >= 120000);
    monitor.stop();
  });

  it("does NOT fire when only typing pause holds (CPU below threshold)", () => {
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 10% user, 5% sys, 85% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    source.tap(); // T=0
    timers.advance(60000); // typing pause = 60s
    timers.tickCpu(); // CPU = 15% — below 70%. cpuStressSince stays null.
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 0, "typing-pause-only must NOT fire");
    monitor.stop();
  });

  it("does NOT fire when only CPU sustained (user is actively typing)", () => {
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 5% sys, 15% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    // Type continuously: a keystroke every 5s. CPU stays high.
    for (let i = 0; i < 30; i += 1) {
      source.tap();
      timers.advance(5000);
      timers.tickCpu(); // every 30s in real time, but firing every iteration is fine
      timers.tickTyping();
    }
    assert.strictEqual(stuckEvents.length, 0, "active typing must NOT fire even with sustained CPU");
    monitor.stop();
  });

  it("does NOT fire when CPU drops below threshold mid-window (window resets)", () => {
    // Sequence: CPU goes 80% (start window), then 50% (window resets), then
    // 80% again (window starts over). Total elapsed > 2 min but no
    // contiguous 2-min stretch.
    const exec = makeExecFileStub([
      { err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" },
      { err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" },
      { err: null, stdout: "CPU usage: 30% user, 0% sys, 70% idle\n" }, // drop
      { err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" },
    ]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    source.tap(); // T=0
    timers.advance(60000); // typing pause = 60s
    timers.tickCpu(); // high — window starts at T=60s
    timers.advance(30000); // T=90s
    timers.tickCpu(); // still high — window continues
    timers.advance(30000); // T=120s
    timers.tickCpu(); // DROPS below threshold — window resets to null
    timers.advance(30000); // T=150s
    timers.tickCpu(); // high again — new window starts at T=150s, only 0s elapsed
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 0, "discontiguous CPU stress must NOT fire");
    monitor.stop();
  });
});

// ── Case F: 15-min cooldown between fires ────────────────────────────────
describe("system-monitor: Case F — 15-min cooldown between stuck-on-problem fires", () => {
  it("does NOT fire a second time within 15 min of the first fire", () => {
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    source.tap(); // T=0
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    // Drive into first fire at T~150s.
    timers.advance(30000);
    timers.tickCpu(); // T=30: cpuStressSince=30
    timers.advance(120000);
    timers.tickCpu(); // T=150: still high
    timers.tickTyping(); // T=150: typing pause=150s, cpu sustained=120s -> fire
    assert.strictEqual(stuckEvents.length, 1);
    // Stay in stuck conditions for another 14 min. No re-fire.
    timers.advance(14 * 60_000);
    timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 1, "no re-fire within 15min cooldown");
    // Advance one more minute (total 15min from first fire). Re-fire allowed.
    timers.advance(60_000 + 1);
    timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 2, "should fire again after 15min cooldown");
    monitor.stop();
  });
});

// ── Case G: silent no-op when systemMonitor.enabled === false ────────────
describe("system-monitor: Case G — silent no-op when systemMonitor.enabled false", () => {
  it("does NOT call execFile when prefs.workspaceAwareness.systemMonitor.enabled is false", () => {
    const prefs = buildPrefs({
      workspaceAwareness: { enabled: true, systemMonitor: { enabled: false } },
    });
    const { monitor, timers, exec } = buildMonitor({ prefs });
    monitor.start();
    timers.tickCpu();
    timers.tickCpu();
    timers.tickCpu();
    assert.strictEqual(exec.state.calls, 0, "no execFile calls under gated state");
    monitor.stop();
  });

  it("does NOT call execFile when prefs.workspaceAwareness.enabled is false (root gate)", () => {
    const prefs = buildPrefs({
      workspaceAwareness: { enabled: false, systemMonitor: { enabled: true } },
    });
    const { monitor, timers, exec } = buildMonitor({ prefs });
    monitor.start();
    timers.tickCpu();
    timers.tickCpu();
    assert.strictEqual(exec.state.calls, 0);
    monitor.stop();
  });

  it("getCpuPressure returns null when gated", () => {
    const prefs = buildPrefs({
      workspaceAwareness: { enabled: true, systemMonitor: { enabled: false } },
    });
    const { monitor, timers } = buildMonitor({ prefs });
    monitor.start();
    timers.tickCpu();
    assert.strictEqual(monitor.getCpuPressure(), null);
    monitor.stop();
  });
});

// ── Case H: silent no-op when osPermission inputMonitoring not granted ───
describe("system-monitor: Case H — silent typing no-op when Input Monitoring denied", () => {
  it("getTypingRate returns null when osPermission.inputMonitoring !== granted", () => {
    const osPerm = makeOsPermissionStub({ inputMonitoring: "denied" });
    const { monitor, timers, source } = buildMonitor({ osPerm });
    monitor.start();
    source.tap();
    source.tap();
    source.tap();
    // Even with keystrokes recorded, gate makes getTypingRate null.
    assert.strictEqual(monitor.getTypingRate(), null);
    monitor.stop();
  });

  it("stuck-on-problem does NOT fire when typing gate is closed (signal is unknown)", () => {
    const osPerm = makeOsPermissionStub({ inputMonitoring: "unknown" });
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ osPerm, exec });
    monitor.start();
    source.tap();
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    // Set up the "would-have-fired" scenario.
    timers.advance(30000); timers.tickCpu();
    timers.advance(120000); timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 0, "unknown typing signal must suppress fire");
    monitor.stop();
  });

  it("resumes typing rate after gate flips to granted", () => {
    const osPerm = makeOsPermissionStub({ inputMonitoring: "denied" });
    const { monitor, timers, source } = buildMonitor({ osPerm });
    monitor.start();
    source.tap();
    source.tap();
    assert.strictEqual(monitor.getTypingRate(), null);
    osPerm.state.inputMonitoring = "granted";
    // Same recorded keystrokes — now visible because gate is open.
    assert.strictEqual(monitor.getTypingRate(), 2);
    monitor.stop();
  });
});

// ── Case I: non-macOS → getCpuPressure null + no execFile calls ──────────
describe("system-monitor: Case I — non-macOS platform skips CPU probe", () => {
  it("on linux, never calls execFile and getCpuPressure returns null", () => {
    const { monitor, timers, exec } = buildMonitor({ platform: "linux" });
    monitor.start();
    timers.tickCpu();
    timers.tickCpu();
    assert.strictEqual(exec.state.calls, 0, "linux must not spawn top");
    assert.strictEqual(monitor.getCpuPressure(), null);
    monitor.stop();
  });

  it("on win32, never calls execFile and getCpuPressure returns null", () => {
    const { monitor, timers, exec } = buildMonitor({ platform: "win32" });
    monitor.start();
    timers.tickCpu();
    assert.strictEqual(exec.state.calls, 0);
    assert.strictEqual(monitor.getCpuPressure(), null);
    monitor.stop();
  });

  it("on non-mac, stuck-on-problem can't fire (CPU signal stays unknown)", () => {
    const { monitor, timers, source } = buildMonitor({ platform: "linux" });
    monitor.start();
    source.tap();
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    timers.advance(150000);
    timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 0, "non-mac must not fire — CPU signal unknown");
    monitor.stop();
  });
});

// ── Case J: ctx-validation throws on half-wired timer plumbing ───────────
describe("system-monitor: Case J — ctx validation (pair-check timers)", () => {
  it("throws when setInterval provided without clearInterval", () => {
    assert.throws(() => initSystemMonitor({
      getPrefs: () => ({}),
      osPermission: { isGranted: () => "granted" },
      setInterval: () => 1,
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });

  it("throws when clearInterval provided without setInterval", () => {
    assert.throws(() => initSystemMonitor({
      getPrefs: () => ({}),
      osPermission: { isGranted: () => "granted" },
      clearInterval: () => {},
    }), /setInterval and ctx\.clearInterval must be provided together/);
  });

  it("throws when getPrefs is missing", () => {
    assert.throws(() => initSystemMonitor({
      osPermission: { isGranted: () => "granted" },
    }), /getPrefs/);
  });

  it("throws when osPermission is missing", () => {
    assert.throws(() => initSystemMonitor({
      getPrefs: () => ({}),
    }), /osPermission/);
  });
});

// ── Case K: reload() does NOT clear lastStuckFireAt ──────────────────────
describe("system-monitor: Case K — reload() preserves stuck-fire history", () => {
  it("reload() does NOT reset lastStuckFireAt (fatigue history must persist)", () => {
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    source.tap();
    let stuckEvents = [];
    monitor.onStuckOnProblem((evt) => stuckEvents.push(evt));
    // Drive a fire at T~150s.
    timers.advance(30000); timers.tickCpu();
    timers.advance(120000); timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEvents.length, 1);
    const stateBefore = monitor.__test.getInternalState();
    assert.ok(stateBefore.lastStuckFireAt !== null, "fire should have set lastStuckFireAt");
    // Now reload. lastStuckFireAt should be preserved.
    monitor.reload();
    const stateAfter = monitor.__test.getInternalState();
    assert.strictEqual(
      stateAfter.lastStuckFireAt,
      stateBefore.lastStuckFireAt,
      "reload() must NOT clear lastStuckFireAt — past stuck history is fatigue tracking",
    );
    // And cpuStressSince SHOULD be cleared (reload's documented effect).
    assert.strictEqual(stateAfter.cpuStressSince, null, "reload() should clear cpuStressSince");
    monitor.stop();
  });
});

// ── Case L: unsubscribe removes the listener ─────────────────────────────
describe("system-monitor: Case L — unsubscribe removes the onStuckOnProblem listener", () => {
  it("after unsubscribe(), the listener never receives further fires", () => {
    const exec = makeExecFileStub([{ err: null, stdout: "CPU usage: 80% user, 0% sys, 20% idle\n" }]);
    const { monitor, timers, source } = buildMonitor({ exec });
    monitor.start();
    let stuckEventsA = [];
    let stuckEventsB = [];
    const offA = monitor.onStuckOnProblem((evt) => stuckEventsA.push(evt));
    monitor.onStuckOnProblem((evt) => stuckEventsB.push(evt));
    source.tap();
    timers.advance(30000); timers.tickCpu();
    timers.advance(120000); timers.tickCpu();
    timers.tickTyping(); // first fire
    assert.strictEqual(stuckEventsA.length, 1);
    assert.strictEqual(stuckEventsB.length, 1);
    offA();
    // Drive a second fire (after the 15-min cooldown).
    timers.advance(16 * 60_000);
    timers.tickCpu();
    timers.tickTyping();
    assert.strictEqual(stuckEventsA.length, 1, "A should not have received the 2nd fire");
    assert.strictEqual(stuckEventsB.length, 2, "B should still receive the 2nd fire");
    monitor.stop();
  });

  it("onStuckOnProblem throws on non-function callback", () => {
    const { monitor } = buildMonitor();
    assert.throws(() => monitor.onStuckOnProblem(null), /must be a function/);
    assert.throws(() => monitor.onStuckOnProblem("nope"), /must be a function/);
  });
});

// ── Lifecycle: start/stop semantics ──────────────────────────────────────
describe("system-monitor: start/stop lifecycle", () => {
  it("start() is idempotent — calling twice does not double-register intervals", () => {
    const { monitor, timers } = buildMonitor();
    monitor.start();
    const countAfterFirstStart = timers.countIntervals();
    monitor.start();
    assert.strictEqual(timers.countIntervals(), countAfterFirstStart, "second start() should be a no-op");
    monitor.stop();
  });

  it("stop() clears intervals and unsubscribes the keystroke source", () => {
    const { monitor, timers, source } = buildMonitor();
    monitor.start();
    assert.strictEqual(source.subscribeCalls, 1, "start() should subscribe once");
    assert.ok(timers.countIntervals() >= 1);
    monitor.stop();
    assert.strictEqual(timers.countIntervals(), 0, "stop() must clear all intervals");
    assert.strictEqual(source.unsubscribeCalls, 1, "stop() must unsubscribe the keystroke source");
  });

  it("stop() drops late execFile callbacks (guard against post-stop result)", () => {
    // Deferred-callback exec stub. The CPU sample callback is captured but
    // not fired until we call deferredCb explicitly — simulating a slow
    // `top` subprocess that returns after the monitor was stopped.
    let deferredCb = null;
    const exec = (cmd, args, opts, cb) => { deferredCb = cb; };
    const timers = makeFakeTimers();
    const monitor = initSystemMonitor({
      getPrefs: () => buildPrefs(),
      osPermission: makeOsPermissionStub().osPermission,
      log: () => {},
      now: timers.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      execFile: exec,
    });
    monitor.start();
    timers.tickCpu(); // schedules deferred probe
    monitor.stop();
    // Fire the held callback AFTER stop. The guard must drop it.
    assert.strictEqual(typeof deferredCb, "function");
    deferredCb(null, "CPU usage: 90% user, 5% sys, 5% idle\n");
    // cpuPressurePct must NOT have been updated.
    assert.strictEqual(monitor.getCpuPressure(), null);
  });
});

// ── Constants are exported for documentation/test access ─────────────────
describe("system-monitor: module constants", () => {
  it("exposes the documented defaults via module.exports", () => {
    assert.strictEqual(initSystemMonitor.DEFAULT_TYPING_POLL_MS, 1000);
    assert.strictEqual(initSystemMonitor.DEFAULT_CPU_POLL_MS, 30000);
    assert.strictEqual(initSystemMonitor.DEFAULT_TYPING_WINDOW_MS, 60000);
    assert.strictEqual(initSystemMonitor.STUCK_COOLDOWN_MS, 15 * 60_000);
    assert.strictEqual(initSystemMonitor.TOP_SPAWN_TIMEOUT_MS, 2000);
    assert.ok(initSystemMonitor.TOP_CPU_REGEX instanceof RegExp);
  });
});
