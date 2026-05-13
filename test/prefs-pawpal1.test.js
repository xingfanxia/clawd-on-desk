// prefs-pawpal1.test.js — schema + migration coverage for the `nudges`
// field introduced in PAWPAL-1 (prefs v2 → v3).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const prefs = require("../src/prefs");

// 1. Defaults snapshot includes nudges with normal preset
// (Version assertion uses CURRENT_VERSION so this test survives future
// schema bumps — PAWPAL-2 bumped to v4; the nudges block is what PAWPAL-1
// actually owns and that's what we're checking.)
{
  const d = prefs.getDefaults();
  assert.strictEqual(d.version, prefs.CURRENT_VERSION, "defaults should be the current version");
  assert.strictEqual(d.nudges.preset, "normal");
  assert.deepStrictEqual(d.nudges.overrides, {});
  assert.deepStrictEqual(d.nudges.lastFiredAt, {});
}

// 2. Migration v2 → v3 backfills nudges with normal preset
// (Result version is CURRENT_VERSION because migration cascades all the way
// up the chain — what PAWPAL-1 cares about here is that nudges got filled.)
{
  const v2 = { version: 2, lang: "en", showTray: true, simpleMode: false };
  const migrated = prefs.migrate(v2);
  assert.strictEqual(migrated.version, prefs.CURRENT_VERSION);
  assert.strictEqual(migrated.nudges.preset, "normal");
  assert.deepStrictEqual(migrated.nudges.overrides, {});
}

// 3. Migration from v0 (no version) cascades all the way to current version
{
  const v0 = { lang: "zh", soundMuted: true };
  const migrated = prefs.migrate(v0);
  assert.strictEqual(migrated.version, prefs.CURRENT_VERSION);
  assert.strictEqual(migrated.nudges.preset, "normal");
  assert.strictEqual(typeof migrated.simpleMode, "boolean", "simpleMode also backfilled");
}

// 4. Validate normalizes invalid preset back to "normal"
{
  const bad = { version: 3, nudges: { preset: "INVALID" } };
  const v = prefs.validate(bad);
  assert.strictEqual(v.nudges.preset, "normal");
}

// 5. Validate preserves valid preset + overrides
{
  const good = {
    version: 3,
    nudges: {
      preset: "coach",
      overrides: { hydrate: { enabled: false } },
      lastFiredAt: { pomodoroBreak: 1700000000000 },
    },
  };
  const v = prefs.validate(good);
  assert.strictEqual(v.nudges.preset, "coach");
  assert.strictEqual(v.nudges.overrides.hydrate.enabled, false);
  assert.strictEqual(v.nudges.lastFiredAt.pomodoroBreak, 1700000000000);
}

// 6. Validate rejects array nudges (must be plain object)
{
  const bad = { version: 3, nudges: ["bad", "shape"] };
  const v = prefs.validate(bad);
  assert.strictEqual(v.nudges.preset, "normal", "array nudges falls back to defaults");
}

// 7. Validate rejects array overrides field within nudges
{
  const bad = { version: 3, nudges: { preset: "coach", overrides: ["nope"] } };
  const v = prefs.validate(bad);
  assert.strictEqual(v.nudges.preset, "coach", "preset preserved");
  assert.deepStrictEqual(v.nudges.overrides, {}, "array overrides normalized to empty object");
}

// 8. Migration is idempotent for nudges — re-migrating a current-version
// file leaves the nudges block alone. We bump the literal version to
// CURRENT_VERSION so a future schema bump doesn't re-trigger a cascade
// that this test isn't checking for.
{
  const already = {
    version: prefs.CURRENT_VERSION,
    nudges: { preset: "quiet", overrides: {}, lastFiredAt: {} },
  };
  const out = prefs.migrate(already);
  assert.strictEqual(out.version, prefs.CURRENT_VERSION);
  assert.strictEqual(out.nudges.preset, "quiet", "preset preserved through no-op migrate");
}

// 9. Round-trip through file persistence
{
  const tmp = path.join(os.tmpdir(), `prefs-pawpal-test-${Date.now()}.json`);
  const snap = prefs.getDefaults();
  snap.nudges.preset = "coach";
  snap.nudges.overrides = { longSit: { enabled: false } };
  prefs.save(tmp, snap);
  const { snapshot: loaded } = prefs.load(tmp);
  assert.strictEqual(loaded.nudges.preset, "coach");
  assert.strictEqual(loaded.nudges.overrides.longSit.enabled, false);
  assert.strictEqual(loaded.version, prefs.CURRENT_VERSION);
  fs.unlinkSync(tmp);
}

console.log("OK — prefs PAWPAL-1 tests pass");
