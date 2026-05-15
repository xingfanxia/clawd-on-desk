// test/nudges-pawpal4.test.js — personality-driven scheduling weights.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const initNudges = require("../src/nudges");

function makeCtx({ prefs, personality } = {}) {
  let prefsValue = prefs || { version: 6 };
  return {
    getPrefs: () => prefsValue,
    setPrefs: (patch) => { prefsValue = { ...prefsValue, ...patch }; },
    isDndEnabled: () => false,
    pushBehavior: () => {},
    showNativeNotification: () => {},
    playSound: () => {},
    getMouseStillSinceMs: () => Date.now(),
    t: (k) => k,
    getActiveThemePersonality: () => personality || null,
    subscribeWorkspace: () => () => {},
  };
}

test.describe("PAWPAL-4 personality weight resolution", () => {
  test.it("no personality block → weight 1.0", () => {
    const ctx = makeCtx();
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0);
  });

  test.it("theme personality.modifiers applied", () => {
    const ctx = makeCtx({
      personality: {
        themeId: "munchkin",
        modifiers: { pomodoroBreak: 1.5, hydrate: 0.7 },
      },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.5);
    assert.strictEqual(n._effectiveWeightForTesting("hydrate"), 0.7);
    assert.strictEqual(n._effectiveWeightForTesting("longSit"), 1.0,
      "unmodified nudge stays at default 1.0");
  });

  test.it("prefs override beats theme modifier", () => {
    const ctx = makeCtx({
      prefs: {
        version: 6,
        activeThemePersonalityOverrides: {
          munchkin: { pomodoroBreak: 2.0 },
        },
      },
      personality: {
        themeId: "munchkin",
        modifiers: { pomodoroBreak: 1.5 },
      },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 2.0);
  });

  test.it("weight clamping at [0.1, 5.0]", () => {
    const ctx = makeCtx({
      personality: {
        themeId: "test",
        modifiers: {
          pomodoroBreak: 0.05,
          hydrate: 10,
          longSit: 1.5,
          lateNightYawn: "fast",
        },
      },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 0.1);
    assert.strictEqual(n._effectiveWeightForTesting("hydrate"), 5.0);
    assert.strictEqual(n._effectiveWeightForTesting("longSit"), 1.5);
    assert.strictEqual(n._effectiveWeightForTesting("lateNightYawn"), 1.0);
  });

  test.it("prefs override above ceiling clamps", () => {
    const ctx = makeCtx({
      prefs: {
        version: 6,
        activeThemePersonalityOverrides: {
          munchkin: { pomodoroBreak: 99 },
        },
      },
      personality: { themeId: "munchkin", modifiers: { pomodoroBreak: 1.5 } },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 5.0);
  });

  test.it("empty modifiers → default 1.0", () => {
    const ctx = makeCtx({
      personality: { themeId: "minimal", modifiers: {} },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0);
  });

  test.it("prefs override for a different themeId does not apply", () => {
    const ctx = makeCtx({
      prefs: {
        version: 6,
        activeThemePersonalityOverrides: {
          ragdoll: { pomodoroBreak: 2.0 },
        },
      },
      personality: { themeId: "munchkin", modifiers: { pomodoroBreak: 1.5 } },
    });
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.5);
  });

  test.it("missing getActiveThemePersonality accessor → 1.0 fallback (no crash)", () => {
    const ctx = makeCtx();
    delete ctx.getActiveThemePersonality;
    const n = initNudges(ctx);
    assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0);
  });
});
