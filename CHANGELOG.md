# Changelog

## v0.7.0 — 2026-05-XX (PAWPAL-1)

**New: Self-care nudges + Soul-driven idle.** Cat actively reminds you to take Pomodoro breaks, drink water, stand up; idle expression subtly reflects current Soul mood.

### Added

- **Behavior overlay layer** — transient APNGs above the state machine. Composes over `working`/`idle`/`thinking`/etc. without blocking transitions. `walk-across` overlay shipped; theme schema reserves `behaviors.<id>` for future overlays.
- **Nudge scheduler** (`src/nudges.js`) — cron + detector + schedule-based with 3 presets:
  - **Quiet:** Pomodoro every 50min only.
  - **Normal:** Pomodoro 25min, hydrate 90min, long-sit 30min, late-night yawn from 23:00.
  - **Coach:** Pomodoro 25min, hydrate 60min, long-sit 20min, yawn from 22:30. Adds native macOS notification + sound.
- **Per-nudge override** — disable any individual nudge from the Awareness tab without leaving the preset.
- **Soul `/mood` polling → idle variant routing** — every 60s while idle, fetch mood and pick `idleVariants.happy` / `idleVariants.dozing` / plain idle. 30s hysteresis prevents flap.
- **Settings → Awareness tab** — preset selector, per-nudge toggles, Soul-Driven Idle info row.
- **Theme schema additions:** `behaviors.<id>` (file + duration + fallbackTo) and `idleVariants.<name>` (file array). Munchkin + ragdoll wired with full asset; legacy themes (calico/clawd/cloudling) ship with `fallbackTo: notification`.
- **Native macOS notification helper** (`showNativeNotification` in main.js).
- **Walk-across animation** — shipped via PETFORGE-1.1 prereq for munchkin + ragdoll.

### Changed

- **Prefs schema** v2 → v3 — adds `nudges: { preset, overrides, lastFiredAt }`. Existing users auto-migrate; preset defaults to "normal".
- **i18n.js** — adds 8 nudge title/body keys (en + zh; ko + ja fall back to English for v1).
- **settings-i18n.js** — adds 16 Awareness UI keys (en + zh; ko + ja English fallback).

### Honored

- **DND** is honored everywhere — `shouldFire()` checks `isDndEnabled()` at fire time across all nudge types.
- **simpleMode** stays orthogonal — health nudges fire regardless. Soul-driven idle no-ops gracefully when soul is unhealthy/absent.

### Out of scope (deferred)

- **Anti-fatigue backoff** — intentionally NOT in v1 per spec Q3. Ships the raw schedule, observes what gets annoying, then adds backoff in a v2. `lastFiredAt` is recorded in prefs so v2 has data to work with.
- **Korean / Japanese translations** — strings ship as English fallbacks for v1.
- **PAWPAL-2** OS introspection (focus mode, typing rate, CPU stress) — separate plan.
- **PAWPAL-3** external service integrations (calendar, music, battery) — separate plan.
- **PAWPAL-4** personality-per-pet — separate plan, depends on enough behaviors to weight.

### Migration

- All schema changes are additive. Prefs migration is one-way (v2 → v3) but downgrade-safe — a v3 file with `nudges` block works on a v2 binary; a v2 file on v3 binary auto-migrates with default preset "normal". Theme schema additions are backward-compatible.
- Rollback: `git revert` the PAWPAL-1 commits + manually edit `clawd-prefs.json` to remove the `nudges` block if desired.

---
