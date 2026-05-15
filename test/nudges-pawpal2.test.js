// nudges-pawpal2.test.js — unit tests for PAWPAL-2 workspace-driven nudges.
//
// The 3 new nudges (socialHeadShake, stuckOnProblem, longWindowBreak) are
// driven by detector callbacks via ctx.subscribeWorkspace(channel, callback).
// These tests inject a fake subscribeWorkspace that captures the callback
// per channel and lets the test fire detector events manually — so we don't
// have to spin up the real workspace-detector / system-monitor /
// long-window-tracker plumbing.
//
// Each scenario follows the same shape:
//   1. Build ctx with desired preset / DND / overrides.
//   2. initNudges(ctx) → run _startWorkspaceNudgesForTesting().
//   3. Fire the captured callback with a synthetic detector payload.
//   4. Assert on ctx._calls.pushBehavior / showNativeNotification / playSound.

const assert = require("assert");
const initNudges = require("../src/nudges");

function makeCtx(overrides = {}) {
  const calls = {
    pushBehavior: [],
    showNativeNotification: [],
    playSound: [],
    setPrefs: [],
    subscribeWorkspace: [],
  };
  // channel → captured callback. Tests grab from here to manually emit
  // detector events.
  const workspaceCallbacks = new Map();
  // channel → unsubscribe spy (records when nudges.stop() is called).
  const unsubscribeCalls = new Map();

  let prefs = {
    version: 4,
    nudges: { preset: "normal", overrides: {}, lastFiredAt: {} },
    ...(overrides.prefs || {}),
  };

  const ctx = {
    _calls: calls,
    _workspaceCallbacks: workspaceCallbacks,
    _unsubscribeCalls: unsubscribeCalls,
    _setPrefs(next) { prefs = next; },
    getPrefs: () => prefs,
    setPrefs: (patch) => {
      prefs = { ...prefs, ...patch };
      calls.setPrefs.push(patch);
    },
    isDndEnabled: () => !!overrides.dnd,
    pushBehavior: (b, d) => calls.pushBehavior.push([b, d]),
    showNativeNotification: (n) => calls.showNativeNotification.push(n),
    playSound: (f) => calls.playSound.push(f),
    getMouseStillSinceMs: () => overrides.stillSince || Date.now(),
    t: (k, p) => k + (p ? `:${JSON.stringify(p)}` : ""),
    subscribeWorkspace: (channel, callback) => {
      calls.subscribeWorkspace.push(channel);
      workspaceCallbacks.set(channel, callback);
      const unsub = () => {
        unsubscribeCalls.set(channel, (unsubscribeCalls.get(channel) || 0) + 1);
      };
      return unsub;
    },
  };
  return ctx;
}

// Helper: fire a synthetic detector event into the captured callback for a
// given channel. Asserts the callback is present (catching the case where
// no nudge subscribed — i.e., schema regressed).
function emit(ctx, channel, event) {
  const cb = ctx._workspaceCallbacks.get(channel);
  assert.ok(cb, `expected a callback subscribed to ${channel}`);
  cb(event);
}

// -----------------------------------------------------------------------------
// CASE A: socialHeadShake fires when category=social AND preset=normal/coach.
// -----------------------------------------------------------------------------
for (const preset of ["normal", "coach"]) {
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset, overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    `Case A (preset=${preset}): socialHeadShake should fire on category=social`);
  assert.deepStrictEqual(ctx._calls.pushBehavior[0], ["headShake", 5000],
    `Case A (preset=${preset}): headShake overlay for 5000ms (not walkAcross)`);
  if (preset === "coach") {
    assert.strictEqual(ctx._calls.showNativeNotification.length, 1,
      "Case A: coach preset fires native notification");
    // socialHeadShake has soundName=null → no playSound.
    assert.strictEqual(ctx._calls.playSound.length, 0,
      "Case A: socialHeadShake has no sound even at coach");
  } else {
    assert.strictEqual(ctx._calls.showNativeNotification.length, 0,
      "Case A: normal preset does not fire native notification");
    assert.strictEqual(ctx._calls.playSound.length, 0,
      "Case A: normal preset does not play sound");
  }
}

// -----------------------------------------------------------------------------
// CASE B: socialHeadShake does NOT fire when category != social (trigger gate).
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  // Same workspace.appChange channel, but a different category. The trigger
  // gate on socialHeadShake should drop it.
  emit(ctx, "workspace.appChange", { name: "Code", category: "code", sinceMs: Date.now() });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case B: socialHeadShake must NOT fire when category != social");
}

