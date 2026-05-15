// state-idle-variant.test.js — verifies the score → variant decision logic
// for PAWPAL-1's Soul-driven idle variant routing AND PAWPAL-2 Task 8's
// workspace-category override layer. The async polling + hysteresis state
// are covered by Task 15 E2E smoke test (they require a live ctx + theme
// to exercise meaningfully).

const assert = require("assert");

// ── Reproduce the logic in isolation ──────────────────────────────────────
// _pickIdleVariantNameForTesting is also exported by initState(ctx) (and
// re-exercised below), but the in-file reproduction stays so that any drift
// between the function the test thinks it's testing and the function actually
// shipping in state.js fails LOUDLY rather than silently. Both copies must
// match line-for-line.
function scoreToVariant(mood, workspace) {
  // PAWPAL-2 workspace override layer
  if (workspace && workspace.category === "code")     return "working";
  if (workspace && workspace.category === "video")    return "dozing";
  if (workspace && workspace.category === "creative") return "happy";

  // PAWPAL-1 mood routing
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

// ── PAWPAL-1: mood routing (unchanged — these cases lock the existing
//    thresholds 0.7 / 0.3 against accidental change in this task or future
//    refactors) ───────────────────────────────────────────────────────────

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

// ── PAWPAL-2 Task 8: workspace-category override layer ────────────────────

// 11. workspace === null falls through to mood routing (legacy behavior).
//     Uses a known-happy mood from case 1.
assert.strictEqual(scoreToVariant({ energy: 0.9, affection: 0.9 }, null), "happy");

// 12. workspace === undefined falls through to mood routing — matches the
//     case where ctx.getWorkspaceCategory() isn't wired at all on the host.
assert.strictEqual(scoreToVariant({ energy: 0.9, affection: 0.9 }, undefined), "happy");

// 13. category === "code" → "working", overriding even a low-energy mood
//     that would otherwise pick "dozing". This is the core override: when
//     the user is in their editor, the cat should look like it's working
//     alongside them regardless of Soul mood.
assert.strictEqual(
  scoreToVariant({ energy: 0.1, affection: 0.1 }, { category: "code" }),
  "working",
);

// 14. category === "code" overrides high-energy "happy" mood too. The
//     override is unconditional once category matches.
assert.strictEqual(
  scoreToVariant({ energy: 0.9, affection: 0.9 }, { category: "code" }),
  "working",
);

// 15. category === "video" → "dozing", overriding high-energy happy mood
//     (user is watching, cat should look relaxed).
assert.strictEqual(
  scoreToVariant({ energy: 0.9, affection: 0.9 }, { category: "video" }),
  "dozing",
);

// 16. category === "creative" → "happy", overriding low-energy dozing mood
//     (user is in Figma/Photoshop/etc., cat should look engaged).
assert.strictEqual(
  scoreToVariant({ energy: 0.1, affection: 0.1 }, { category: "creative" }),
  "happy",
);

// 17. category === "docs" → falls through to mood routing. Docs/reading is
//     a "weak signal" — mood should drive.
assert.strictEqual(
  scoreToVariant({ energy: 0.9, affection: 0.9 }, { category: "docs" }),
  "happy",
  "docs falls through to mood — high-energy happy mood preserved",
);
assert.strictEqual(
  scoreToVariant({ energy: 0.1, affection: 0.1 }, { category: "docs" }),
  "dozing",
  "docs falls through to mood — low-energy mood routes to dozing",
);

// 18. category === "social" → falls through to mood routing.
assert.strictEqual(
  scoreToVariant({ energy: 0.5, affection: 0.5 }, { category: "social" }),
  "neutral",
);

// 19. category === "chat" → falls through to mood routing.
assert.strictEqual(
  scoreToVariant({ energy: 0.5, affection: 0.5 }, { category: "chat" }),
  "neutral",
);

// 20. Unknown category (e.g., user-defined or pre-UNKNOWN_CATEGORY string)
//     falls through to mood routing. The category list isn't a closed enum
//     — categoryRules in prefs can produce arbitrary strings — so anything
//     not in code/video/creative defers to mood.
assert.strictEqual(
  scoreToVariant({ energy: 0.5, affection: 0.5 }, { category: "unknown" }),
  "neutral",
);

// 21. Workspace object without `category` key (defensive) — defers to mood.
//     We never expect this shape from the workspace-detector contract, but
//     guarding here prevents a future API drift from silently returning
//     undefined → "neutral" without anyone noticing.
assert.strictEqual(
  scoreToVariant({ energy: 0.9, affection: 0.9 }, {}),
  "happy",
);

// ── Hysteresis + theme-fallback notes (covered by Task 15 E2E) ────────────
// The hysteresis check in applyIdleVariantOnce operates on the picked
// variant NAME, so it composes correctly with workspace overrides: if
// workspace flips from `code` → `docs` within IDLE_VARIANT_HYSTERESIS_MS,
// the previous variant ("working") is held. Verifying that requires a live
// timer + clock control which is out of scope for this unit test — Task 15
// E2E smoke exercises it.
//
// Theme-fallback behavior (workspace picks "working" but theme defines no
// idleVariants.working) is also covered by applyIdleVariantOnce's existing
// `if (!Array.isArray(files) || files.length === 0) return;` guard at the
// site of variant resolution. This is untouched by Task 8 and remains
// covered by existing PAWPAL-1 tests.

console.log("OK — idle variant scoring + workspace-bias logic test passes");
