"use strict";

// PAWPAL-2: workspaceAwareness schema + v3→v4 migration tests.
//
// What we verify:
//   1. Fresh-install defaults — workspaceAwareness present, all toggles off.
//   2. Migration semantics — v3 prefs gain workspaceAwareness on upgrade.
//   3. Pre-existing v4 prefs pass through unchanged (no clobber).
//   4. Prototype-pollution defense at root + activeApp.categoryRules.
//   5. Category whitelist enforcement — rules outside the 6-category set drop.
//   6. Numeric-threshold + boolean validation rejects bad values.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");

describe("PAWPAL-2 prefs.getDefaults: workspaceAwareness defaults", () => {
  it("includes a workspaceAwareness block with all toggles off (opt-in)", () => {
    const d = prefs.getDefaults();
    assert.ok(d.workspaceAwareness, "workspaceAwareness should be present");
    assert.strictEqual(d.workspaceAwareness.enabled, false);
    assert.strictEqual(d.workspaceAwareness.activeApp.enabled, false);
    assert.strictEqual(d.workspaceAwareness.systemMonitor.enabled, false);
    assert.strictEqual(d.workspaceAwareness.longWindow.enabled, false);
  });

  it("seeds activeApp.categoryRules with the default substring map", () => {
    const d = prefs.getDefaults();
    const rules = d.workspaceAwareness.activeApp.categoryRules;
    assert.strictEqual(rules["Visual Studio Code"], "code");
    assert.strictEqual(rules["Cursor"], "code");
    assert.strictEqual(rules["Terminal"], "code");
    assert.strictEqual(rules["Notion"], "docs");
    assert.strictEqual(rules["Slack"], "chat");
    assert.strictEqual(rules["YouTube"], "video");
    assert.strictEqual(rules["Figma"], "creative");
  });

  it("seeds systemMonitor thresholds with documented defaults", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.workspaceAwareness.systemMonitor.typingPauseThresholdMs, 30000);
    assert.strictEqual(d.workspaceAwareness.systemMonitor.cpuStressThresholdPct, 70);
    assert.strictEqual(d.workspaceAwareness.systemMonitor.cpuStressDurationMs, 120000);
  });

  it("seeds longWindow.sameWindowThresholdMs default of 90 minutes", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.workspaceAwareness.longWindow.sameWindowThresholdMs, 5400000);
  });

  it("each getDefaults() call returns a fresh workspaceAwareness object (no shared refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a.workspaceAwareness, b.workspaceAwareness);
    assert.notStrictEqual(a.workspaceAwareness.activeApp, b.workspaceAwareness.activeApp);
    assert.notStrictEqual(
      a.workspaceAwareness.activeApp.categoryRules,
      b.workspaceAwareness.activeApp.categoryRules,
    );
    // Mutating one snapshot should not affect the next call's snapshot.
    a.workspaceAwareness.activeApp.categoryRules["EvilEditor"] = "code";
    assert.strictEqual(
      b.workspaceAwareness.activeApp.categoryRules["EvilEditor"],
      undefined,
    );
  });
});