// -----------------------------------------------------------------------------
// CASE C: stuckOnProblem fires on system.stuckOnProblem event with normal/coach.
// -----------------------------------------------------------------------------
for (const preset of ["normal", "coach"]) {
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset, overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "system.stuckOnProblem",
    { at: Date.now(), cpuPressurePct: 85, typingPauseMs: 60_000, cpuStressDurationMs: 150_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    `Case C (preset=${preset}): stuckOnProblem should fire on system.stuckOnProblem`);
  assert.deepStrictEqual(ctx._calls.pushBehavior[0], ["thinking", 5000],
    `Case C (preset=${preset}): thinking overlay for 5000ms`);
  if (preset === "coach") {
    assert.strictEqual(ctx._calls.showNativeNotification.length, 1,
      "Case C: coach preset fires native notification");
    assert.deepStrictEqual(ctx._calls.playSound, ["confirm"],
      "Case C: stuckOnProblem plays 'confirm' sound at coach");
  } else {
    assert.strictEqual(ctx._calls.showNativeNotification.length, 0,
      "Case C: normal preset does not fire native notification");
    assert.strictEqual(ctx._calls.playSound.length, 0,
      "Case C: normal preset does not play sound");
  }
}

// -----------------------------------------------------------------------------
// CASE D: longWindowBreak fires on longWindow.fire event across ALL presets
// (including quiet — the only workspace nudge that fires in quiet mode).
// -----------------------------------------------------------------------------
for (const preset of ["quiet", "normal", "coach"]) {
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset, overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "longWindow.fire",
    { app: { name: "Slack", category: "social", sinceMs: Date.now() - 5_500_000 }, durationMs: 5_500_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    `Case D (preset=${preset}): longWindowBreak should fire on longWindow.fire`);
  assert.deepStrictEqual(ctx._calls.pushBehavior[0], ["walkAcross", 3000],
    `Case D (preset=${preset}): walkAcross overlay for 3000ms`);
}

