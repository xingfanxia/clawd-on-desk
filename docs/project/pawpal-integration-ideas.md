# PawPal-style integration ideas — brainstorm 2026-05-06

> Goal: make clawd-on-desk's pet react to broader user activity, not just Claude Code hooks.
> Inspiration: [PawPal](https://github.com/zebangeth/PawPal) — desktop dog with break/water/focus reminders.
> Status: brainstorm only, not yet planned. Pick up after `pet-forge` skill ships.

---

## Existing signal sources (today)

| Source | Triggers | Status |
|---|---|---|
| **Claude Code hooks** | PreToolUse, PostToolUse, SessionStart/End | working / happy / error / idle (per [`hooks/install.js`](../../hooks/install.js)) |
| **Mouse cursor poll** | idle timeout, sleep timeout, deep sleep | sleeping / dozing |
| **Click on cat** | drag, left-click, right-click | react-poke / react-drag |
| **Soul engine screen observation** | distance from camera, screen-content classification | mood (energy / interest / affection); already runs in `clawd-soul` server |

## PawPal's signal sources

- ⏰ Timed reminders (break / hydration cron)
- 🪟 macOS Accessibility API → active app detection
- 🌐 Categorized apps (social media → distract)
- 🐕 Run-across-screen attention-grabber animation

---

## Ideas grouped by signal type

### 🟢 Easy — built on existing architecture

| Idea | Trigger | Animation reuse | Notes |
|---|---|---|---|
| **Pomodoro break** | every 25 min cron | `notification` + horizontal walk-across | PawPal's signature move; needs walk-cycle APNG (one-time `pet-forge` re-run +$0.30/cat) |
| **Hydration reminder** | every 60 min cron | `attention` + 💧 splash particles | Reuse `attention` state; particle layer in renderer |
| **Active-app focus mode** | macOS Accessibility API every 5s | Browser+docs → `thinking`; Slack/IG/Twitter → `attention` (head-shake variant); Code editor → `working-typing` | Needs Accessibility permission prompt at install |
| **Soul mood drives idle variant** | Soul `mood.energy/interest/affection` already polled | High mood → idle aliases to `happy`; Low → `dozing`; Cuddly → idle leans toward camera | Soul state already exposed via `:23456`; just route it into `state.js` |

### 🟡 Medium — small new infrastructure needed

| Idea | Trigger | Animation reuse / new |
|---|---|---|
| **Calendar 5-min warning** | Google Calendar API (already authed via `gws-*` tools) | `attention` + 🕒 clock pointer particle |
| **Battery low** | macOS `pmset -g batt` poll | `carrying` (cat carries battery icon) |
| **Music sync** | Apple Music / Spotify now-playing API | head-bob to BPM (loop variants) |
| **Time-of-day mood** | local clock | 23:00+ → yawn frequency↑; 7-9 AM → happy energetic | Schedule-driven mood swap |
| **Long-sit detection** | mouse moves only within tiny radius for 30+ min | `attention` + walk-across-screen "stand up!" |

### 🔴 Deeper — new systems

| Idea | Trigger | Notes |
|---|---|---|
| **Typing-rate driven** | OS keyboard event hook | Fast → `working-typing` faster; stalled → `thinking` | macOS needs Input Monitoring permission |
| **CPU stress reaction** | `top`/`ps` poll | `error`/concerned variant | Needs throttling logic |
| **Multi-monitor follow** | cursor screen change | Existing `idle`, but with monitor migration logic |
| **Cross-user social** | shared Soul state via backend | Future; complex |

---

## Personality-per-pet idea

**Idea**: each cat is a personality. If user owns 小肥 (Munchkin) AND 胖猫 (Ragdoll), they pick one as "active" pet but the personalities differ:

| Pet | Personality | Reactions |
|---|---|---|
| 小肥 (Munchkin) | Work-energizer | Code editor focused → extra enthusiastic working; Claude session done → over-the-top happy |
| 胖猫 (Ragdoll) | Wellness-keeper | Long sit → strong nudge; late-night → strong yawn cycle; hydration reminders more frequent |

Wired by reading `theme.json`'s new `personality` field that maps lifecycle hooks to behavior modifiers. Theme authors can ship custom personalities.

---

## Wave 1 candidate (recommendation)

If we ship 3 things, they should compound:

1. **Pomodoro break with walk-across** — PawPal's signature, gives the pet "presence"
2. **Soul mood drives idle variant** — leverages already-running Soul engine; no new APIs; cat feels alive between hook events
3. **Active-app focus mode (macOS only)** — biggest user-experience unlock; Accessibility API is ~50 LOC

Cost: 1 new APNG (walk-across) per existing theme + state machine wire-up. ~half-day work, no new external services.

## Open questions

- **Permissions UX**: PawPal asks for Accessibility on first-run for focus detection. Do we want the same flow, or opt-in via Settings?
- **Theme compatibility**: New states (walk-across) need APNGs from each theme. Do older themes fall back to existing `notification` instead?
- **Soul ↔ state.js boundary**: Should mood directly drive state machine, or should it gate state-priority weights? (Latter is cleaner; former is simpler.)
- **Anti-annoyance**: PawPal lets user disable individual nudges. We need same controls + a "DND" that already exists — just expose it per-feature.

---

## Pickup notes (for resume)

- Read this doc + the `pet-forge` skill at `~/projects/AX-skills/pet-forge/` (now shipping the pipeline).
- Phase 4 live test of 小肥/胖猫 themes still on AX's gate at session pause.
- State machine entry point: [`src/state.js`](../../src/state.js) (ctx = main process IPC bridge).
- Soul engine HTTP: `127.0.0.1:23456` (mood, observe stream).
- Hook signal HTTP: `127.0.0.1:23334` (state events).
