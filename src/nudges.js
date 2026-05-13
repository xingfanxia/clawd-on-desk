// src/nudges.js — Self-care nudge scheduler (PAWPAL-1 + PAWPAL-2)
//
// Responsibilities:
//   - Fire scheduled nudges (Pomodoro break, hydration) on cron-style intervals
//   - Fire detector-based nudges (long-sit) when conditions are met
//   - Fire schedule-based nudges (late-night yawn) at configured hour
//   - PAWPAL-2: Fire workspace-driven nudges (socialHeadShake, stuckOnProblem,
//     longWindowBreak) when detector subscriptions emit events. The OS
//     introspection itself lives in workspace-detector / system-monitor /
//     long-window-tracker — nudges.js just subscribes via
//     ctx.subscribeWorkspace and routes the event through the same shouldFire
//     + fireNudge plumbing as the health nudges.
//   - Honor the user's preset (quiet/normal/coach) + per-nudge overrides
//   - Honor DND — never fire when DND is active (invariant #3)
//   - Push behavior overlay (walkAcross or fallback) via ctx.pushBehavior
//   - At coach preset: also fire native macOS notification + sound
//
// NOT responsible for:
//   - Visual rendering (state.js + renderer.js handle that)
//   - Soul mood (separate routing layer in state.js — workspace nudges add
//     signal sources but do NOT change mood / idle variant routing /
//     override Soul — invariant #2)
//   - OS introspection itself (workspace-detector / system-monitor /
//     long-window-tracker own the polling + debouncing — nudges.js only
//     consumes their callbacks)
//   - Anti-fatigue backoff (deferred to v2 per spec Q3 — observe first)

"use strict";

// NOTE: when adding a new preset or nudge here, also update PRESET_ENABLES
// in src/settings-tab-awareness.js — it mirrors the `enabled` axis of this
// table so the Awareness tab can surface a "suppressed by preset" hint in
// the renderer process (which can't require this main-process module).
const PRESET_CONFIG = {
  quiet: {
    pomodoroBreak: { enabled: true, intervalMin: 50 },
    hydrate:       { enabled: false },
    longSit:       { enabled: false },
    lateNightYawn: { enabled: false },
    // PAWPAL-2 workspace nudges. quiet preset only allows the longWindowBreak
    // (the gentlest of the three — fires once per ~90min same-window, with a
    // 30min global cooldown). socialHeadShake + stuckOnProblem are disabled
    // here because they're cued on workflow-tempo signals (app switching,
    // typing/CPU stall) which a quiet user has already opted out of.
    socialHeadShake: { enabled: false },
    stuckOnProblem:  { enabled: false },
    longWindowBreak: { enabled: true },
  },
  normal: {
    pomodoroBreak: { enabled: true, intervalMin: 25 },
    hydrate:       { enabled: true, intervalMin: 90 },
    longSit:       { enabled: true, thresholdMin: 30 },
    lateNightYawn: { enabled: true, fromHour: 23 },
    socialHeadShake: { enabled: true },
    stuckOnProblem:  { enabled: true },
    longWindowBreak: { enabled: true },
  },
  coach: {
    pomodoroBreak: { enabled: true, intervalMin: 25 },
    hydrate:       { enabled: true, intervalMin: 60 },
    longSit:       { enabled: true, thresholdMin: 20 },
    lateNightYawn: { enabled: true, fromHour: 22, fromMinute: 30 },
    // "Firmer reaction at coach" is a soul/aggression cue (Task 8) — the
    // preset schema here just enables/disables. coach gets all three.
    socialHeadShake: { enabled: true },
    stuckOnProblem:  { enabled: true },
    longWindowBreak: { enabled: true },
  },
};

