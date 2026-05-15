// test/prefs-pawpal4.test.js — activeThemePersonalityOverrides schema.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const prefs = require("../src/prefs");

test.describe("PAWPAL-4 prefs.getDefaults: personality overrides", () => {
  test.it("includes activeThemePersonalityOverrides as an empty object", () => {
    const d = prefs.getDefaults();
    assert.deepStrictEqual(d.activeThemePersonalityOverrides, {});
  });

  test.it("returns a fresh empty object each call (no shared refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a.activeThemePersonalityOverrides, b.activeThemePersonalityOverrides);
    a.activeThemePersonalityOverrides.munchkin = { pomodoroBreak: 2.0 };
    assert.deepStrictEqual(b.activeThemePersonalityOverrides, {});
  });
});

test.describe("PAWPAL-4 prefs.CURRENT_VERSION exposed", () => {
  test.it("exports CURRENT_VERSION = 6", () => {
    assert.strictEqual(prefs.CURRENT_VERSION, 6);
  });
});

test.describe("PAWPAL-4 prefs.migrate: v5 → v6", () => {
  test.it("v5 prefs gain empty activeThemePersonalityOverrides on migrate", () => {
    const v5 = { version: 5 };
    const out = prefs.migrate(v5);
    assert.strictEqual(out.version, 6);
    assert.deepStrictEqual(out.activeThemePersonalityOverrides, {});
  });

  test.it("v3 prefs cascade through v4 → v5 → v6 in one shot", () => {
    const v3 = { version: 3, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } };
    const out = prefs.migrate(v3);
    assert.strictEqual(out.version, 6);
    assert.ok(out.workspaceAwareness);
    assert.ok(out.integrations);
    assert.deepStrictEqual(out.activeThemePersonalityOverrides, {});
  });

  test.it("v6 prefs pass through unchanged", () => {
    const v6 = {
      version: 6,
      activeThemePersonalityOverrides: {
        munchkin: { pomodoroBreak: 1.5 },
      },
    };
    const out = prefs.migrate(v6);
    assert.strictEqual(out.version, 6);
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin.pomodoroBreak, 1.5);
  });
});

test.describe("PAWPAL-4 prefs.validate: personality overrides normalization", () => {
  test.it("non-object becomes empty object", () => {
    const out = prefs.validate({ version: 6, activeThemePersonalityOverrides: "broken" });
    assert.deepStrictEqual(out.activeThemePersonalityOverrides, {});
  });

  test.it("strips prototype pollution at root and per-theme", () => {
    const raw = JSON.parse(
      '{"version":6,"activeThemePersonalityOverrides":{"__proto__":{"x":1},"munchkin":{"__proto__":{"y":2},"pomodoroBreak":1.5}}}'
    );
    const out = prefs.validate(raw);
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin.pomodoroBreak, 1.5);
    assert.strictEqual(({}).x, undefined, "root not polluted");
    assert.strictEqual(({}).y, undefined, "inner not polluted");
  });

  test.it("drops weights outside [0.1, 5.0]", () => {
    const out = prefs.validate({
      version: 6,
      activeThemePersonalityOverrides: {
        munchkin: { tooLow: 0.05, tooHigh: 10, justRight: 1.5 },
      },
    });
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin.tooLow, undefined);
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin.tooHigh, undefined);
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin.justRight, 1.5);
  });

  test.it("drops non-finite weights (NaN, string, null)", () => {
    const out = prefs.validate({
      version: 6,
      activeThemePersonalityOverrides: {
        munchkin: { nan: NaN, str: "fast", nullVal: null, ok: 2.0 },
      },
    });
    assert.deepStrictEqual(out.activeThemePersonalityOverrides.munchkin, { ok: 2.0 });
  });

  test.it("drops themes whose entire inner map is empty after coercion", () => {
    const out = prefs.validate({
      version: 6,
      activeThemePersonalityOverrides: {
        munchkin: { all: 10, bad: NaN },  // all dropped → theme dropped
        ragdoll: { hydrate: 1.5 },         // one valid → theme kept
      },
    });
    assert.strictEqual(out.activeThemePersonalityOverrides.munchkin, undefined);
    assert.strictEqual(out.activeThemePersonalityOverrides.ragdoll.hydrate, 1.5);
  });

  test.it("exports PERSONALITY_WEIGHT_MIN and PERSONALITY_WEIGHT_MAX", () => {
    assert.strictEqual(prefs.PERSONALITY_WEIGHT_MIN, 0.1);
    assert.strictEqual(prefs.PERSONALITY_WEIGHT_MAX, 5.0);
  });
});
