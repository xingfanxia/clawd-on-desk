"use strict";

// PAWPAL-2 Task 10 — settings-tab-awareness.js workspace section tests.
//
// The awareness tab is a renderer-side DOM builder, so most of its surface is
// exercised through the live Settings window. These tests target the PURE
// HELPERS exposed via `ClawdSettingsTabAwareness.__test`:
//
//   - parseCategoryRulesText(text) — JSON + category-whitelist validation
//   - isValidLongWindowThreshold(ms) — preset-options whitelist
//   - permissionLabelKey(kind, liveState, history, onMac) — UI label routing
//   - defaultCategoryRules() — defaults parity vs prefs.js
//   - constant lists (WORKSPACE_CATEGORIES, LONG_WINDOW_THRESHOLDS, PRESET_ENABLES)
//
// We load the module into a minimal vm context (matches the pattern used by
// settings-renderer-browser-env.test.js) so it doesn't need jsdom — the
// module side-effect-registers onto root.ClawdSettingsTabAwareness and we
// pull __test off it.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const TAB_FILE = path.join(SRC_DIR, "settings-tab-awareness.js");
const prefs = require("../src/prefs");

function loadAwarenessTabModule() {
  const context = {
    console,
    document: {
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
      visibilityState: "visible",
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    window: { settingsAPI: { update: () => Promise.resolve({ status: "ok" }) } },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(TAB_FILE, "utf8"), context);
  if (!context.ClawdSettingsTabAwareness || !context.ClawdSettingsTabAwareness.__test) {
    throw new Error("settings-tab-awareness.js did not expose __test helpers");
  }
  return context.ClawdSettingsTabAwareness.__test;
}

describe("settings-tab-awareness (Workspace Awareness — PAWPAL-2 Task 10)", () => {
  describe("parseCategoryRulesText", () => {
    it("accepts a valid object with all-whitelisted categories", () => {
      const h = loadAwarenessTabModule();
      const text = JSON.stringify({ Slack: "chat", Cursor: "code", Figma: "creative" });
      const result = h.parseCategoryRulesText(text);
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { Slack: "chat", Cursor: "code", Figma: "creative" });
    });

    it("accepts an empty object", () => {
      const h = loadAwarenessTabModule();
      const result = h.parseCategoryRulesText("{}");
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, {});
    });

    it("rejects malformed JSON with code 'invalid-json' and a message", () => {
      const h = loadAwarenessTabModule();
      const result = h.parseCategoryRulesText("{ not valid json");
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-json");
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0, "expected non-empty parse-error message");
    });

    it("rejects non-object top-level shapes (arrays)", () => {
      const h = loadAwarenessTabModule();
      const result = h.parseCategoryRulesText("[1, 2, 3]");
      assert.equal(result.ok, false);
      assert.equal(result.code, "not-object");
    });

    it("rejects non-object top-level shapes (null)", () => {
      const h = loadAwarenessTabModule();
      const result = h.parseCategoryRulesText("null");
      assert.equal(result.ok, false);
      assert.equal(result.code, "not-object");
    });

    it("rejects non-object top-level shapes (string)", () => {
      const h = loadAwarenessTabModule();
      const result = h.parseCategoryRulesText('"just a string"');
      assert.equal(result.ok, false);
      assert.equal(result.code, "not-object");
    });

    it("rejects rules with a category outside the whitelist", () => {
      const h = loadAwarenessTabModule();
      const text = JSON.stringify({ Slack: "chat", Foo: "invalid" });
      const result = h.parseCategoryRulesText(text);
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-category");
      assert.equal(result.offendingKey, "Foo");
      assert.equal(result.offendingValue, "invalid");
    });

    it("rejects rules with a non-string category value", () => {
      const h = loadAwarenessTabModule();
      const text = JSON.stringify({ Slack: 42 });
      const result = h.parseCategoryRulesText(text);
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-category");
      assert.equal(result.offendingKey, "Slack");
    });

    it("accepts each whitelist category individually", () => {
      const h = loadAwarenessTabModule();
      for (const cat of h.WORKSPACE_CATEGORIES) {
        const text = JSON.stringify({ [`Test-${cat}`]: cat });
        const result = h.parseCategoryRulesText(text);
        assert.equal(result.ok, true, `expected ${cat} to be accepted`);
      }
    });
  });

  describe("isValidLongWindowThreshold", () => {
    it("accepts the three preset values (60/90/120 min in ms)", () => {
      const h = loadAwarenessTabModule();
      assert.equal(h.isValidLongWindowThreshold(3600000), true, "60 min should be valid");
      assert.equal(h.isValidLongWindowThreshold(5400000), true, "90 min should be valid");
      assert.equal(h.isValidLongWindowThreshold(7200000), true, "120 min should be valid");
    });

    it("rejects arbitrary positive numbers not in the preset list", () => {
      const h = loadAwarenessTabModule();
      assert.equal(h.isValidLongWindowThreshold(1), false);
      assert.equal(h.isValidLongWindowThreshold(60000), false);
      assert.equal(h.isValidLongWindowThreshold(1000000), false);
      assert.equal(h.isValidLongWindowThreshold(10000000), false);
    });

    it("rejects zero, negative, non-finite, non-number", () => {
      const h = loadAwarenessTabModule();
      assert.equal(h.isValidLongWindowThreshold(0), false);
      assert.equal(h.isValidLongWindowThreshold(-5400000), false);
      assert.equal(h.isValidLongWindowThreshold(Infinity), false);
      assert.equal(h.isValidLongWindowThreshold(NaN), false);
      assert.equal(h.isValidLongWindowThreshold(undefined), false);
      assert.equal(h.isValidLongWindowThreshold("5400000"), false);
      assert.equal(h.isValidLongWindowThreshold(null), false);
    });
  });

  describe("permissionLabelKey", () => {
    it("returns labelPermissionUnavailable on non-mac platforms", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "granted", {}, false),
        "labelPermissionUnavailable"
      );
      assert.equal(
        h.permissionLabelKey("accessibility", "denied", {}, false),
        "labelPermissionUnavailable"
      );
    });

    it("returns labelPermissionGranted when liveState is granted on mac", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "granted", {}, true),
        "labelPermissionGranted"
      );
    });

    it("returns labelPermissionDenied when denied AND no prior grant", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "denied", { accessibility: false }, true),
        "labelPermissionDenied"
      );
      // Empty history same as { kind: false }.
      assert.equal(
        h.permissionLabelKey("accessibility", "denied", {}, true),
        "labelPermissionDenied"
      );
    });

    it("returns labelPermissionRevoked when denied AND there is a prior grant", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "denied", { accessibility: true }, true),
        "labelPermissionRevoked"
      );
    });

    it("returns labelPermissionUnknown for unknown state on mac", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "unknown", {}, true),
        "labelPermissionUnknown"
      );
    });

    it("returns labelPermissionUnavailable for explicit unavailable state on mac", () => {
      const h = loadAwarenessTabModule();
      assert.equal(
        h.permissionLabelKey("accessibility", "unavailable", {}, true),
        "labelPermissionUnavailable"
      );
    });

    it("distinguishes inputMonitoring vs accessibility history independently", () => {
      const h = loadAwarenessTabModule();
      const history = { accessibility: true, inputMonitoring: false };
      assert.equal(
        h.permissionLabelKey("accessibility", "denied", history, true),
        "labelPermissionRevoked"
      );
      assert.equal(
        h.permissionLabelKey("inputMonitoring", "denied", history, true),
        "labelPermissionDenied"
      );
    });
  });

  describe("constants parity with prefs.js", () => {
    it("WORKSPACE_CATEGORIES matches prefs.js (defensive against drift)", () => {
      const h = loadAwarenessTabModule();
      // require() the prefs module directly rather than regex-scraping the
      // source — the prior approach was fragile to whitespace/formatting
      // changes inside prefs.js. WORKSPACE_CATEGORIES is exported from
      // prefs.js (Task 2) precisely so consumers like this test can verify
      // the renderer-side duplicate stays in sync.
      // NOTE: arrays returned by the renderer module live in a separate vm
      // realm (created by loadAwarenessTabModule), so their prototype is a
      // different Array than this test's Array. assert.deepStrictEqual fails
      // cross-realm even with identical contents — compare as plain arrays
      // via Array.from to avoid the prototype check.
      const expected = Array.from(prefs.WORKSPACE_CATEGORIES).sort();
      const actual = Array.from(h.WORKSPACE_CATEGORIES).sort();
      assert.deepStrictEqual(
        actual,
        expected,
        "renderer WORKSPACE_CATEGORIES must mirror prefs.WORKSPACE_CATEGORIES"
      );
    });

    it("LONG_WINDOW_THRESHOLDS includes the prefs.js default sameWindowThresholdMs", () => {
      const h = loadAwarenessTabModule();
      // Pull the prefs default through the exported getDefaults() helper
      // so any future restructure of the workspaceAwareness defaultFactory
      // (e.g. moving the field into a sub-block) still surfaces here.
      const defaults = prefs.getDefaults();
      const defaultMs = defaults
        && defaults.workspaceAwareness
        && defaults.workspaceAwareness.longWindow
        && defaults.workspaceAwareness.longWindow.sameWindowThresholdMs;
      assert.ok(
        typeof defaultMs === "number" && Number.isFinite(defaultMs) && defaultMs > 0,
        "prefs.getDefaults().workspaceAwareness.longWindow.sameWindowThresholdMs must be a positive number"
      );
      assert.ok(
        h.LONG_WINDOW_THRESHOLDS.some((opt) => opt.ms === defaultMs),
        `expected LONG_WINDOW_THRESHOLDS to include the prefs default ${defaultMs}`
      );
    });

    it("PRESET_ENABLES covers all 7 nudge ids across all 3 presets", () => {
      const h = loadAwarenessTabModule();
      const nudgeIds = [
        "pomodoroBreak",
        "hydrate",
        "longSit",
        "lateNightYawn",
        "socialHeadShake",
        "stuckOnProblem",
        "longWindowBreak",
      ];
      for (const preset of ["quiet", "normal", "coach"]) {
        const map = h.PRESET_ENABLES[preset];
        assert.ok(map, `missing PRESET_ENABLES.${preset}`);
        for (const id of nudgeIds) {
          assert.equal(typeof map[id], "boolean", `${preset}.${id} should be boolean`);
        }
      }
    });
  });

  describe("defaultCategoryRules", () => {
    it("returns a non-empty object", () => {
      const h = loadAwarenessTabModule();
      const rules = h.defaultCategoryRules();
      assert.ok(rules && typeof rules === "object" && !Array.isArray(rules));
      assert.ok(Object.keys(rules).length > 0, "defaults should not be empty");
    });

    it("every default value is a whitelisted category", () => {
      const h = loadAwarenessTabModule();
      const rules = h.defaultCategoryRules();
      for (const [k, v] of Object.entries(rules)) {
        assert.ok(
          h.WORKSPACE_CATEGORIES.includes(v),
          `default rule ${k} → ${v} is not in WORKSPACE_CATEGORIES`
        );
      }
    });

    it("returns a fresh object each call (no aliasing)", () => {
      const h = loadAwarenessTabModule();
      const a = h.defaultCategoryRules();
      const b = h.defaultCategoryRules();
      assert.notStrictEqual(a, b);
      a.Slack = "MUTATED";
      assert.notEqual(b.Slack, "MUTATED");
    });
  });
});