// `behavior` names the overlay id pushed via ctx.pushBehavior(). The runtime
// resolves it through theme.behaviors — themes without the asset fall back
// (e.g. legacy themes resolve walkAcross → notification state via fallbackTo).
//
// `soundName` uses the logical sound name from theme.json's `sounds` map
// (resolved via themeLoader.getSoundUrl in main.js's playSound). Only
// `complete` and `confirm` ship in built-in themes today; `confirm` is the
// gentler ack tone and fits the "soft self-care" feel across all three
// nudge categories. Late-night yawn intentionally has no sound — the
// visual yawn animation is the whole point.
const NUDGE_DEFINITIONS = {
  pomodoroBreak: {
    type: "cron",
    behavior: "walkAcross",
    titleKey: "nudgePomodoroTitle",
    bodyKey: "nudgePomodoroBody",
    soundName: "confirm",
  },
  hydrate: {
    type: "cron",
    behavior: "attention",
    titleKey: "nudgeHydrateTitle",
    bodyKey: "nudgeHydrateBody",
    soundName: "confirm",
  },
  longSit: {
    type: "detector",
    behavior: "walkAcross",
    titleKey: "nudgeLongSitTitle",
    bodyKey: "nudgeLongSitBody",
    soundName: "confirm",
  },
  lateNightYawn: {
    type: "schedule",
    behavior: "yawning",
    titleKey: "nudgeLateNightTitle",
    bodyKey: "nudgeLateNightBody",
    soundName: null,
  },
  // PAWPAL-2 workspace-driven nudges. `type: "workspace"` is a NEW type —
  // these don't poll on a timer, they subscribe via ctx.subscribeWorkspace
  // to the detector callback identified by `source`. When the detector fires
  // an event the nudge passes through shouldFire (DND + preset + override
  // gate) and fireNudge (which records lastFiredAt + pushes the behavior
  // overlay + at coach also fires native notification + sound).
  //
  // socialHeadShake is the only nudge with a `trigger` gate — it fires only
  // when the workspace-detector reports an app whose category matches
  // `trigger.onCategory`. The other two fire unconditionally on their
  // detector event (the detectors themselves already encode the relevant
  // gates: stuck-on-problem fires only when typing pause + CPU sustained
  // co-occur; long-window fires only after the duration threshold passes).
  socialHeadShake: {
    type: "workspace",
    source: "workspace.appChange",
    trigger: { onCategory: "social" },
    // headShake is a new behavior id (Task 11 will wire fallbackTo: "error"
    // for themes that lack it). Visual-only — no sound — because shaking
    // its head IS the message; an audible ping on top would over-cue what's
    // meant to be a soft "hey, social again?" nudge.
    behavior: "headShake",
    titleKey: "nudgeSocialHeadShakeTitle",
    bodyKey: "nudgeSocialHeadShakeBody",
    soundName: null,
  },
  stuckOnProblem: {
    type: "workspace",
    source: "system.stuckOnProblem",
    // Reuse existing "thinking" overlay rather than introducing a new state.
    // The semantic fit is good: typing-pause + CPU-sustained == "user is
    // stuck thinking" — the pet doing its thinking pose mirrors that.
    behavior: "thinking",
    titleKey: "nudgeStuckOnProblemTitle",
    bodyKey: "nudgeStuckOnProblemBody",
    soundName: "confirm",
  },
  longWindowBreak: {
    type: "workspace",
    source: "longWindow.fire",
    // walkAcross is the existing "physically draw attention" overlay — fits
    // the "you've been on this window way too long, take a break" intent.
    behavior: "walkAcross",
    titleKey: "nudgeLongWindowBreakTitle",
    bodyKey: "nudgeLongWindowBreakBody",
    soundName: "confirm",
  },
};

const DETECTOR_POLL_MS = 30_000; // 30s — responsive enough, light on CPU

