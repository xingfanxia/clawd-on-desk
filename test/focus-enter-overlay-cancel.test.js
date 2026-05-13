"use strict";

// PAWPAL-2 Task 9 — focus-enter overlay-cancel predicate.
//
// Pure-function unit tests for `shouldCancelFocusOverlays(prev, next)` —
// the rule that decides whether the workspace-detector's confirmed
// onAppChange should trigger popBehavior() for any active nudge overlay.
//
// Rule (from the plan):
//   - Fire ONLY when transitioning FROM a non-focus category INTO
//     "code" or "creative" (i.e. the user just entered a focus app).
//   - Do NOT fire on cross-focus transitions (code ↔ creative) — user is
//     already in focus mode, no overlay should be running mid-focus.
//   - Do NOT fire on leaving a focus app (code → docs, etc.).
//   - Do NOT fire when neither prev nor next is a focus category.
//
// The actual popBehavior side effect is wired in src/main.js around the
// workspace-detector instantiation; this test covers the predicate so the
// branch logic stays correct under future maintenance without needing to
// boot Electron.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  shouldCancelFocusOverlays,
  isFocusCategory,
} = require("../src/lib/focus-overlay");

describe("shouldCancelFocusOverlays — focus-enter transitions", () => {
  it("fires on null → code (first observation, entering focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays(null, "code"), true);
  });

  it("fires on null → creative (first observation, entering focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays(null, "creative"), true);
  });

  it("fires on docs → code (non-focus → focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("docs", "code"), true);
  });

  it("fires on video → creative (non-focus → focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("video", "creative"), true);
  });

  it("fires on unknown → code (unknown counts as non-focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("unknown", "code"), true);
  });
});

describe("shouldCancelFocusOverlays — should NOT fire", () => {
  it("no-op on code → code (already focused, same app)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("code", "code"), false);
  });

  it("no-op on creative → creative (already focused, same app)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("creative", "creative"), false);
  });

  it("no-op on code → creative (cross-focus transition stays in focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("code", "creative"), false);
  });

  it("no-op on creative → code (cross-focus transition, reverse direction)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("creative", "code"), false);
  });

  it("no-op on code → docs (leaving focus, no cancel needed)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("code", "docs"), false);
  });

  it("no-op on null → docs (neither side is focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays(null, "docs"), false);
  });

  it("no-op on null → null (both unknown)", () => {
    assert.strictEqual(shouldCancelFocusOverlays(null, null), false);
  });

  it("no-op on null → unknown (neither side is focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays(null, "unknown"), false);
  });

  it("no-op on docs → video (non-focus → non-focus)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("docs", "video"), false);
  });

  it("no-op on code → null (leaving focus to unknown, no cancel)", () => {
    assert.strictEqual(shouldCancelFocusOverlays("code", null), false);
  });
});

describe("isFocusCategory — helper", () => {
  it("returns true for 'code'", () => {
    assert.strictEqual(isFocusCategory("code"), true);
  });

  it("returns true for 'creative'", () => {
    assert.strictEqual(isFocusCategory("creative"), true);
  });

  it("returns false for 'docs'", () => {
    assert.strictEqual(isFocusCategory("docs"), false);
  });

  it("returns false for null", () => {
    assert.strictEqual(isFocusCategory(null), false);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(isFocusCategory(undefined), false);
  });

  it("returns false for unrelated strings", () => {
    assert.strictEqual(isFocusCategory("communication"), false);
    assert.strictEqual(isFocusCategory("video"), false);
    assert.strictEqual(isFocusCategory("unknown"), false);
  });

  it("returns false for empty string", () => {
    assert.strictEqual(isFocusCategory(""), false);
  });
});
