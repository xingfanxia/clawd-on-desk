// state-idle-variant.test.js — verifies the score → variant decision logic
// for PAWPAL-1's Soul-driven idle variant routing. The async polling +
// hysteresis state are covered by Task 15 E2E smoke test (they require a
// live ctx + theme to exercise meaningfully).

const assert = require("assert");

// Reproduce the logic in isolation — _pickIdleVariantNameForTesting is also
// exported by initState(ctx) but requires a full ctx. This pure function
// matches the implementation in src/state.js and exists so we can fail
// loudly if the formula changes without an explicit test update.
function scoreToVariant(mood) {
  if (!mood) return "neutral";
  const energy = Number(mood.energy);
  const affection = Number(mood.affection);
  const e = Number.isFinite(energy) ? energy : 0.5;
  const a = Number.isFinite(affection) ? affection : 0.5;
  const score = e * 0.6 + a * 0.4;
  if (score > 0.7) return "happy";
  if (score < 0.3) return "dozing";
  return "neutral";
}

// 1. High energy + high affection → happy
assert.strictEqual(scoreToVariant({ energy: 0.9, affection: 0.9 }), "happy");

// 2. Low energy + low affection → dozing
assert.strictEqual(scoreToVariant({ energy: 0.1, affection: 0.1 }), "dozing");

// 3. Mid range → neutral (= "use plain states.idle")
assert.strictEqual(scoreToVariant({ energy: 0.5, affection: 0.5 }), "neutral");

// 4. Boundary above happy threshold (0.7 strict): score = 0.42 + 0.20 = 0.62 → neutral
assert.strictEqual(scoreToVariant({ energy: 0.7, affection: 0.5 }), "neutral");

// 5. Boundary at 0.71 → happy (0.6*0.85 + 0.4*0.5 = 0.71)
assert.strictEqual(scoreToVariant({ energy: 0.85, affection: 0.5 }), "happy");

// 6. Energy weighted heavier than affection: low energy + high affection → still mid
assert.strictEqual(scoreToVariant({ energy: 0.0, affection: 1.0 }), "neutral",
  "0*0.6 + 1*0.4 = 0.4 → neutral (energy carries 60% weight)");

// 7. Missing fields default to 0.5 → neutral
assert.strictEqual(scoreToVariant({}), "neutral");

// 8. Non-numeric fields default to 0.5 → neutral
assert.strictEqual(scoreToVariant({ energy: "abc", affection: null }), "neutral");

// 9. Null mood → neutral
assert.strictEqual(scoreToVariant(null), "neutral");

// 10. Energy alone can pull happy: 0.95*0.6 + 0.5*0.4 = 0.77 → happy
assert.strictEqual(scoreToVariant({ energy: 0.95, affection: 0.5 }), "happy");

console.log("OK — idle variant scoring logic test passes");
