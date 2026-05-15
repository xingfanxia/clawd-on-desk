# Changelog

## v0.10.0 — 2026-05-15 (PAWPAL-4)

**New: Personality per pet.** Each theme ships a `personality` block in
`theme.json` that tunes how often nudges fire. Munchkin pushes you into
focus mode harder; Ragdoll is more attentive to hydration / sleep /
break. Users can override individual modifiers per theme via prefs.

### Added

- **`personality` block in all 5 built-in `theme.json`** — `label`,
  `labelKey`, and `modifiers` map (nudgeId → weight). Five distinct
  personalities ship out of the box:
  - **clawd** — Balanced (all 1.0; no modification)
  - **calico** — Playful (`hydrate` 0.9, `socialHeadShake` 1.3)
  - **cloudling** — Dreamy (`pomodoroBreak` 0.9, `longSit` 0.7, `lateNightYawn` 1.5)
  - **munchkin** — Work-energizer (`pomodoroBreak` 1.5, `hydrate` 0.7, `socialHeadShake` 0.8, `stuckOnProblem` 1.2)
  - **ragdoll** — Wellness-keeper (`hydrate` 1.5, `longSit` 1.5, `lateNightYawn` 1.5, `socialHeadShake` 0.9, `longWindowBreak` 1.2, `batteryLow` 1.2)
- **`effectiveWeight(nudgeId)` in `nudges.js`** — computes the
  multiplier that divides the schedule interval. Weight > 1 → more
  frequent; weight < 1 → less frequent. Clamped to [0.1, 5.0].
- **`getActiveThemePersonality()` in `_nudgesCtx`** — surfaces the
  active theme's personality block to the scheduler.
- **`prefs.activeThemePersonalityOverrides`** — per-theme weight
  overrides keyed by `themeId`. v1 ships JSON-file-edit path; visual
  editor lands in PAWPAL-4.1.
- **5 personality labels** across en/zh/ko/ja (Korean + Japanese
  inherit English per PAWPAL-1 convention).

### Changed

- **Prefs schema** v5 → v6 — adds `activeThemePersonalityOverrides`
  (default `{}`). Existing v5 users auto-migrate.
- **`startCronNudge`** divides interval by `effectiveWeight(nudgeId)`.
  Munchkin's pomodoro fires every ~17 min (25 / 1.5) at normal preset.
- **`longSit` detector** — same weight applied to threshold AND
  recently-fired guard so the spacing stays self-consistent.

### Honored

- **All 3 PAWPAL-1 invariants preserved**: personality is a scheduling
  modifier only; behavior overlays still compose over state; Soul ↔
  Nudge orthogonality untouched (mood routing in `state.js` ignores
  personality); DND + preset + per-nudge override gates apply before
  personality enters the picture.
- **Backward-compatible**: missing `personality` block or missing
  `getActiveThemePersonality` accessor → silent weight=1.0 for all
  nudges. PAWPAL-1/2/3 tests continue to pass unmodified.

### Out of scope (deferred to PAWPAL-4.1)

- **Settings UI editor** — visual per-nudge slider per active theme. v1
  ships JSON-file-edit path: users open prefs.json and add entries to
  `activeThemePersonalityOverrides`. PAWPAL-4.1 adds the visual editor.
- **Cross-pet rotation** — single active pet only.
- **Soul-driven personality drift** — personality is static config.

### Stats

- 5 theme.json files updated
- 2 new test files (prefs-pawpal4 + nudges-pawpal4) = +13 tests
- ~250 LOC added (mostly schema + helpers; minimal main.js wiring)

---

## v0.9.0 — 2026-05-15 (PAWPAL-3)

**New: External integrations (macOS-native subset).** Three new opt-in
integration signal sources — Apple Music Now Playing (BPM-driven head bob),
battery low (carrying behavior), and system events (screen lock / unlock,
AC change) — each routed through the PAWPAL-1 nudge scheduler. Same opt-in-
by-default + DND-aware structure as workspace awareness.

### Added

- **`src/integrations/` directory** — registry + 3 detector modules wired
  through the existing `ctx.subscribeWorkspace` channel surface, so
  `nudges.js` stays generic (one channel → one detector).
  - `index.js` — `createIntegrationsRegistry` factory; gates each sub-
    detector by `prefs.integrations.<source>.enabled` AND master
    `integrations.enabled`. Reverse-order teardown, idempotent start/stop.
  - `music.js` — polls Apple Music via `osascript` every 10s; emits
    `music.bpmChange` on the LEADING edge of "track BPM >= threshold"
    (per-track de-dup so repeated polls of the same high-BPM song don't
    spam fire).
  - `battery.js` — polls `pmset -g batt` every 60s. Edge-trigger on
    "battery + pct <= threshold"; latched until the user goes on AC or
    pct rises by `threshold + 5` (hysteresis prevents flapping).
  - `system-events.js` — wraps Electron `powerMonitor` lock-screen /
    unlock-screen / suspend / resume / on-ac / on-battery. Three exported
    channels (onScreenLock, onScreenUnlock, onAcChange). Per-toggle
    subscription so the noise budget can be tuned per user.
