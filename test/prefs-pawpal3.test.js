// test/prefs-pawpal3.test.js — schema for the PAWPAL-3 integrations block.
//
// Mirrors the shape of test/prefs-pawpal2.test.js — covers defaults,
// migration (v4 → v5), normalization, prototype pollution defense, and
// the master vs sub-toggle independence.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const prefs = require("../src/prefs");

test.describe("PAWPAL-3 prefs.getDefaults: integrations block", () => {
  test.it("includes integrations with all toggles off", () => {
    const d = prefs.getDefaults();
    assert.ok(d.integrations, "integrations should be present");
    assert.strictEqual(d.integrations.enabled, false);
    assert.strictEqual(d.integrations.music.enabled, false);
    assert.strictEqual(d.integrations.battery.enabled, false);
    assert.strictEqual(d.integrations.systemEvents.enabled, false);
  });

  test.it("seeds music.bpmThreshold at 120 (high-energy default)", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.integrations.music.bpmThreshold, 120);
  });

  test.it("seeds battery.lowThresholdPct at 20 (matches spec)", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.integrations.battery.lowThresholdPct, 20);
  });

  test.it("seeds systemEvents.networkDrop=true, dockConnect=true, screenLock=false", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.integrations.systemEvents.networkDrop, true);
    assert.strictEqual(d.integrations.systemEvents.dockConnect, true);
    assert.strictEqual(d.integrations.systemEvents.screenLock, false);
  });

  test.it("returns a fresh integrations object each call (no shared refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a.integrations, b.integrations);
    assert.notStrictEqual(a.integrations.music, b.integrations.music);
    a.integrations.music.bpmThreshold = 999;
    assert.strictEqual(b.integrations.music.bpmThreshold, 120);
  });
});

test.describe("PAWPAL-3 prefs.migrate: v4 → v5", () => {
  test.it("v4 prefs get integrations defaults appended; version bumps to 5", () => {
    const v4Snapshot = {
      version: 4,
      simpleMode: false,
      nudges: { preset: "normal", overrides: {}, lastFiredAt: {} },
      workspaceAwareness: {
        enabled: false,
        activeApp: { enabled: false, categoryRules: {} },
        systemMonitor: {
          enabled: false,
          typingPauseThresholdMs: 30000,
          cpuStressThresholdPct: 70,
          cpuStressDurationMs: 120000,
        },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      },
    };
    const migrated = prefs.migrate(v4Snapshot);
    assert.strictEqual(migrated.version, 5);
    assert.ok(migrated.integrations);
    assert.strictEqual(migrated.integrations.enabled, false);
    assert.strictEqual(migrated.integrations.music.bpmThreshold, 120);
  });

  test.it("v5 prefs pass through unchanged (idempotent)", () => {
    const v5Snapshot = {
      version: 5,
      integrations: {
        enabled: true,
        music: { enabled: true, bpmThreshold: 140 },
        battery: { enabled: false, lowThresholdPct: 15 },
        systemEvents: {
          enabled: false,
          networkDrop: false,
          dockConnect: true,
          screenLock: true,
        },
      },
    };
    const migrated = prefs.migrate(v5Snapshot);
    assert.strictEqual(migrated.version, 5);
    assert.strictEqual(migrated.integrations.music.bpmThreshold, 140);
    assert.strictEqual(migrated.integrations.battery.lowThresholdPct, 15);
  });

  test.it("v3 prefs (PAWPAL-1 only) climb cleanly through v4 → v5", () => {
    const v3 = { version: 3, nudges: { preset: "normal", overrides: {}, lastFiredAt: {} } };
    const out = prefs.migrate(v3);
    assert.strictEqual(out.version, 5);
    assert.ok(out.workspaceAwareness, "v4 backfilled");
    assert.ok(out.integrations, "v5 backfilled");
  });
});

test.describe("PAWPAL-3 prefs.validate: integrations normalization", () => {
  test.it("strips prototype-pollution keys at root and sub-blocks", () => {
    const raw = JSON.parse(
      '{"version":5,"integrations":{"__proto__":{"polluted":true},"enabled":true,"music":{"__proto__":{"x":1},"enabled":true,"bpmThreshold":150}}}'
    );
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.music.bpmThreshold, 150);
    assert.strictEqual(({}).polluted, undefined, "Object.prototype not polluted");
  });

  test.it("malformed bpmThreshold falls back to default", () => {
    const raw = {
      version: 5,
      integrations: {
        enabled: true,
        music: { enabled: true, bpmThreshold: "fast" },
      },
    };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.music.bpmThreshold, 120);
  });

  test.it("negative bpmThreshold falls back to default", () => {
    const raw = {
      version: 5,
      integrations: { music: { bpmThreshold: -10 } },
    };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.music.bpmThreshold, 120);
  });

  test.it("battery lowThresholdPct accepts 0 (effectively disables nudge)", () => {
    const raw = {
      version: 5,
      integrations: { battery: { lowThresholdPct: 0 } },
    };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.battery.lowThresholdPct, 0);
  });

  test.it("battery lowThresholdPct over 100 falls back to default", () => {
    const raw = {
      version: 5,
      integrations: { battery: { lowThresholdPct: 200 } },
    };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.battery.lowThresholdPct, 20);
  });

  test.it("non-object integrations becomes defaults", () => {
    const raw = { version: 5, integrations: "not-an-object" };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.enabled, false);
    assert.strictEqual(out.integrations.music.bpmThreshold, 120);
  });

  test.it("bpmThreshold clamped to [20, 300] — out-of-range falls back to default (review fix)", () => {
    const tooLow = prefs.validate({
      version: prefs.CURRENT_VERSION,
      integrations: { music: { bpmThreshold: 5 } },
    });
    assert.strictEqual(tooLow.integrations.music.bpmThreshold, 120, "below 20 falls back to default");

    const tooHigh = prefs.validate({
      version: prefs.CURRENT_VERSION,
      integrations: { music: { bpmThreshold: 500 } },
    });
    assert.strictEqual(tooHigh.integrations.music.bpmThreshold, 120, "above 300 falls back to default");

    const okLow = prefs.validate({
      version: prefs.CURRENT_VERSION,
      integrations: { music: { bpmThreshold: 20 } },
    });
    assert.strictEqual(okLow.integrations.music.bpmThreshold, 20, "20 is in-range");

    const okHigh = prefs.validate({
      version: prefs.CURRENT_VERSION,
      integrations: { music: { bpmThreshold: 300 } },
    });
    assert.strictEqual(okHigh.integrations.music.bpmThreshold, 300, "300 is in-range");
  });

  test.it("non-boolean systemEvents toggles fall back to defaults", () => {
    const raw = {
      version: 5,
      integrations: {
        systemEvents: { networkDrop: "yes", dockConnect: 1, screenLock: null },
      },
    };
    const out = prefs.validate(raw);
    assert.strictEqual(out.integrations.systemEvents.networkDrop, true);
    assert.strictEqual(out.integrations.systemEvents.dockConnect, true);
    assert.strictEqual(out.integrations.systemEvents.screenLock, false);
  });
});

test.describe("PAWPAL-3 prefs.CURRENT_VERSION exposed", () => {
  test.it("exports CURRENT_VERSION = 5", () => {
    assert.strictEqual(prefs.CURRENT_VERSION, 5);
  });
});
