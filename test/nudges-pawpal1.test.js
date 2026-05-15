// nudges-pawpal1.test.js — unit tests for the PAWPAL-1 nudge scheduler.
// Drives fireNudge directly (via the test hook) so we don't depend on real
// timers or the Electron Notification API.

const assert = require("assert");
const initNudges = require("../src/nudges");

function makeCtx(overrides = {}) {
  const calls = {
    pushBehavior: [],
    showNativeNotification: [],
    playSound: [],
    setPrefs: [],
  };
  let prefs = {
    version: 3,
    nudges: { preset: "normal", overrides: {}, lastFiredAt: {} },
    ...(overrides.prefs || {}),
  };
  return {
    _calls: calls,
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
  };
}

// 1. normal preset fires walkAcross overlay for pomodoro, no notif/sound
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  n._fireNudgeForTesting("pomodoroBreak");
  assert.deepStrictEqual(ctx._calls.pushBehavior, [["walkAcross", 3000]],
    "should push walkAcross overlay");
  assert.strictEqual(ctx._calls.showNativeNotification.length, 0,
    "normal preset should not fire native notification");
  assert.strictEqual(ctx._calls.playSound.length, 0,
    "normal preset should not play sound");
}

// 2. coach preset fires walkAcross + notif + sound
{
  const ctx = makeCtx({ prefs: { version: 3, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("pomodoroBreak");
  assert.deepStrictEqual(ctx._calls.pushBehavior, [["walkAcross", 3000]]);
  assert.strictEqual(ctx._calls.showNativeNotification.length, 1);
  assert.ok(ctx._calls.showNativeNotification[0].title.includes("nudgePomodoroTitle"));
  assert.strictEqual(ctx._calls.playSound.length, 1);
  assert.strictEqual(ctx._calls.playSound[0], "confirm");
}

// 3. DND blocks all fires across all nudge types
{
  const ctx = makeCtx({ dnd: true, prefs: { version: 3, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("pomodoroBreak");
  n._fireNudgeForTesting("hydrate");
  n._fireNudgeForTesting("longSit");
  n._fireNudgeForTesting("lateNightYawn");
  assert.strictEqual(ctx._calls.pushBehavior.length, 0, "DND blocks all behavior pushes");
  assert.strictEqual(ctx._calls.showNativeNotification.length, 0);
  assert.strictEqual(ctx._calls.playSound.length, 0);
}

// 4. per-nudge override disables a single nudge but leaves others firing
{
  const ctx = makeCtx({
    prefs: {
      version: 3,
      nudges: { preset: "normal", overrides: { hydrate: { enabled: false } }, lastFiredAt: {} },
    },
  });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("hydrate");
  assert.strictEqual(ctx._calls.pushBehavior.length, 0, "override should disable hydrate");
  n._fireNudgeForTesting("pomodoroBreak");
  assert.strictEqual(ctx._calls.pushBehavior.length, 1, "pomodoro still fires");
}

// 5. quiet preset disables hydrate + longSit + lateNightYawn
{
  const ctx = makeCtx({ prefs: { version: 3, nudges: { preset: "quiet", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("hydrate");
  n._fireNudgeForTesting("longSit");
  n._fireNudgeForTesting("lateNightYawn");
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "quiet should disable hydrate + longSit + lateNightYawn");
  // pomodoroBreak is enabled at quiet (every 50min), still fires when pinged
  n._fireNudgeForTesting("pomodoroBreak");
  assert.strictEqual(ctx._calls.pushBehavior.length, 1);
}

// 6. firing records lastFiredAt for the nudge id
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  const before = Date.now();
  n._fireNudgeForTesting("pomodoroBreak");
  const after = Date.now();
  const setPatch = ctx._calls.setPrefs.find((p) => p.nudges && p.nudges.lastFiredAt);
  assert.ok(setPatch, "should call setPrefs with lastFiredAt");
  const ts = setPatch.nudges.lastFiredAt.pomodoroBreak;
  assert.ok(ts >= before && ts <= after, "lastFiredAt should be a current epoch ms");
}

// 7. unknown nudge id is a no-op (defensive — shouldn't crash)
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  n._fireNudgeForTesting("totallyMadeUp");
  assert.strictEqual(ctx._calls.pushBehavior.length, 0);
  assert.strictEqual(ctx._calls.setPrefs.length, 0);
}

// 8. coach pomodoro body includes the configured interval as i18n params
{
  const ctx = makeCtx({ prefs: { version: 3, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("pomodoroBreak");
  const notif = ctx._calls.showNativeNotification[0];
  assert.ok(notif.body.includes("minutes"), "body should reference minutes param: " + notif.body);
  assert.ok(notif.body.includes("25"), "body should include the coach interval (25 min): " + notif.body);
}

// 9. lateNightYawn at coach has no sound (soundFile: null)
{
  const ctx = makeCtx({ prefs: { version: 3, nudges: { preset: "coach", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("lateNightYawn");
  assert.strictEqual(ctx._calls.pushBehavior.length, 1);
  assert.deepStrictEqual(ctx._calls.pushBehavior[0], ["yawning", 5000]);
  assert.strictEqual(ctx._calls.showNativeNotification.length, 1);
  assert.strictEqual(ctx._calls.playSound.length, 0, "lateNightYawn has no sound");
}

// ---------------------------------------------------------------------------
// PAWPAL-2 invariant #2 regression: health nudges (the 4 PAWPAL-1 nudges)
// must be UNCHANGED by the addition of the 3 workspace-typed nudges. These
// tests don't subscribe to ctx.subscribeWorkspace at all — they prove that
// the health nudge path through fireNudge / shouldFire / lastFiredAt is
// not perturbed by the presence of socialHeadShake / stuckOnProblem /
// longWindowBreak in NUDGE_DEFINITIONS.
// ---------------------------------------------------------------------------

// 10. health-nudge fire pattern unchanged: each of the 4 PAWPAL-1 nudges
//     still pushes its expected overlay at normal preset, no notif/sound.
{
  const cases = [
    { id: "pomodoroBreak", expected: ["walkAcross", 3000] },
    { id: "hydrate",       expected: ["attention",  5000] },
    { id: "longSit",       expected: ["walkAcross", 3000] },
    { id: "lateNightYawn", expected: ["yawning",    5000] },
  ];
  for (const { id, expected } of cases) {
    const ctx = makeCtx();
    const n = initNudges(ctx);
    n._fireNudgeForTesting(id);
    assert.deepStrictEqual(ctx._calls.pushBehavior, [expected],
      `health nudge ${id} should push ${JSON.stringify(expected)}`);
    assert.strictEqual(ctx._calls.showNativeNotification.length, 0,
      `health nudge ${id} should NOT fire native notification at normal preset`);
    assert.strictEqual(ctx._calls.playSound.length, 0,
      `health nudge ${id} should NOT play sound at normal preset`);
  }
}

// 11. health-nudge DND gate unchanged across all 4 health nudges.
{
  const ctx = makeCtx({ dnd: true });
  const n = initNudges(ctx);
  for (const id of ["pomodoroBreak", "hydrate", "longSit", "lateNightYawn"]) {
    n._fireNudgeForTesting(id);
  }
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "DND should still block ALL 4 health nudges (invariant #3 preserved post PAWPAL-2)");
}

// 12. health-nudge preset gate unchanged: quiet still suppresses
//     hydrate/longSit/lateNightYawn (pomodoroBreak still allowed).
{
  const ctx = makeCtx({ prefs: { version: 3, nudges: { preset: "quiet", overrides: {}, lastFiredAt: {} } } });
  const n = initNudges(ctx);
  n._fireNudgeForTesting("hydrate");
  n._fireNudgeForTesting("longSit");
  n._fireNudgeForTesting("lateNightYawn");
  assert.strictEqual(ctx._calls.pushBehavior.length, 0,
    "quiet preset must still suppress hydrate + longSit + lateNightYawn after PAWPAL-2");
  n._fireNudgeForTesting("pomodoroBreak");
  assert.strictEqual(ctx._calls.pushBehavior.length, 1,
    "quiet preset must still allow pomodoroBreak after PAWPAL-2");
}

// 13. health-nudge type/source schema unchanged.
//     The 4 PAWPAL-1 nudges keep their pre-PAWPAL-2 `type` values; if
//     this regresses (e.g., someone retypes pomodoroBreak as "workspace")
//     PAWPAL-1 scheduling silently breaks.
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  assert.strictEqual(n._NUDGE_DEFINITIONS.pomodoroBreak.type, "cron");
  assert.strictEqual(n._NUDGE_DEFINITIONS.hydrate.type, "cron");
  assert.strictEqual(n._NUDGE_DEFINITIONS.longSit.type, "detector");
  assert.strictEqual(n._NUDGE_DEFINITIONS.lateNightYawn.type, "schedule");
  // None of the health nudges has a `source` field (only workspace nudges do).
  for (const id of ["pomodoroBreak", "hydrate", "longSit", "lateNightYawn"]) {
    assert.strictEqual(n._NUDGE_DEFINITIONS[id].source, undefined,
      `${id} should have NO source field (workspace-only)`);
  }
}

// 14. health-nudge lastFiredAt recording unchanged.
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  const before = Date.now();
  n._fireNudgeForTesting("longSit");
  const after = Date.now();
  const setPatch = ctx._calls.setPrefs.find((p) => p.nudges && p.nudges.lastFiredAt);
  assert.ok(setPatch, "longSit should record lastFiredAt");
  const ts = setPatch.nudges.lastFiredAt.longSit;
  assert.ok(ts >= before && ts <= after, "longSit lastFiredAt is current ms");
}

console.log("OK — nudges PAWPAL-1 unit tests pass");
