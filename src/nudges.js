// src/nudges.js — Self-care nudge scheduler (PAWPAL-1)
//
// Responsibilities:
//   - Fire scheduled nudges (Pomodoro break, hydration) on cron-style intervals
//   - Fire detector-based nudges (long-sit) when conditions are met
//   - Fire schedule-based nudges (late-night yawn) at configured hour
//   - Honor the user's preset (quiet/normal/coach) + per-nudge overrides
//   - Honor DND — never fire when DND is active
//   - Push behavior overlay (walkAcross or fallback) via ctx.pushBehavior
//   - At coach preset: also fire native macOS notification + sound
//
// NOT responsible for:
//   - Visual rendering (state.js + renderer.js handle that)
//   - Soul mood (separate routing layer in state.js — see Task 8)
//   - OS introspection (PAWPAL-2 territory — focus mode etc.)
//   - Anti-fatigue backoff (deferred to v2 per spec Q3 — observe first)

"use strict";

const PRESET_CONFIG = {
  quiet: {
    pomodoroBreak: { enabled: true, intervalMin: 50 },
    hydrate:       { enabled: false },
    longSit:       { enabled: false },
    lateNightYawn: { enabled: false },
  },
  normal: {
    pomodoroBreak: { enabled: true, intervalMin: 25 },
    hydrate:       { enabled: true, intervalMin: 90 },
    longSit:       { enabled: true, thresholdMin: 30 },
    lateNightYawn: { enabled: true, fromHour: 23 },
  },
  coach: {
    pomodoroBreak: { enabled: true, intervalMin: 25 },
    hydrate:       { enabled: true, intervalMin: 60 },
    longSit:       { enabled: true, thresholdMin: 20 },
    lateNightYawn: { enabled: true, fromHour: 22, fromMinute: 30 },
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
};

const DETECTOR_POLL_MS = 30_000; // 30s — responsive enough, light on CPU

module.exports = function initNudges(ctx) {
  // ctx contract:
  //   getPrefs()                 → snapshot
  //   setPrefs(patch)            → void (persists, fires onPrefsChanged)
  //   isDndEnabled()             → boolean
  //   pushBehavior(id, durMs)    → void   (Task 7 wires this)
  //   showNativeNotification({ title, body }) → void (Task 6 wires this)
  //   playSound(file)            → void (existing IPC: send 'play-sound')
  //   getMouseStillSinceMs()     → ms epoch (provided by tick.js)
  //   t(key, params?)            → string (i18n)

  const cronTimers = new Map();   // nudgeId → setInterval handle
  let detectorTimer = null;       // single setInterval for detector + schedule nudges

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

  function start() {
    stop(); // idempotent
    for (const id of Object.keys(NUDGE_DEFINITIONS)) {
      const def = NUDGE_DEFINITIONS[id];
      if (def.type === "cron" && shouldFire(id)) {
        startCronNudge(id);
      }
    }
    startDetectors();
  }

  function stop() {
    for (const handle of cronTimers.values()) clearInterval(handle);
    cronTimers.clear();
    if (detectorTimer) {
      clearInterval(detectorTimer);
      detectorTimer = null;
    }
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
    _PRESET_CONFIG: PRESET_CONFIG,
    _NUDGE_DEFINITIONS: NUDGE_DEFINITIONS,
  };
};