- **3 new integration nudges**: `musicBpmHigh` (`headBob` behavior, 1-min
  cooldown), `batteryLow` (`carrying` state, 30-min cooldown), `screenLocked`
  (`sleeping` state, no cooldown). All flow through `shouldFire()` so
  DND + preset + per-nudge overrides apply.
- **`headBob` behavior** added to all 5 built-in themes
  (calico/clawd/cloudling/munchkin/ragdoll) — falls back to `working` state
  until dedicated APNG assets ship.
- **Settings → Awareness → Integrations section** — master toggle + 3 sub-
  feature toggles. Sits below Workspace Awareness, above Soul-driven idle.
- **i18n keys** — 9 new keys (3 nudges × title+body + 6 settings strings)
  across en/zh, with ko/ja English fallbacks per PAWPAL-1 convention.

### Changed

- **Prefs schema** v4 → v5 — adds `integrations` block (master + 3 sub-
  blocks). All defaults `false`; opt-in only. Existing v4 users auto-
  migrate (silent — no setting wakes up without explicit user action).
  Prototype-pollution defense via `stripPrototypePollutionKeys` reused.
- **`_nudgesCtx.subscribeWorkspace`** — extends with 4 new channels:
  `integration.musicBpmHigh`, `integration.batteryLow`,
  `integration.screenLock`, `integration.acChange`. Channels stay generic;
  routing to the integration registry happens in main.js.
- **`PRESET_ENABLES`** — extended from 7 to 10 nudge ids. quiet preset
  keeps only `batteryLow` (safety signal); normal/coach get all 10.

### Honored

- **All 3 PAWPAL-1 invariants preserved**: behavior overlays compose over
  state (no setState); Soul ↔ Nudge orthogonality (integrations are signal
  sources only); aggression dial respects DND + preset + per-nudge override.

### Out of scope (deferred to PAWPAL-3.1)

- **Google Calendar 5-min warning** — requires `googleapis` dependency +
  OAuth flow + token persistence. No equivalent infra in clawd-on-desk
  today; significant new surface that warrants its own PR.
- **Spotify Now Playing** — needs Web API OAuth (similar reason).
- **Network drop nudge** — detector exists for screen-lock + AC; network
  drop intentionally not wired (pet reacting to wifi loss could compound
  user frustration).
- **Per-app battery / music threshold sliders** in Settings — JSON file
  edit only for v1; visual editors deferred.

### Stats

- 9 new src files (3 detectors + 1 registry index + 4 test files + 1
  prefs-pawpal3 test file)
- 1722 → 1776 tests (+54 new; 11 pre-existing failures unchanged)
- ~1500 LOC added across src/integrations/ + test/integrations-*

---

## v0.8.0 — 2026-05-XX (PAWPAL-2)

**New: Workspace awareness.** Opt-in OS introspection layer biases cat's idle pose based on the active app (Code → working, YouTube → dozing, Figma → happy) and emits 3 new focus-mode nudges (head-shake on doom-scroll, thinking pose on typing+CPU stuck, walk-across on 90-min same-window). All gated behind Accessibility permission with silent-deny fallback.

### Added