describe("PAWPAL-2 prefs.migrate: v3 → v4 workspaceAwareness", () => {
  it("CURRENT_VERSION is 4", () => {
    assert.strictEqual(prefs.CURRENT_VERSION, 4);
  });

  it("v3 file gains workspaceAwareness defaults on migrate", () => {
    const raw = {
      version: 3,
      lang: "en",
      nudges: { preset: "normal", overrides: {}, lastFiredAt: {} },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 4);
    assert.ok(upgraded.workspaceAwareness, "workspaceAwareness should be backfilled");
    assert.strictEqual(upgraded.workspaceAwareness.enabled, false);
    assert.strictEqual(upgraded.workspaceAwareness.activeApp.enabled, false);
    assert.strictEqual(upgraded.workspaceAwareness.systemMonitor.enabled, false);
    assert.strictEqual(upgraded.workspaceAwareness.longWindow.enabled, false);
    // Pre-existing fields preserved through the migration step.
    assert.strictEqual(upgraded.lang, "en");
    assert.strictEqual(upgraded.nudges.preset, "normal");
  });

  it("v0 file (no version) cascades all the way to v4 with workspaceAwareness", () => {
    const raw = { lang: "zh" };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 4);
    assert.ok(upgraded.workspaceAwareness);
    assert.strictEqual(upgraded.workspaceAwareness.enabled, false);
  });

  it("pre-existing v4 prefs pass through migration unchanged", () => {
    const raw = {
      version: 4,
      workspaceAwareness: {
        enabled: true,
        activeApp: {
          enabled: true,
          categoryRules: { "MyEditor": "code" },
        },
        systemMonitor: {
          enabled: true,
          typingPauseThresholdMs: 45000,
          cpuStressThresholdPct: 80,
          cpuStressDurationMs: 60000,
        },
        longWindow: {
          enabled: false,
          sameWindowThresholdMs: 3600000,
        },
      },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 4);
    // Pre-existing block survives migration verbatim — no clobber.
    assert.deepStrictEqual(upgraded.workspaceAwareness, raw.workspaceAwareness);
  });

  it("v3 prefs with a pre-existing workspaceAwareness block keep it (no overwrite)", () => {
    // Defensive: a hand-edited v3 file that already wrote workspaceAwareness
    // shouldn't have it replaced by defaults during the v3→v4 bump.
    const raw = {
      version: 3,
      workspaceAwareness: {
        enabled: true,
        activeApp: { enabled: true, categoryRules: { "Custom": "code" } },
        systemMonitor: { enabled: false, typingPauseThresholdMs: 99999, cpuStressThresholdPct: 70, cpuStressDurationMs: 120000 },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 4);
    assert.strictEqual(upgraded.workspaceAwareness.enabled, true);
    assert.strictEqual(upgraded.workspaceAwareness.activeApp.categoryRules["Custom"], "code");
    assert.strictEqual(upgraded.workspaceAwareness.systemMonitor.typingPauseThresholdMs, 99999);
  });
});

