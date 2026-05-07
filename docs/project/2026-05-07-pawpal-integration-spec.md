# PawPal Integration — Full Design Spec

> **Status**: draft (awaiting AX review)
> **Created**: 2026-05-07
> **Brainstorm input**: [`pawpal-integration-ideas.md`](./pawpal-integration-ideas.md)
> **Inspiration**: [PawPal](https://github.com/zebangeth/PawPal) — desktop dog with break/water/focus reminders
> **Next step (after approval)**: `superpowers:writing-plans` skill → PAWPAL-1 implementation plan

## DNA decision

**Mode A — Nudging pet** (PawPal-aligned). The pet actively interrupts to prompt healthy behavior. clawd-on-desk's current passive/reflective behavior (Claude-only triggers) is preserved as the *underlying* state; nudging is **additive on top**.

Cat is your coach, not just your audience.

## Architecture pillars (apply to every wave)

| Pillar | Decision | Why |
|---|---|---|
| **State extension model** | Hybrid — reuse existing `notification` / `attention` states for nudges that fit; add ONE **behavior overlay** mechanism for transient animations (walk-across, jump, particle effects) that don't displace underlying state | Walk-across is a *traversal*, not a state — cat retains underlying mood; behavior layer composes over state layer |
| **Soul ↔ Nudge coupling** | Orthogonal — Soul drives idle *visual* variants (mood high → idle uses `happy`; low → `dozing`); nudges are cron/event-driven with independent user controls | Mixing them turns mood into a nudge gate, which means low-mood users get fewer health nudges — worse outcome. Mood is "who the cat is right now"; nudges are "what the cat needs to remind you." |
| **Aggression dial** | 3-preset (`quiet` / `normal` / `coach`) + per-nudge-type enable toggle + always honor DND | Avoids granular settings overwhelm. Most users never customize beyond the preset. |
| **Theme compatibility** | Required: existing themes (Calico, Clawd, Cloudling) get a `behaviors.walkAcross.fallback: "notification"` so nudges still fire. New themes (post-pet-forge v1.1) ship walk-across APNG. | No regressions; gradual upgrade path. |
| **Permissions UX** | Permissions requested *only* when user enables the feature that needs them (Wave 2 focus mode → Accessibility prompt at toggle-on, not at install) | PawPal asks at first-run; we hide friction behind opt-in. |

## Wave plan (4 sub-projects, dependency-ordered)

| Wave | Scope | Asset cost | New code surface | Why this order |
|---|---|---|---|---|
| **PAWPAL-1** | Self-care timers (Pomodoro break, hydration, long-sit, time-of-day mood) + Soul-driven idle variants + walk-across APNG generation | +1 APNG / theme (~$0.30 / pet via pet-forge) | `src/nudges.js` (new) · `src/state.js` (behavior layer) · `src/theme-loader.js` (schema bump) · settings UI panel | Smallest blast radius. Tests nudging UX before deeper integrations. Soul-mood is a 1-file change with huge perceptual payoff. |
| **PAWPAL-2** | OS introspection — active-app focus mode, CPU stress, typing-rate, multi-monitor follow | 0 new APNGs (reuses `thinking` / `working` / `attention` / `error`) | `src/focus-detector.js` (new, macOS Accessibility) · `src/system-monitor.js` (new) · permission-prompt flow | Needs Accessibility / Input Monitoring permission. UX for grant + categorization is its own design once #1 ships. |
| **PAWPAL-3** | External service integrations — calendar 5-min warning, music BPM sync, battery low, system event hooks | 0 new APNGs (reuses existing) | per-service adapter modules in `src/integrations/` | Each integration is loosely coupled. Ship one at a time after #1-2 prove the model. |
| **PAWPAL-4** | Personality-per-pet — `theme.json` `personality` field with per-pet nudge weight modifiers (小肥 = work-energizer, 胖猫 = wellness-keeper) | 0 (reuses) | `src/theme-loader.js` (schema add) · `src/nudges.js` (modifier application) | Future-looking. Requires #1-3 to provide meaningful behaviors to weight. |

---

## PAWPAL-1: Self-care nudges + Soul-driven idle

### What it does

Cat actively reminds you to take breaks, drink water, stand up, sleep at reasonable hours. Cat's **idle visual** subtly reflects current Soul mood — energetic when high, drowsy when low.

### New `behavior` concept

`STATE_PRIORITY` stays as-is. **Behaviors** layer over states:

```js
// state.js extension
const ACTIVE_BEHAVIORS = new Set(); // e.g. {"walk-across", "particle-water-drop"}

function pushBehavior(behaviorId, opts) { /* duration, callback */ }
function popBehavior(behaviorId) { /* */ }
```

A behavior renders an extra animation layer over the cat's current state. When all behaviors finish, render reverts to bare state. Critical: behaviors NEVER block state transitions — Claude calls a tool mid-Pomodoro-walk-across and the underlying state still goes to `working`.

### New cron / scheduler

`src/nudges.js`:

```js
const NUDGES = {
  pomodoroBreak:  { interval: 25 * 60_000, behavior: "walkAcross", message: "Time to stretch!" },
  hydrate:        { interval: 60 * 60_000, behavior: "attention",  message: "Drink some water 💧" },
  longSit:        { detector: longSitDetector, behavior: "walkAcross", message: "Stand up!" },
  // ...
};

function scheduleNudges(activePreset, perNudgeOverrides, dndState) { /* */ }
```

Each nudge has: `interval` (cron OR detector function), `behavior` to fire, `message` (system notification text), `respectsDnd: true` always.

### Soul-driven idle variants

`state.js` extension — when about to enter `idle`, query Soul HTTP at `127.0.0.1:23456/mood`:

```js
function pickIdleVariant(mood) {
  const score = mood.energy * 0.6 + mood.affection * 0.4;
  if (score > 0.7) return theme.idleVariants.happy || theme.states.idle;
  if (score < 0.3) return theme.idleVariants.dozing || theme.states.idle;
  return theme.states.idle;
}
```

`theme.json` schema extension:

```jsonc
{
  "states": { "idle": ["munchkin-idle-dozing.apng"], ... },
  "idleVariants": {
    "happy":  ["munchkin-happy.apng"],     // reuses existing happy state
    "dozing": ["munchkin-idle-dozing.apng"] // alias to baseline
  },
  "behaviors": {
    "walkAcross": {
      "file": "munchkin-walk-across.apng",
      "duration": 3000,
      "fallback": "notification"   // for themes lacking the asset
    }
  }
}
```

### 3-preset aggression

| Preset | Pomodoro | Hydrate | Long-sit | Late-night yawn |
|---|---|---|---|---|
| `quiet` | every 50 min | off | off | off |
| `normal` (default) | every 25 min | every 90 min | 30+ min static cursor | 23:00+ idle yawns more frequent |
| `coach` | every 25 min + walk-across | every 60 min | 20+ min | 22:30+ |

User can override individual nudges in Settings.

### New asset: walk-across animation

Per pet — cat walks across the screen left-to-right (transparent, ~3 seconds, no chroma background). Generated via **pet-forge skill** addition:

- Add `walk-across` to `ALL_STATES` (becomes 11 states)
- New pose-ref in `POSE_REF_PROMPTS`: "Same cat, mid-stride walking pose, 3/4 view, one front paw raised, body in motion blur, tail extended back"
- New motion prompt in `template.example.js`: "Cat walks across screen left-to-right with a confident gait, 4 paw cycles, head bobs slightly with each step, tail flicks. Body translation visible in the frame from left edge to right edge."

Cost: +$0.30 per existing pet to retrofit. New pets generated via pet-forge automatically include it.

### DND interaction

Existing DND mode (already in clawd-on-desk) blocks all nudge fires. When DND is on, Soul-driven idle variants still apply (those are visual only, no interruption). Nudges resume when DND off; missed nudges DO NOT replay.

### Files touched (PAWPAL-1)

```
src/nudges.js                           NEW
src/state.js                            extend with behavior layer + idle variant routing
src/theme-loader.js                     extend schema (idleVariants, behaviors)
src/main.js                             wire IPC for nudge → tray notification + sound
src/renderer.js                         render behavior overlay layer
themes/<each>/theme.json                add idleVariants + behaviors stub
themes/<each>/assets/<pet>-walk-across.apng    NEW (regenerate via pet-forge)
~/projects/AX-skills/pet-forge/...      add walk-across to pipeline (separate spec/PR)
```

---

## PAWPAL-2: OS introspection

### What it does

Cat reacts to broader workspace context: if you switch to social-media app, cat shakes head; if you're stuck on a problem (typing pause + high CPU), cat looks concerned; if you've been on the same window for 90+ min, cat suggests a break.

### Permissions

macOS Accessibility (active app + window title) and Input Monitoring (typing rate) — both gated behind opt-in toggles in Settings → "Workspace awareness." Permission prompt fires when toggle flipped on, not at install. Detector silently no-ops if permission denied.

### App categorization

User-editable list (with sensible defaults):

| Category | Default apps | Cat reaction |
|---|---|---|
| `code` | VS Code, Cursor, IntelliJ, Terminal | bias `idle` toward `working`-style (small typing motion) |
| `docs` | Browser on docs sites, Notion, Obsidian | bias `idle` toward `thinking` |
| `social` | Twitter/X, Instagram, Reddit (browser) | head-shake reaction (or `error` if `coach` preset) |
| `chat` | Slack, Discord, iMessage | `attention` once per conversation switch |
| `video` | YouTube, Netflix, Twitch | `dozing` (relax mode) |
| `creative` | Figma, Photoshop, Final Cut | `attention` (cat watches you make things) |

User can add custom rules: "if app contains X and idle-preset = coach → attention with N=5min cooldown."

### Files touched (PAWPAL-2)

```
src/focus-detector.js                   NEW (macOS Accessibility)
src/system-monitor.js                   NEW (CPU + typing rate)
src/nudges.js                           extend with detector-based nudges
src/permission-flow.js                  NEW (settings toggle → prompt OS)
themes/<each>/theme.json                no schema change (reuses existing states)
```

### Risks specific to PAWPAL-2

- Accessibility permission rejected → focus mode silently disabled, surface in Settings ("Focus mode requires Accessibility — grant in System Settings")
- App categorization is opinionated; user-editable from day 1
- High-frequency app switching (Cmd+Tab heavy users) → debounce reactions to ≥5s window

---

## PAWPAL-3: External service integrations

### Each integration is its own mini-spec

| Integration | API | Trigger | Cat reaction | Estimated effort |
|---|---|---|---|---|
| **Calendar 5-min warning** | Google Calendar via `gws-calendar-agenda` skill (already authed) | Event in 5 min | `attention` + system notification with event title | 1 day |
| **Music sync** | Apple Music (`osascript` Now Playing) — Spotify (Web API or AppleScript) | BPM > 120 | head-bob behavior overlay | 2 days |
| **Battery low** | macOS `pmset -g batt` poll every 5 min | Battery < 20% on battery power | `carrying` state with battery icon overlay | 0.5 day |
| **System events** | Network drop, dock connect, screen lock | Per-event reactions | TBD (small one-off behaviors) | 0.5 day each |

### Order to ship

Recommended: Calendar → Music → Battery → System events. Calendar provides immediate utility; music adds personality; battery is a nice-to-have; system events are flavor.

### Files touched (PAWPAL-3, per integration)

```
src/integrations/<name>.js              NEW
src/nudges.js                           register integration as nudge source
themes/<each>/theme.json                possibly add behavior/particle assets
```

---

## PAWPAL-4: Personality per pet

### What it does

`theme.json` gets a new `personality` field — an array of nudge-weight modifiers that tune *how often* a given pet nudges for what. 小肥 nudges more about work focus; 胖猫 nudges more about hydration/sleep.

### Schema extension

```jsonc
{
  "personality": {
    "label": "work-energizer",   // free text for display
    "modifiers": {
      "pomodoroBreak":   { "weight": 1.5 },   // 50% more frequent
      "hydrate":         { "weight": 0.5 },   // 50% less frequent
      "longSit":         { "weight": 1.0 },
      "focusMode.code":  { "weight": 1.5 },   // extra-celebrate code editor focus
      "focusMode.social":{ "weight": 0.7 }    // milder shame on social
    }
  }
}
```

`nudges.js` multiplies effective interval by `1 / weight` when computing schedule.

### Example personalities

| Pet | Label | Bias |
|---|---|---|
| 小肥 (Munchkin) | work-energizer | pomodoro+, social- (less judgment), code+ (extra celebrate) |
| 胖猫 (Ragdoll) | wellness-keeper | hydrate+, long-sit+, late-night-yawn+ |

User can edit per-pet in Settings → "Pet personality."

### Why last

Requires PAWPAL-1 (nudge system) and PAWPAL-2 (focus mode) to provide enough behaviors to weight. Without them, personality has nothing to tune.

---

## Cross-cutting concerns

### State machine layering (apply to all waves)

```
┌─ Behavior layer ───── walkAcross, particles, transient overlays ─┐
├─ State layer ──────── working / idle / sleeping / notification  ──┤
└─ Visual variant layer  Soul-driven idle variants (happy/dozing)  ─┘
```

State layer remains the existing `STATE_PRIORITY` system. Behavior layer is new. Variant layer is a thin routing layer at idle-state-entry only.

### DND honored everywhere

Existing DND mode + new "Pet quiet" mode (different toggle — DND silences the pet entirely; "Pet quiet" silences nudges only, keeps Claude-driven reactions). Per-nudge respect is built in, no opt-out.

### Settings UI

New Settings → "Awareness" panel:

```
[ ] Self-care nudges
    Preset: ( ) Quiet  (•) Normal  ( ) Coach
    [✓] Pomodoro break
    [✓] Hydration reminders
    [✓] Long-sit detection
    [✓] Late-night yawn
[ ] Workspace awareness (requires permissions)
    [ ] Active app reactions
        [ ] Code editor → working
        [ ] Docs → thinking
        [ ] Social media → ... (with intensity slider)
    [ ] Typing rate
    [ ] CPU stress
[ ] External integrations
    [ ] Google Calendar (5-min event warnings)
    [ ] Music BPM sync (Apple Music / Spotify)
    [ ] Battery low alerts
[ ] Pet personality (per-pet override of nudge weights)
```

Each top-level group is collapsible. Defaults match `normal` preset.

### Permission flow (PAWPAL-2 specifically)

```
User toggles "Active app reactions" ON
   │
   ▼
Check macOS Accessibility permission status
   │
   ├── Granted ────────▶ Enable feature
   │
   └── Not granted ────▶ Show modal: "This needs Accessibility — open System Settings?"
                          │
                          ├── Yes → open `x-apple.systempreferences:...`
                          │       wait for app to come back foreground
                          │       re-check permission → enable or show error
                          │
                          └── No → toggle flips back off, no nag
```

### Nudge config storage

User prefs persist in `app.getPath("userData")/preferences.json`:

```jsonc
{
  "nudges": {
    "preset": "normal",
    "overrides": {
      "pomodoroBreak":   { "enabled": true,  "intervalMin": 25 },
      "hydrate":         { "enabled": true,  "intervalMin": 90 },
      "longSit":         { "enabled": false }
    },
    "perPet": {
      "munchkin":   { "personalityOverride": "work-energizer" },
      "ragdoll":    { "personalityOverride": "wellness-keeper" }
    }
  },
  "permissions": {
    "accessibilityGranted": true,
    "inputMonitoringGranted": false
  }
}
```

### Asset pipeline (pet-forge handoff)

PAWPAL-1 needs walk-across APNG. **pet-forge skill must be updated FIRST** as a separate sub-task before PAWPAL-1 can ship:

- Add `walk-across` to `ALL_STATES` in `pet-forge/generate.py` (becomes 11 states)
- Add `walk-across` to `POSE_REF_STATES` and `POSE_REF_PROMPTS`
- Add motion prompt for walk-across to `prompts/template.example.js` and breed variants
- Re-run pet-forge for 小肥 and 胖猫 to backfill walk-across.apng (~$0.60 total spend, ~6 min)
- Bump pet-forge to v1.1, document in CHANGELOG

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **Aggression backlash** — coach mode feels naggy | Default to `normal`; coach is opt-in; per-nudge toggles always available |
| **Accessibility permission friction** kills PAWPAL-2 adoption | Toggle gates the prompt; explain value before asking; gracefully degrade |
| **Walk-across animation quality** varies by pet aesthetic | Generate + iterate via pet-forge; falls back to notification state for themes without it |
| **Soul mood flapping** (mood toggles cause idle flicker) | Hysteresis — only switch idle variant if mood crosses threshold for 30s+ |
| **Personality v1 is per-pet but most users have ONE pet** | Ship as Wave 4; if user adoption stays single-pet, repurpose modifier system as global "tone" knob |
| **Nudge silently failing** when DND is on | Log to console, surface in Settings → "Last nudge: silenced (DND)" |
| **External services without internet** | Each integration handles its own offline state (calendar = silent, music = no-op) |

### Open questions (resolve during writing-plans)

- **Notification banner vs animation-only**: Walk-across IS the notification, OR walk-across PLUS macOS notification banner? My pick: animation-only for `quiet`/`normal`, animation + sound + banner for `coach`. Confirm during planning.
- **Anti-fatigue**: should "you've seen this nudge 5 times today" trigger backoff? (PawPal does this implicitly; we should explicitly).
- **Multi-pet active simultaneously**: out-of-scope for v1 (one pet active at a time). Personality (PAWPAL-4) is about per-pet *config*, not concurrent display.
- **Telemetry**: do we want to log nudge effectiveness (was it dismissed quickly? did the user move?) for personalization? Out of scope for v1.

---

## Handoff notes for next session

### What's done

- PawPal brainstorm + 12 ideas surveyed → [`pawpal-integration-ideas.md`](./pawpal-integration-ideas.md)
- This spec drafted (2026-05-07) → awaiting AX review then `superpowers:writing-plans` skill for PAWPAL-1

### What's next (entry point for next session)

1. **Asset pipeline first** — bump pet-forge skill to v1.1 with walk-across state. Spec is in §"Asset pipeline" above. Fold this into PAWPAL-1 plan or split as a separate plan; AX preference to TBD at planning time.
2. **PAWPAL-1 plan** — write the implementation plan via `superpowers:writing-plans`. Touch points listed in §"Files touched (PAWPAL-1)."
3. **Validation** — Wave 1 ships. Use 1 week. Decide if `coach` preset is too aggressive, what nudges are silently failing, whether walk-across visual quality holds across themes.
4. **PAWPAL-2 plan** — only after PAWPAL-1 has user-feedback data. Permission UX needs validation before scaling categorization.

### Invariants for next session

- Don't ship PAWPAL-2/3/4 before PAWPAL-1 — sequencing matters because behavior overlay model + DND honoring is established in PAWPAL-1.
- Walk-across is **the only new asset**. Reject scope creep into "we should also add a yawning state" or similar — generates new asset cost without proven need.
- Soul integration MUST stay orthogonal to nudges. If a future PR couples them ("only nudge when energy is high"), revisit this spec — it's an architecture violation.

### Commands the next agent will run

```bash
# Read this spec and the brainstorm
cat docs/project/2026-05-07-pawpal-integration-spec.md
cat docs/project/pawpal-integration-ideas.md

# Read current state machine architecture
cat src/state.js
cat src/theme-loader.js | grep -A 20 "validateTheme\|mergeDefaults"

# Read existing DND + hooks to understand integration seams
cat hooks/install.js | head -50
grep -n "DND\|dnd" src/state.js src/main.js | head

# Pet-forge changes:
cd ~/projects/AX-skills/pet-forge && cat generate.py | head -50
# Add walk-across to ALL_STATES, POSE_REF_STATES, POSE_REF_PROMPTS

# Then invoke writing-plans for PAWPAL-1:
# (skill orchestrates from here)
```

---

*End of spec. Next step: AX reviews this doc → `superpowers:writing-plans` → implementation plan for PAWPAL-1.*