module.exports = function initNudges(ctx) {
  // ctx contract:
  //   getPrefs()                 → snapshot
  //   setPrefs(patch)            → void (persists, fires onPrefsChanged)
  //   isDndEnabled()             → boolean
  //   pushBehavior(id, durMs)    → void
  //   showNativeNotification({ title, body }) → void
  //   playSound(file)            → void (existing IPC: send 'play-sound')
  //   getMouseStillSinceMs()     → ms epoch (provided by tick.js)
  //   t(key, params?)            → string (i18n)
  //
  //   PAWPAL-2 additions:
  //   subscribeWorkspace(channel, callback) → unsubscribe fn
  //     channels:
  //       "workspace.appChange"     — emits { name, category, sinceMs } from
  //                                   workspace-detector on confirmed app change
  //       "system.stuckOnProblem"   — emits { at, cpuPressurePct, ... } from
  //                                   system-monitor when typing-pause + CPU
  //                                   sustained co-occur (with cooldown)
  //       "longWindow.fire"         — emits { app, durationMs } from
  //                                   long-window-tracker when same-window
  //                                   duration crosses threshold (with cooldown)
  //     Unknown channels MUST return a no-op unsubscribe (and log a warning).

  const cronTimers = new Map();             // nudgeId → setInterval handle
  let detectorTimer = null;                 // single setInterval for detector + schedule nudges
  const workspaceUnsubscribes = new Map();  // nudgeId → unsubscribe fn from ctx.subscribeWorkspace

  function presetConfig() {
    const prefs = ctx.getPrefs();
    const preset = prefs && prefs.nudges && prefs.nudges.preset;
    return PRESET_CONFIG[preset] || PRESET_CONFIG.normal;
  }

  function effectiveConfig(nudgeId) {
    const prefs = ctx.getPrefs();
    const fromPreset = (presetConfig()[nudgeId]) || {};
    const fromOverride = (prefs && prefs.nudges && prefs.nudges.overrides && prefs.nudges.overrides[nudgeId]) || {};
    return { ...fromPreset, ...fromOverride };
  }

  function shouldFire(nudgeId) {
    if (ctx.isDndEnabled()) return false;
    const cfg = effectiveConfig(nudgeId);
    return cfg.enabled !== false;
  }

  function recordFire(nudgeId, now) {
    const prefs = ctx.getPrefs();
    const nudges = (prefs && prefs.nudges) || { preset: "normal", overrides: {}, lastFiredAt: {} };
    ctx.setPrefs({
      nudges: {
        ...nudges,
        lastFiredAt: { ...(nudges.lastFiredAt || {}), [nudgeId]: now },
      },
    });
  }

  function fireNudge(nudgeId) {
    const def = NUDGE_DEFINITIONS[nudgeId];
    if (!def) return;
    if (!shouldFire(nudgeId)) return;

    const cfg = effectiveConfig(nudgeId);
    const now = Date.now();
    recordFire(nudgeId, now);

    // Visual overlay (always fires across all presets — DND already gated)
    const durationMs = (def.behavior === "walkAcross") ? 3000 : 5000;
    ctx.pushBehavior(def.behavior, durationMs);

    // Coach preset only: native notification + sound. Confirmed in spec Q2.
    const preset = (ctx.getPrefs() && ctx.getPrefs().nudges && ctx.getPrefs().nudges.preset) || "normal";
    if (preset === "coach") {
      const params = {};
      if (nudgeId === "pomodoroBreak") params.minutes = cfg.intervalMin;
      ctx.showNativeNotification({
        title: ctx.t(def.titleKey),
        body: ctx.t(def.bodyKey, params),
      });
      if (def.soundName && typeof ctx.playSound === "function") {
        ctx.playSound(def.soundName);
      }
    }
  }

  function startCronNudge(nudgeId) {
    const cfg = effectiveConfig(nudgeId);
    const intervalMin = cfg.intervalMin;
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) return;
    const ms = intervalMin * 60_000;
    const handle = setInterval(() => fireNudge(nudgeId), ms);
    cronTimers.set(nudgeId, handle);
  }

  function startDetectors() {
    if (detectorTimer) return;
    detectorTimer = setInterval(() => {
      // longSit detector — fires when mouse has been still for thresholdMin
      // and we haven't fired within the last threshold window.
      if (shouldFire("longSit")) {
        const cfg = effectiveConfig("longSit");
        const thresholdMs = (cfg.thresholdMin || 30) * 60_000;
        const stillSince = typeof ctx.getMouseStillSinceMs === "function"
          ? ctx.getMouseStillSinceMs()
          : Date.now();
        const stillFor = Date.now() - stillSince;
        const lastFired = ((ctx.getPrefs() || {}).nudges || {}).lastFiredAt || {};
        const recentlyFired = (Date.now() - (lastFired.longSit || 0)) < thresholdMs;
        if (stillFor >= thresholdMs && !recentlyFired) {
          fireNudge("longSit");
        }
      }
      // lateNightYawn — fires once per evening once the configured time has
      // rolled over for today. 6h cooldown ensures one yawn per night even
      // if the user keeps the app running through midnight.
      if (shouldFire("lateNightYawn")) {
        const cfg = effectiveConfig("lateNightYawn");
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const fromMin = (cfg.fromHour || 23) * 60 + (cfg.fromMinute || 0);
        if (nowMin >= fromMin) {
          const lastFired = ((ctx.getPrefs() || {}).nudges || {}).lastFiredAt || {};
          const sixHoursAgo = Date.now() - 6 * 60 * 60_000;
          if ((lastFired.lateNightYawn || 0) < sixHoursAgo) {
            fireNudge("lateNightYawn");
          }
        }
      }
    }, DETECTOR_POLL_MS);
  }

  // PAWPAL-2: subscribe to detector callbacks for workspace-typed nudges.
  // We subscribe to ALL channels referenced by NUDGE_DEFINITIONS even when
  // the current preset disables some of them — shouldFire() re-checks DND /
  // preset / override at fire time, so toggles take effect without a
  // resubscribe cycle. The detectors themselves are instantiated once at
  // app boot regardless of prefs (they silent-gate internally on
  // workspaceAwareness.enabled etc.), so a single subscribe at
  // _nudges.start() survives all subsequent pref toggles without nudges-side
  // awareness.
  function startWorkspaceNudges() {
    if (typeof ctx.subscribeWorkspace !== "function") return;
    // for...of with `const id` creates a fresh per-iteration binding — the
    // closure below captures `id` correctly for each nudge. No additional
    // re-aliasing is needed.
    for (const id of Object.keys(NUDGE_DEFINITIONS)) {
      const def = NUDGE_DEFINITIONS[id];
      if (def.type !== "workspace") continue;
      const trigger = def.trigger || null;
      const unsubscribe = ctx.subscribeWorkspace(def.source, (event) => {
        // Trigger gate (currently only socialHeadShake uses this). If a
        // future nudge ships a different trigger shape, extend here — we
        // intentionally keep it small to fail loudly on schema drift.
        if (trigger && typeof trigger.onCategory === "string") {
          const cat = event && event.category;
          if (cat !== trigger.onCategory) return;
        }
        // DND + preset + override all live in shouldFire — re-evaluated at
        // fire time. fireNudge itself short-circuits on shouldFire too, but
        // keeping the early-return here avoids unnecessary call frames for
        // the very-common "preset disables this nudge" case.
        if (!shouldFire(id)) return;
        // Detectors wrap their listener callbacks in try/catch, but they
        // attribute errors at the detector layer — losing nudgeId context.
        // Wrap fireNudge here so a thrown fireNudge surfaces WHICH nudge
        // misbehaved, in the nudges module's own log channel.
        try {
          fireNudge(id);
        } catch (err) {
          if (typeof ctx.log === "function") {
            ctx.log("error", `nudges: workspace nudge "${id}" fireNudge threw`, err);
          }
        }
      });
      if (typeof unsubscribe === "function") {
        workspaceUnsubscribes.set(id, unsubscribe);
      }
    }
  }

  function start() {
    stop(); // idempotent
    for (const id of Object.keys(NUDGE_DEFINITIONS)) {
      const def = NUDGE_DEFINITIONS[id];
      if (def.type === "cron" && shouldFire(id)) {
        startCronNudge(id);
      }
    }
    startDetectors();
    startWorkspaceNudges();
  }

  function stop() {
    for (const handle of cronTimers.values()) clearInterval(handle);
    cronTimers.clear();
    if (detectorTimer) {
      clearInterval(detectorTimer);
      detectorTimer = null;
    }
    // PAWPAL-2: clear workspace subscriptions. Each unsubscribe is wrapped
    // in try/catch — a misbehaving detector shouldn't prevent a clean stop()
    // of the remaining channels (matches the defensive pattern in
    // long-window-tracker.stop()).
    for (const unsubscribe of workspaceUnsubscribes.values()) {
      try { unsubscribe(); } catch (_err) { /* ignore */ }
    }
    workspaceUnsubscribes.clear();
  }

  function reload() {
    // Called when prefs change (preset switched, override toggled, DND flipped)
    start();
  }

  return {
    start,
    stop,
    reload,
    // Test hooks — not part of the public contract, but exposed so unit tests
    // can drive the scheduler without spinning real timers.
    _fireNudgeForTesting: fireNudge,
    _startWorkspaceNudgesForTesting: startWorkspaceNudges,
    _workspaceUnsubscribesForTesting: workspaceUnsubscribes,
    _PRESET_CONFIG: PRESET_CONFIG,
    _NUDGE_DEFINITIONS: NUDGE_DEFINITIONS,
  };
};
