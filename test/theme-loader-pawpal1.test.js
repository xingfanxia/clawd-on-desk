// theme-loader-pawpal1.test.js — schema validation for `behaviors` and
// `idleVariants` (PAWPAL-1). Mirrors the pattern of other top-level node:test
// files in this directory but stays self-contained — runs via plain `node`.

const assert = require("assert");
const { validateTheme } = require("../src/theme-loader");

const baseTheme = {
  schemaVersion: 1,
  name: "Test",
  version: "1.0.0",
  viewBox: { x: 0, y: 0, width: 200, height: 200 },
  layout: { contentBox: { x: 0, y: 0, width: 200, height: 200 } },
  states: {
    idle: ["test-idle.apng"],
    working: ["test-working.apng"],
    thinking: ["test-thinking.apng"],
    sleeping: ["test-sleeping.apng"],
    yawning: ["test-yawning.apng"],
    dozing: ["test-dozing.apng"],
    collapsing: ["test-collapsing.apng"],
    waking: ["test-waking.apng"],
    notification: ["test-notification.apng"],
  },
  hitBoxes: { default: { x: 0, y: 0, w: 200, h: 200 } },
};

// Valid behaviors block — file + duration + fallbackTo
{
  const cfg = { ...baseTheme, behaviors: { walkAcross: { file: "x.apng", duration: 3000, fallbackTo: "notification" } } };
  const errs = validateTheme(cfg);
  assert.deepStrictEqual(errs, [], "valid behaviors should pass: " + JSON.stringify(errs));
}

// Valid behaviors — fallbackTo only (legacy theme pattern)
{
  const cfg = { ...baseTheme, behaviors: { walkAcross: { fallbackTo: "notification" } } };
  const errs = validateTheme(cfg);
  assert.deepStrictEqual(errs, [], "fallback-only behavior should pass: " + JSON.stringify(errs));
}

// Behaviors missing both file and fallbackTo
{
  const cfg = { ...baseTheme, behaviors: { walkAcross: {} } };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("must define either file or fallbackTo")),
    "should reject empty behavior: " + JSON.stringify(errs));
}

// Behaviors with invalid fallbackTo target
{
  const cfg = { ...baseTheme, behaviors: { walkAcross: { fallbackTo: "nonExistentState" } } };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes('"nonExistentState" is not a known state')),
    "should reject unknown fallback target: " + JSON.stringify(errs));
}

// Behaviors with non-positive duration
{
  const cfg = { ...baseTheme, behaviors: { walkAcross: { file: "x.apng", duration: 0, fallbackTo: "notification" } } };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("duration must be a positive number")),
    "should reject zero duration: " + JSON.stringify(errs));
}

// Behaviors must be a plain object
{
  const cfg = { ...baseTheme, behaviors: ["not", "an", "object"] };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("behaviors must be an object")),
    "should reject array behaviors: " + JSON.stringify(errs));
}

// Empty behaviors object — explicit but no entries — is valid
{
  const cfg = { ...baseTheme, behaviors: {} };
  const errs = validateTheme(cfg);
  assert.deepStrictEqual(errs, [], "empty behaviors object should pass: " + JSON.stringify(errs));
}

// Valid idleVariants
{
  const cfg = { ...baseTheme, idleVariants: { happy: ["test-happy.apng"], dozing: ["test-dozing.apng"] } };
  const errs = validateTheme(cfg);
  assert.deepStrictEqual(errs, [], "valid idleVariants should pass: " + JSON.stringify(errs));
}

// idleVariants with empty array
{
  const cfg = { ...baseTheme, idleVariants: { happy: [] } };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("must be a non-empty array")),
    "should reject empty variant: " + JSON.stringify(errs));
}

// idleVariants with non-string entry
{
  const cfg = { ...baseTheme, idleVariants: { happy: ["good.apng", 42] } };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("all entries must be non-empty strings")),
    "should reject non-string entries: " + JSON.stringify(errs));
}

// idleVariants must be a plain object
{
  const cfg = { ...baseTheme, idleVariants: "happy" };
  const errs = validateTheme(cfg);
  assert.ok(errs.some((e) => e.includes("idleVariants must be an object")),
    "should reject string idleVariants: " + JSON.stringify(errs));
}

console.log("OK — theme schema PAWPAL-1 tests pass");