describe("PAWPAL-2 prefs.validate: workspaceAwareness normalization", () => {
  it("strips dangerous prototype-pollution keys at the root", () => {
    // Build raw with __proto__ as an own property by going through JSON.parse —
    // a plain object literal puts __proto__ on the prototype chain, not as an
    // own property, which would not exercise the defense.
    const raw = JSON.parse(`{
      "workspaceAwareness": {
        "__proto__": { "polluted": true },
        "constructor": { "polluted": true },
        "prototype": { "polluted": true },
        "enabled": true,
        "activeApp": { "enabled": false, "categoryRules": {} },
        "systemMonitor": { "enabled": false, "typingPauseThresholdMs": 30000, "cpuStressThresholdPct": 70, "cpuStressDurationMs": 120000 },
        "longWindow": { "enabled": false, "sameWindowThresholdMs": 5400000 }
      }
    }`);
    const v = prefs.validate(raw);
    // Bad keys must not survive normalization — assert they're absent on the
    // normalized object's own properties.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(v.workspaceAwareness, "__proto__"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(v.workspaceAwareness, "constructor"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(v.workspaceAwareness, "prototype"),
      false,
    );
    // Good keys survive.
    assert.strictEqual(v.workspaceAwareness.enabled, true);
  });

  it("strips prototype-pollution keys inside activeApp.categoryRules", () => {
    const raw = JSON.parse(`{
      "workspaceAwareness": {
        "enabled": false,
        "activeApp": {
          "enabled": false,
          "categoryRules": {
            "__proto__": "code",
            "constructor": "code",
            "prototype": "code",
            "Cursor": "code"
          }
        },
        "systemMonitor": { "enabled": false, "typingPauseThresholdMs": 30000, "cpuStressThresholdPct": 70, "cpuStressDurationMs": 120000 },
        "longWindow": { "enabled": false, "sameWindowThresholdMs": 5400000 }
      }
    }`);
    const v = prefs.validate(raw);
    const rules = v.workspaceAwareness.activeApp.categoryRules;
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "__proto__"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "constructor"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "prototype"), false);
    // The clean entry survives.
    assert.strictEqual(rules["Cursor"], "code");
    // None of the bad keys polluted the global prototype either.
    assert.strictEqual(({}).polluted, undefined);
  });

  it("drops categoryRules values that aren't in the WORKSPACE_CATEGORIES whitelist", () => {
    const v = prefs.validate({
      workspaceAwareness: {
        enabled: false,
        activeApp: {
          enabled: false,
          categoryRules: {
            "Cursor": "code",          // valid
            "Foo": "invalid",          // not in whitelist → dropped
            "Bar": "executable",       // not in whitelist → dropped
            "Notion": "docs",          // valid
            "Baz": 42,                 // wrong type → dropped
            "Qux": null,               // wrong type → dropped
          },
        },
        systemMonitor: { enabled: false, typingPauseThresholdMs: 30000, cpuStressThresholdPct: 70, cpuStressDurationMs: 120000 },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      },
    });
    const rules = v.workspaceAwareness.activeApp.categoryRules;
    assert.strictEqual(rules["Cursor"], "code");
    assert.strictEqual(rules["Notion"], "docs");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "Foo"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "Bar"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "Baz"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rules, "Qux"), false);
  });

  it("accepts all six valid categories (code, docs, social, chat, video, creative)", () => {
    const v = prefs.validate({
      workspaceAwareness: {
        enabled: false,
        activeApp: {
          enabled: false,
          categoryRules: {
            "A": "code",
            "B": "docs",
            "C": "social",
            "D": "chat",
            "E": "video",
            "F": "creative",
          },
        },
        systemMonitor: { enabled: false, typingPauseThresholdMs: 30000, cpuStressThresholdPct: 70, cpuStressDurationMs: 120000 },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      },
    });
    const rules = v.workspaceAwareness.activeApp.categoryRules;
    assert.deepStrictEqual(rules, {
      "A": "code",
      "B": "docs",
      "C": "social",
      "D": "chat",
      "E": "video",
      "F": "creative",
    });
  });

  it("rejects non-positive / non-finite numeric thresholds and falls back to defaults", () => {
    const v = prefs.validate({
      workspaceAwareness: {
        enabled: false,
        activeApp: { enabled: false, categoryRules: {} },
        systemMonitor: {
          enabled: false,
          typingPauseThresholdMs: -1,      // negative → default
          cpuStressThresholdPct: NaN,      // not finite → default
          cpuStressDurationMs: 0,           // zero → default (we require > 0)
        },
        longWindow: {
          enabled: false,
          sameWindowThresholdMs: Infinity, // not finite → default
        },
      },
    });
    assert.strictEqual(v.workspaceAwareness.systemMonitor.typingPauseThresholdMs, 30000);
    assert.strictEqual(v.workspaceAwareness.systemMonitor.cpuStressThresholdPct, 70);
    assert.strictEqual(v.workspaceAwareness.systemMonitor.cpuStressDurationMs, 120000);
    assert.strictEqual(v.workspaceAwareness.longWindow.sameWindowThresholdMs, 5400000);
  });

  it("rejects non-boolean toggles and falls back to defaults", () => {
    const v = prefs.validate({
      workspaceAwareness: {
        enabled: "yes",                  // not a boolean
        activeApp: { enabled: 1, categoryRules: {} },
        systemMonitor: { enabled: "true", typingPauseThresholdMs: 30000, cpuStressThresholdPct: 70, cpuStressDurationMs: 120000 },
        longWindow: { enabled: null, sameWindowThresholdMs: 5400000 },
      },
    });
    // All four toggles default to false on bad input — confirms opt-in invariant.
    assert.strictEqual(v.workspaceAwareness.enabled, false);
    assert.strictEqual(v.workspaceAwareness.activeApp.enabled, false);
    assert.strictEqual(v.workspaceAwareness.systemMonitor.enabled, false);
    assert.strictEqual(v.workspaceAwareness.longWindow.enabled, false);
  });

  it("falls back to a full default block when workspaceAwareness is missing or non-object", () => {
    // {} is structurally valid (an object) but missing every sub-field —
    // the normalizer's correct behavior is to produce a full defaults block,
    // identical to the non-object-fallback case. Same assertion catches both
    // paths.
    for (const bad of [undefined, null, "string", 42, [], {}]) {
      const v = prefs.validate({ workspaceAwareness: bad });
      const d = prefs.getDefaults();
      assert.deepStrictEqual(
        v.workspaceAwareness,
        d.workspaceAwareness,
        `expected default block for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("seeds default categoryRules when the field is missing entirely", () => {
    // Defense for hand-edited prefs that supply only activeApp.enabled.
    // The runtime detector should still have a non-empty starter rule set.
    const v = prefs.validate({
      workspaceAwareness: {
        enabled: false,
        activeApp: { enabled: false },
        systemMonitor: { enabled: false, typingPauseThresholdMs: 30000, cpuStressThresholdPct: 70, cpuStressDurationMs: 120000 },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      },
    });
    const rules = v.workspaceAwareness.activeApp.categoryRules;
    assert.strictEqual(rules["Cursor"], "code");
    assert.strictEqual(rules["Slack"], "chat");
  });
});
