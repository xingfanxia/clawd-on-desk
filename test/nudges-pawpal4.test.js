// test/nudges-pawpal4.test.js — personality-driven scheduling weights.

"use strict";

const assert = require("assert");
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

// -----------------------------------------------------------------------------
// CASE A: No personality block → weight === 1.0
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const n = initNudges(ctx);
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0,
    "Case A: no personality → weight 1.0");
}

// -----------------------------------------------------------------------------
// CASE B: Theme personality.modifiers applied
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({
    personality: {
      themeId: "munchkin",
      modifiers: { pomodoroBreak: 1.5, hydrate: 0.7 },
    },
  });
  const n = initNudges(ctx);
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.5,
    "Case B: theme modifier applied");
  assert.strictEqual(n._effectiveWeightForTesting("hydrate"), 0.7,
    "Case B: second theme modifier applied");
  assert.strictEqual(n._effectiveWeightForTesting("longSit"), 1.0,
    "Case B: unmodified nudge stays at 1.0");
}

// -----------------------------------------------------------------------------
// CASE C: prefs override beats theme modifier
// -----------------------------------------------------------------------------
{
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
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 2.0,
    "Case C: prefs override beats theme modifier");
}

// -----------------------------------------------------------------------------
// CASE D: Weight clamping at [0.1, 5.0]
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({
    personality: {
      themeId: "test",
      modifiers: {
        pomodoroBreak: 0.05,   // below min → clamp to 0.1
        hydrate: 10,           // above max → clamp to 5.0
        longSit: 1.5,          // in-range
        lateNightYawn: "fast", // non-number → fall back to 1.0
      },
    },
  });
  const n = initNudges(ctx);
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 0.1,
    "Case D: under-floor clamps to 0.1");
  assert.strictEqual(n._effectiveWeightForTesting("hydrate"), 5.0,
    "Case D: over-ceiling clamps to 5.0");
  assert.strictEqual(n._effectiveWeightForTesting("longSit"), 1.5,
    "Case D: in-range value preserved");
  assert.strictEqual(n._effectiveWeightForTesting("lateNightYawn"), 1.0,
    "Case D: non-number falls back to 1.0");
}

// -----------------------------------------------------------------------------
// CASE E: prefs override clamps to range too
// -----------------------------------------------------------------------------
{
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
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 5.0,
    "Case E: prefs override > 5 clamps to 5");
}

// -----------------------------------------------------------------------------
// CASE F: Theme without personality block — still readable, no crash
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx({
    personality: { themeId: "minimal", modifiers: {} },
  });
  const n = initNudges(ctx);
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0,
    "Case F: empty modifiers → 1.0 default");
}

// -----------------------------------------------------------------------------
// CASE G: Wrong themeId in prefs override (overrides for "ragdoll" while
//         active theme is "munchkin") → use theme's default, not user's stale
//         override for another theme.
// -----------------------------------------------------------------------------
{
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
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.5,
    "Case G: override for a different theme doesn't apply to active theme");
}

// -----------------------------------------------------------------------------
// CASE H: getActiveThemePersonality accessor missing → 1.0 fallback
// -----------------------------------------------------------------------------
{
  const ctx = makeCtx();
  delete ctx.getActiveThemePersonality;
  const n = initNudges(ctx);
  assert.strictEqual(n._effectiveWeightForTesting("pomodoroBreak"), 1.0,
    "Case H: missing accessor → 1.0 (no crash)");
}

console.log("OK — nudges PAWPAL-4 unit tests pass");