// -----------------------------------------------------------------------------
// CASE E: DND blocks ALL 3 new nudges.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({
    dnd: true,
    prefs: { version: 4, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } },
  });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  emit(ctx, "system.stuckOnProblem",
    { at: Date.now(), cpuPressurePct: 90, typingPauseMs: 60_000, cpuStressDurationMs: 150_000 });
  emit(ctx, "longWindow.fire",
    { app: { name: "Slack", category: "social", sinceMs: 0 }, durationMs: 5_500_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case E: DND must block ALL 3 workspace nudges (invariant #3)");
  assert.strictEqual(ctx._calls.showNativeNotification.length, 0,
    "Case E: DND blocks native notifications too");
  assert.strictEqual(ctx._calls.playSound.length, 0,
    "Case E: DND blocks sounds too");
}

// -----------------------------------------------------------------------------
// CASE F: preset=quiet only fires longWindowBreak (the other 2 disabled).
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "quiet", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case F: socialHeadShake disabled at quiet");
  emit(ctx, "system.stuckOnProblem",
    { at: Date.now(), cpuPressurePct: 90, typingPauseMs: 60_000, cpuStressDurationMs: 150_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case F: stuckOnProblem disabled at quiet");
  emit(ctx, "longWindow.fire",
    { app: { name: "Slack", category: "social", sinceMs: 0 }, durationMs: 5_500_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    "Case F: longWindowBreak enabled at quiet (only workspace nudge in quiet)");
  assert.deepStrictEqual(ctx._calls.pushBehavior[0], ["walkAcross", 3000]);
}

// -----------------------------------------------------------------------------
// CASE G: per-nudge override forces off (preset enables it, override disables).
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({
    prefs: {
      version: 4,
      nudges: {
        preset: "normal",
        overrides: { socialHeadShake: { enabled: false } },
        lastFiredAt: {},
      },
    },
  });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  // Override says off — should not fire even though normal enables it.
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case G: per-nudge override.enabled=false blocks the fire");
  // Other workspace nudges still fire (override is per-nudge, not global).
  emit(ctx, "longWindow.fire",
    { app: { name: "Slack", category: "social", sinceMs: 0 }, durationMs: 5_500_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    "Case G: longWindowBreak still fires (its override is unset)");
}

// -----------------------------------------------------------------------------
// CASE H: stop() unsubscribes from all 3 detectors — no firing after stop.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();

  // Pre-stop: confirm callbacks exist for all 3 channels.
  assert.ok(ctx._workspaceCallbacks.get("workspace.appChange"));
  assert.ok(ctx._workspaceCallbacks.get("system.stuckOnProblem"));
  assert.ok(ctx._workspaceCallbacks.get("longWindow.fire"));

  // Capture pre-stop call count, then stop, then re-fire callbacks.
  n.stop();

  // Each unsubscribe should have been called once.
  assert.strictEqual(ctx._unsubscribeCalls.get("workspace.appChange"), 1,
    "Case H: stop() unsubscribed workspace.appChange");
  assert.strictEqual(ctx._unsubscribeCalls.get("system.stuckOnProblem"), 1,
    "Case H: stop() unsubscribed system.stuckOnProblem");
  assert.strictEqual(ctx._unsubscribeCalls.get("longWindow.fire"), 1,
    "Case H: stop() unsubscribed longWindow.fire");

  // The internal workspaceUnsubscribes map should be empty after stop().
  assert.strictEqual(n._workspaceUnsubscribesForTesting.size, 0,
    "Case H: workspaceUnsubscribes cleared after stop()");
}

// -----------------------------------------------------------------------------
// CASE I: workspace nudges use ctx.pushBehavior (overlay layer, NEVER setState).
// Invariant #1 — behavior overlay layer composes OVER state.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  // setState is not present on ctx by design — workspace nudges should never
  // reach for it. But explicitly trap it to catch a future regression.
  let setStateCalls = 0;
  ctx.setState = () => { setStateCalls += 1; };

  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  emit(ctx, "system.stuckOnProblem",
    { at: Date.now(), cpuPressurePct: 90, typingPauseMs: 60_000, cpuStressDurationMs: 150_000 });
  emit(ctx, "longWindow.fire",
    { app: { name: "Slack", category: "social", sinceMs: 0 }, durationMs: 5_500_000 });

  assert.strictEqual(ctx._calls.pushBehavior.length, 3,
    "Case I: all 3 workspace nudges fire via pushBehavior");
  assert.strictEqual(setStateCalls, 0,
    "Case I: workspace nudges must NEVER call ctx.setState (overlay only) — invariant #1");
}

// -----------------------------------------------------------------------------
// CASE J: workspace nudges record lastFiredAt — same pattern as health nudges.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  const before = Date.now();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: Date.now() });
  const after = Date.now();
  const setPatch = ctx._calls.setPrefs.find((p) => p.nudges && p.nudges.lastFiredAt);
  assert.ok(setPatch, "Case J: workspace nudge should record lastFiredAt via setPrefs");
  const ts = setPatch.nudges.lastFiredAt.socialHeadShake;
  assert.ok(ts >= before && ts <= after,
    "Case J: socialHeadShake lastFiredAt is a current epoch ms");
}

// -----------------------------------------------------------------------------
// CASE K: ctx.subscribeWorkspace handles unknown channels gracefully.
//   nudges.js itself only ever passes the 3 known channels (defined inline
//   in NUDGE_DEFINITIONS), so this is really a contract test on the main.js
//   subscribeWorkspace bridge — but we can prove the nudge module tolerates
//   a subscribeWorkspace impl that returns `undefined` (no-op) without
//   crashing or polluting workspaceUnsubscribes.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 4, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  // Wrap subscribeWorkspace so that for one of the channels we return
  // `undefined` instead of a function (simulating a buggy bridge). nudges.js
  // should:
  //   (a) skip storing the undefined return in workspaceUnsubscribes
  //   (b) NOT crash
  const orig = ctx.subscribeWorkspace;
  ctx.subscribeWorkspace = (channel, callback) => {
    if (channel === "workspace.appChange") {
      // Simulate a buggy/disabled bridge that returned no-op-but-not-fn.
      // The nudge module must tolerate this.
      return undefined;
    }
    return orig(channel, callback);
  };
  const n = initNudges(ctx);
  // Should NOT throw — even though one subscribe returned undefined.
  n._startWorkspaceNudgesForTesting();
  // Only the channels that returned a real fn should be in workspaceUnsubscribes.
  assert.strictEqual(n._workspaceUnsubscribesForTesting.has("socialHeadShake"), false,
    "Case K: socialHeadShake should NOT be stored (subscribeWorkspace returned undefined)");
  assert.strictEqual(n._workspaceUnsubscribesForTesting.has("stuckOnProblem"), true,
    "Case K: stuckOnProblem still stored (subscribe returned fn)");
  assert.strictEqual(n._workspaceUnsubscribesForTesting.has("longWindowBreak"), true,
    "Case K: longWindowBreak still stored (subscribe returned fn)");
  // stop() must still cleanly clear without throwing on the missing one.
  n.stop();
  assert.strictEqual(n._workspaceUnsubscribesForTesting.size, 0);

  // And: when ctx.subscribeWorkspace is entirely missing, startWorkspaceNudges
  // is a graceful no-op (no throw, no calls).
  const ctxNoSub = makeCtx({ prefs: { version: 4, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  delete ctxNoSub.subscribeWorkspace;
  const n2 = initNudges(ctxNoSub);
  n2._startWorkspaceNudgesForTesting();  // must not throw
  assert.strictEqual(n2._workspaceUnsubscribesForTesting.size, 0,
    "Case K: missing subscribeWorkspace → no-op (no subscriptions stored)");
}

// -----------------------------------------------------------------------------
// CASE L: socialHeadShake cooldown (review feedback Issue 1).
//   Workspace-detector fires once per CONFIRMED app switch, so without a
//   nudge-layer cooldown a rapid app-bouncing user (Twitter ↔ VSCode ↔ Twitter)
//   would get multiple shakes in minutes. Verify cooldownMs gate enforces
//   minimum spacing, and that fireNudge fires the SECOND time after enough
//   time has elapsed.
// -----------------------------------------------------------------------------
{
  const NOW = 1_700_000_000_000;
  const ctx = makeCtx({
    prefs: {
      version: 4,
      nudges: {
        preset: "normal",
        overrides: {},
        // Pre-seed lastFiredAt for socialHeadShake to "1 minute ago" — well
        // inside the 5-min cooldown window.
        lastFiredAt: { socialHeadShake: NOW - 60_000 },
      },
    },
  });
  // Pin Date.now() so the cooldown comparison is deterministic. (The other
  // tests don't need this because they don't assert on cooldown windows.)
  const origNow = Date.now;
  Date.now = () => NOW;

  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: NOW });
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "Case L1: socialHeadShake suppressed when last fire was 1 min ago (cooldown 5 min)");

  // Advance the clock past the 5-min cooldown. nudges.js reads Date.now() at
  // gate time, so flipping the mock is enough — no need to reload the module.
  Date.now = () => NOW + (6 * 60_000);
  emit(ctx, "workspace.appChange", { name: "Slack", category: "social", sinceMs: NOW + 6 * 60_000 });
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    "Case L2: socialHeadShake fires after cooldown clears");

  Date.now = origNow;
}