- **Workspace awareness layer** — opt-in OS introspection that biases cat's idle variant based on the active app and emits "focus mode" nudges:
  - **Active app categorization** — substring-matching map (Code/Cursor/Terminal → `code`, YouTube/Netflix → `video`, Figma → `creative`, etc.); user-editable JSON rules in Settings → Workspace Awareness; defaults seeded.
  - **Idle variant bias** — `code` → working pose, `video` → dozing, `creative` → happy (cat watches you make things). Mood-based routing still active for other categories.
  - **3 new workspace nudges**: `socialHeadShake` (category=social → headShake overlay; 5-min cooldown), `stuckOnProblem` (typing pause + CPU pressure → thinking overlay; **never fires in v1** — requires both signals, and no keystroke source ships until PAWPAL-2.2's CGEventTap native module), `longWindowBreak` (90 min same window → walkAcross overlay; 30-min global cooldown). All gated by preset + DND + per-nudge override.
  - **Active overlay cancel on focus enter** — switching INTO code/creative apps cancels active nudge overlays so user isn't interrupted mid-task.

- **OS permission gate** (`src/os-permission.js`) — single source of truth for macOS Accessibility + Input Monitoring permission state. Probes via `osascript` (Accessibility) + sentinel keystroke (Input Monitoring deferred to PAWPAL-2.2). Silent-deny fallback — features no-op without nag prompts. Settings UI surfaces "Grant access" / "Open System Settings" deep-links via Electron `shell.openExternal`.

- **Three new detectors** (all silent-no-op when permission denied or feature disabled):
  - `src/workspace-detector.js` — 5s polling of frontmost app + 5s debounce + category substring map
  - `src/system-monitor.js` — typing rate (60s rolling window) + CPU pressure via `top -l 1` (state machine: stuck = ≥30s typing pause + ≥2 min CPU>70%) — typing rate currently returns `null` since real macOS keystroke detection requires CGEventTap (deferred to PAWPAL-2.2)
  - `src/long-window-tracker.js` — same-window duration via workspace-detector subscription + `Date.now()` timestamp (sleep/wake robust) + 30-min cooldown

- **Settings → Awareness → Workspace Awareness section** — master toggle + 3 sub-feature toggles + permission status indicators (granted/denied/revoked/unavailable/unknown) + Edit Category Rules modal (JSON textarea with live validation) + long-window threshold dropdown (60/90/120 min).

- **`headShake` behavior** added to all 5 built-in themes (calico/clawd/cloudling/munchkin/ragdoll) — falls back to `error` state until dedicated APNG assets ship (PAWPAL-2.x).

### Changed

- **Prefs schema** v3 → v4 — adds `workspaceAwareness` block (master + per-feature toggles + category rules + thresholds). Strict opt-in: all toggles default `false`. Existing users auto-migrate. Schema includes prototype-pollution defense (`stripPrototypePollutionKeys` helper lifted to module scope; `nudges` block also migrated to use it).
- **`pickIdleVariantName(mood, workspace)`** — extended signature in `src/state.js`. Workspace category overrides mood routing for `code`/`video`/`creative`. Other categories fall through to existing PAWPAL-1 mood logic. Existing 0.7/0.3 mood thresholds preserved verbatim.
- **`_nudgesCtx`** in `src/main.js` — adds `getActiveApp`, `getAppCategory`, `getTypingRate`, `getCpuPressure`, `getCurrentWindowDurationMs`, `subscribeWorkspace` readers/methods.
- **i18n.js + settings-i18n.js** — adds ~30 keys × 4 locales (en/zh fully localized; ko/ja English fallback per PAWPAL-1 convention).
- **`popBehavior` (main.js)** — wired up (was `TODO(PAWPAL-2)` placeholder). Fires on focus-enter transitions to code/creative apps.

### Honored

- **All 3 PAWPAL-1 invariants preserved**:
  1. Behavior overlay layer composes OVER state. Workspace nudges use `ctx.pushBehavior` (overlay), never `setState`.
  2. Soul ↔ Nudge orthogonality. Workspace bias affects idle variant ONLY (not nudge scheduling). Health nudges (Pomodoro/hydrate/longSit/lateNightYawn) untouched. Mood routing still primary for non-focus categories.
  3. Aggression dial respects DND + 3-preset + per-nudge override. All 3 new workspace nudges flow through `shouldFire()` — DND blocks them, preset gates them, per-nudge overrides force-off.
- **simpleMode stays orthogonal** — workspace awareness opt-in is independent of simpleMode default.
- **Permission denied = silent no-op everywhere** — no console errors, no nag prompts, detector polling stops at gate check.

### Out of scope (deferred to PAWPAL-2.x)

- **Real macOS keystroke detection** (`getTypingRate()` returns `null` in v1 — requires CGEventTap native module). PAWPAL-2.2.
- **Win/Linux Input Monitoring** — v1 macOS-only for typing-pressure detection. PAWPAL-2.2.
- **Visual category rules editor** — v1 ships JSON textarea modal. PAWPAL-2.1.
- **Custom user-defined nudges + per-app cooldown overrides** — PAWPAL-2.1 with the rule engine.
- **Dedicated head-shake APNGs per theme** — v1 falls back to `error` state. PAWPAL-2.x or pet-forge follow-up.
- **Cross-app individual window tracking** — v1 ships app-granularity for `longWindowBreak`. Requires native accessibility module for true per-window. PAWPAL-2.x.
- **Permission-revoked notification toast** — v1 surfaces only when user opens Settings.

### Migration

- All schema changes are additive. Prefs migration is one-way (v3 → v4) but downgrade-safe — a v4 file with `workspaceAwareness` block works on a v3 binary (block is ignored); a v3 file on v4 binary auto-migrates with all toggles defaulting `false`.
- Themes get the `headShake` behavior key — no asset required, falls back to existing `error` state.
- Rollback: `git revert` the PAWPAL-2 commits + manually edit `clawd-prefs.json` to remove the `workspaceAwareness` block if desired.

---

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