// -----------------------------------------------------------------------------
// CASE M (PAWPAL-3): integration nudges subscribe to integration.* channels.
//   Three new nudges shipped in PAWPAL-3 — musicBpmHigh, batteryLow,
//   screenLocked — each uses `type: "workspace"` (the same subscribe
//   mechanism) with channels in the integration.* namespace. Verify the
//   subscriptions register at start() and each can fire fireNudge.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 5, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  // 6 channels total: 3 PAWPAL-2 (workspace.appChange / system.stuckOnProblem
  // / longWindow.fire) + 3 PAWPAL-3 (integration.musicBpmHigh /
  // integration.batteryLow / integration.screenLock).
  assert.strictEqual(ctx._calls.subscribeWorkspace.length, 6,
    "Case M: 6 workspace-typed subscriptions registered");
  assert.ok(ctx._workspaceCallbacks.get("integration.musicBpmHigh"));
  assert.ok(ctx._workspaceCallbacks.get("integration.batteryLow"));
  assert.ok(ctx._workspaceCallbacks.get("integration.screenLock"));

  // Fire each integration channel and verify the corresponding behavior is
  // pushed via ctx.pushBehavior.
  emit(ctx, "integration.musicBpmHigh", { name: "Track", artist: "Artist", bpm: 130, at: Date.now() });
  emit(ctx, "integration.batteryLow", { pct: 15, at: Date.now() });
  emit(ctx, "integration.screenLock", { at: Date.now(), source: "lock-screen" });

  const behaviors = ctx._calls.pushBehavior.map((c) => c[0]);
  assert.ok(behaviors.includes("headBob"), "Case M: musicBpmHigh pushes headBob");
  assert.ok(behaviors.includes("carrying"), "Case M: batteryLow pushes carrying");
  assert.ok(behaviors.includes("sleeping"), "Case M: screenLocked pushes sleeping");
}

// -----------------------------------------------------------------------------
// CASE N (PAWPAL-3): quiet preset blocks musicBpmHigh + screenLocked but
//   keeps batteryLow firing (safety signal). Mirrors the quiet-preset rule
//   for the PAWPAL-2 nudges.
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({ prefs: { version: 5, nudges: { preset: "quiet", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._startWorkspaceNudgesForTesting();
  emit(ctx, "integration.musicBpmHigh", { name: "x", artist: "y", bpm: 130, at: Date.now() });
  emit(ctx, "integration.batteryLow", { pct: 10, at: Date.now() });
  emit(ctx, "integration.screenLock", { at: Date.now(), source: "lock-screen" });
  const behaviors = ctx._calls.pushBehavior.map((c) => c[0]);
  assert.strictEqual(behaviors.length, 1, "Case N: quiet allows only one of the 3 integration nudges");
  assert.strictEqual(behaviors[0], "carrying",
    "Case N: only batteryLow fires under quiet (safety signal)");
}

console.log("OK — nudges PAWPAL-2 unit tests pass");
