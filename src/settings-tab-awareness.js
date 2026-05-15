// settings-tab-awareness.js — Settings → Awareness panel (PAWPAL-1 + PAWPAL-2)
//
// Surfaces:
//   - Self-care nudge preset (quiet/normal/coach) + per-nudge override toggles
//   - Workspace Awareness section (PAWPAL-2 Task 10): master toggle, per-detector
//     toggles, OS permission status + grant flow, category-rules editor modal
//   - Soul-Driven Idle info row
//
// Modeled on settings-tab-general.js but builds custom row markup because
// helpers.buildSwitchRow only supports top-level prefs keys — `nudges.overrides
// [<id>].enabled` and `workspaceAwareness.<sub>.enabled` are nested.
//
// PAWPAL-2 design notes:
//   - Toggle state is INDEPENDENT of OS permission state. If a user enables a
//     detector and later revokes the permission in System Settings, the toggle
//     stays ON. The detector silently no-ops (its own enabled-gate checks
//     prefs.workspaceAwareness.<sub>.enabled AND the live permission state)
//     and resumes when the permission is re-granted.
//   - Master toggle off → sub-feature toggles are visually disabled but their
//     stored state is preserved. Flipping master back on restores them.
//   - Permission re-checks fire on tab focus (visibilitychange) so a user who
//     comes back from System Settings sees a fresh status without polling.
//   - Category rules write through the same single-key update path as nudges,
//     so the controller's per-key serialization holds.

"use strict";

(function initSettingsTabAwareness(root) {
  const NUDGE_TOGGLES = [
    { id: "pomodoroBreak",   labelKey: "rowPomodoroEnabled" },
    { id: "hydrate",         labelKey: "rowHydrateEnabled" },
    { id: "longSit",         labelKey: "rowLongSitEnabled" },
    { id: "lateNightYawn",   labelKey: "rowLateNightYawnEnabled" },
    // PAWPAL-2 workspace-driven nudges.
    { id: "socialHeadShake", labelKey: "rowSocialHeadShakeEnabled" },
    { id: "stuckOnProblem",  labelKey: "rowStuckOnProblemEnabled" },
    { id: "longWindowBreak", labelKey: "rowLongWindowBreakEnabled" },
  ];

  const PRESETS = ["quiet", "normal", "coach"];

  // Mirrors PRESET_CONFIG[<preset>][<nudge>].enabled in src/nudges.js. Kept
  // tiny + duplicated here on purpose: the awareness tab is a renderer-process
  // surface and the full PRESET_CONFIG isn't exposed via preload. Used only
  // to surface the "won't fire under current preset" hint below disabled
  // toggles (the actual gating happens in nudges.js#shouldFire).
  const PRESET_ENABLES = {
    quiet: {
      pomodoroBreak: true, hydrate: false, longSit: false, lateNightYawn: false,
      socialHeadShake: false, stuckOnProblem: false, longWindowBreak: true,
    },
    normal: {
      pomodoroBreak: true, hydrate: true, longSit: true, lateNightYawn: true,
      socialHeadShake: true, stuckOnProblem: true, longWindowBreak: true,
    },
    coach: {
      pomodoroBreak: true, hydrate: true, longSit: true, lateNightYawn: true,
      socialHeadShake: true, stuckOnProblem: true, longWindowBreak: true,
    },
  };

  // PAWPAL-2: keep duplicate copies of these constants in sync with prefs.js
  // (WORKSPACE_CATEGORIES) and pure helpers. The renderer can't reach prefs.js
  // through node module resolution (it's a browser-script surface), so the
  // lists are mirrored. Tests assert both sides match.
  const WORKSPACE_CATEGORIES = ["code", "docs", "social", "chat", "video", "creative"];

  // Long-window break threshold dropdown options (ms). v1 ships 3 fixed options.
  const LONG_WINDOW_THRESHOLDS = [
    { ms: 3600000,  labelKey: "optWorkspaceThreshold60"  },
    { ms: 5400000,  labelKey: "optWorkspaceThreshold90"  },
    { ms: 7200000,  labelKey: "optWorkspaceThreshold120" },
  ];

  // Default category rules (mirrors defaultActiveAppCategoryRules in prefs.js).
  // Used to seed an empty editor + Reset-to-defaults button.
  //
  // KEEP IN SYNC with src/prefs.js#defaultActiveAppCategoryRules — main and
  // renderer processes can't share modules, so the table is duplicated.
  // test/prefs-pawpal2.test.js + test/settings-tab-awareness-workspace.test.js
  // both assert these match. PAWPAL-2.1's rule-engine pass should collapse
  // these by letting the renderer pull defaults from prefs via IPC.
  function defaultCategoryRules() {
    return {
      "Code": "code",
      "Visual Studio Code": "code",
      "Cursor": "code",
      "Terminal": "code",
      "Notion": "docs",
      "Obsidian": "docs",
      "Slack": "chat",
      "Discord": "chat",
      "Messages": "chat",
      "Twitter": "social",
      "X": "social",
      "Reddit": "social",
      "Instagram": "social",
      "TikTok": "social",
      "Facebook": "social",
      "YouTube": "video",
      "Netflix": "video",
      "Figma": "creative",
    };
  }

  let state = null;
  let helpers = null;
  let core = null;
  // Live permission cache (renderer-side). Synced from main via
  // settingsAPI.osPermission.check() on tab open + visibilitychange.
  // States: "unknown" (initial / probe in flight), "granted", "denied",
  // "unavailable" (non-mac platforms).
  let permissionState = {
    accessibility: "unknown",
    inputMonitoring: "unknown",
  };
  // Per-kind in-flight flag for the prompt() IPC. `os-permission:prompt` opens
  // System Settings then waits up to PROMPT_REPOLL_DELAY_MS (~30s) for a
  // foreground signal before re-probing — without surfacing that wait in the
  // UI, the "Grant access" button just appears unresponsive. The render code
  // reads this to show a disabled "Waiting…" spinner state until the IPC
  // resolves (state flips back via permissionState[kind] = res.state).
  let isPromptingPermission = {
    accessibility: false,
    inputMonitoring: false,
  };
  // Last-known granted state per kind, used to disambiguate "denied" (never
  // granted) from "revoked" (was granted, then revoked in System Settings).
  // Persisted in localStorage so a re-open of Settings still distinguishes
  // the two. Plain { kind: bool }.
  //
  // NOTE: clawd-on-desk enforces a single Settings window (via SettingsWindow
  // controller), so cross-window localStorage sync is not needed. If that
  // invariant changes, add a `window.addEventListener("storage", reload)` here.
  const WAS_GRANTED_STORAGE_KEY = "clawd.settings.awareness.wasGranted.v1";
  let wasGranted = loadWasGranted();
  // Modal state (category rules editor). null when closed.
  let categoryRulesModal = null;
  // Re-register guard — body self-gates on state.activeTab so the listener is
  // safe to register once per Settings-window lifetime. Matches sibling-tab
  // "register-once, never clean up" pattern (cf. settings-tab-general.js).
  let visibilityListener = null;

  function t(key) { return helpers.t(key); }

  function isMac() {
    return !!(core && core.i18n && core.i18n.IS_MAC);
  }

  function loadWasGranted() {
    try {
      const raw = localStorage.getItem(WAS_GRANTED_STORAGE_KEY);
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          accessibility: parsed.accessibility === true,
          inputMonitoring: parsed.inputMonitoring === true,
        };
      }
    } catch (err) {
      console.warn(
        `[awareness] could not load wasGranted from localStorage: ${(err && err.message) || err}`
      );
    }
    return { accessibility: false, inputMonitoring: false };
  }

  function saveWasGranted() {
    try {
      localStorage.setItem(WAS_GRANTED_STORAGE_KEY, JSON.stringify(wasGranted));
    } catch (err) {
      console.warn(
        `[awareness] could not persist wasGranted to localStorage: ${(err && err.message) || err}`
      );
    }
  }

  function clearChildren(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function readNudges() {
    const snap = (state && state.snapshot) || {};
    const n = snap.nudges || { preset: "normal", overrides: {}, lastFiredAt: {} };
    return {
      preset: PRESETS.includes(n.preset) ? n.preset : "normal",
      overrides: (n.overrides && typeof n.overrides === "object") ? n.overrides : {},
      lastFiredAt: (n.lastFiredAt && typeof n.lastFiredAt === "object") ? n.lastFiredAt : {},
    };
  }

  function writeNudges(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
    window.settingsAPI.update("nudges", next);
  }

  function setPreset(preset) {
    const cur = readNudges();
    if (cur.preset === preset) return;
    writeNudges({ ...cur, preset });
  }

  function setNudgeOverrideEnabled(nudgeId, enabled) {
    const cur = readNudges();
    const prev = (cur.overrides && cur.overrides[nudgeId]) || {};
    const overrides = { ...cur.overrides, [nudgeId]: { ...prev, enabled } };
    writeNudges({ ...cur, overrides });
  }

  function isNudgeEnabled(nudgeId) {
    const cur = readNudges();
    const ov = cur.overrides && cur.overrides[nudgeId];
    if (ov && typeof ov.enabled === "boolean") return ov.enabled;
    return true; // default: enabled (preset-config-driven; override only forces off)
  }

  function isSuppressedByPreset(nudgeId) {
    const preset = readNudges().preset;
    const map = PRESET_ENABLES[preset] || PRESET_ENABLES.normal;
    return map[nudgeId] === false;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Workspace Awareness — readers + writers
  // ─────────────────────────────────────────────────────────────────────

  function readWorkspaceAwareness() {
    const snap = (state && state.snapshot) || {};
    const wa = snap.workspaceAwareness;
    // Defensive defaults if the snapshot hasn't loaded the block yet.
    if (!wa || typeof wa !== "object") {
      return {
        enabled: false,
        activeApp: { enabled: false, categoryRules: defaultCategoryRules() },
        systemMonitor: {
          enabled: false,
          typingPauseThresholdMs: 30000,
          cpuStressThresholdPct: 70,
          cpuStressDurationMs: 120000,
        },
        longWindow: { enabled: false, sameWindowThresholdMs: 5400000 },
      };
    }
    return wa;
  }

  function writeWorkspaceAwareness(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
    window.settingsAPI.update("workspaceAwareness", next);
  }

  function setMasterEnabled(enabled) {
    const cur = readWorkspaceAwareness();
    writeWorkspaceAwareness({ ...cur, enabled });
  }

  function setSubFeatureEnabled(subKey, enabled) {
    const cur = readWorkspaceAwareness();
    const prev = cur[subKey] || {};
    writeWorkspaceAwareness({ ...cur, [subKey]: { ...prev, enabled } });
  }

  function setLongWindowThreshold(ms) {
    const cur = readWorkspaceAwareness();
    const prev = cur.longWindow || {};
    writeWorkspaceAwareness({
      ...cur,
      longWindow: { ...prev, sameWindowThresholdMs: ms },
    });
  }

  function setCategoryRules(rules) {
    const cur = readWorkspaceAwareness();
    const prev = cur.activeApp || {};
    writeWorkspaceAwareness({
      ...cur,
      activeApp: { ...prev, categoryRules: rules },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Permission status — visual mapping + re-check
  // ─────────────────────────────────────────────────────────────────────

  // Map a kind's live state + wasGranted history → i18n label key.
  // Pure function — exported on globalThis for unit testing.
  function permissionLabelKey(kind, liveState, history, onMac) {
    if (!onMac) return "labelPermissionUnavailable";
    if (liveState === "granted") return "labelPermissionGranted";
    if (liveState === "denied") {
      return history && history[kind] ? "labelPermissionRevoked" : "labelPermissionDenied";
    }
    if (liveState === "unavailable") return "labelPermissionUnavailable";
    // unknown / anything else
    return "labelPermissionUnknown";
  }

  async function refreshPermission(kind) {
    if (!window.settingsAPI || !window.settingsAPI.osPermission) return;
    try {
      const res = await window.settingsAPI.osPermission.check(kind);
      if (res && res.status === "ok" && typeof res.state === "string") {
        permissionState[kind] = res.state;
        if (res.state === "granted") {
          if (!wasGranted[kind]) {
            wasGranted[kind] = true;
            saveWasGranted();
          }
        }
        // Re-render the awareness tab if currently visible.
        if (state.activeTab === "awareness" && core && core.ops) {
          core.ops.requestRender({ content: true });
        }
      }
    } catch (err) {
      console.warn("[awareness] permission check failed:", (err && err.message) || err);
    }
  }

  async function promptPermission(kind) {
    if (!window.settingsAPI || !window.settingsAPI.osPermission) return;
    // Guard re-entry — repeated clicks on a button that's already opened
    // System Settings would queue duplicate prompt() calls and produce
    // confusing repoll cascades. The render-side disabled state mirrors
    // this guard so the user sees the disabled button while it's truthy.
    if (isPromptingPermission[kind]) return;
    isPromptingPermission[kind] = true;
    if (state.activeTab === "awareness" && core && core.ops) {
      core.ops.requestRender({ content: true });
    }
    try {
      const res = await window.settingsAPI.osPermission.prompt(kind);
      if (res && res.status === "ok" && typeof res.state === "string") {
        permissionState[kind] = res.state;
        if (res.state === "granted") {
          wasGranted[kind] = true;
          saveWasGranted();
        }
      }
    } catch (err) {
      console.warn("[awareness] permission prompt failed:", (err && err.message) || err);
    } finally {
      isPromptingPermission[kind] = false;
      if (state.activeTab === "awareness" && core && core.ops) {
        core.ops.requestRender({ content: true });
      }
    }
  }

  async function openSystemSettings(kind) {
    if (!window.settingsAPI || !window.settingsAPI.osPermission) return;
    try {
      await window.settingsAPI.osPermission.openSystemSettings(kind);
    } catch (err) {
      console.warn("[awareness] openSystemSettings failed:", (err && err.message) || err);
    }
  }

  function attachVisibilityListener() {
    if (visibilityListener) return;
    visibilityListener = () => {
      if (document.visibilityState === "visible" && state.activeTab === "awareness") {
        refreshPermission("accessibility");
        refreshPermission("inputMonitoring");
      }
    };
    document.addEventListener("visibilitychange", visibilityListener);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Pure helpers (testable)
  // ─────────────────────────────────────────────────────────────────────

  // Validate & parse a category-rules JSON string. Returns one of:
  //   { ok: true, value: { ... } }
  //   { ok: false, code: "invalid-json", message: "..." }
  //   { ok: false, code: "not-object" }
  //   { ok: false, code: "invalid-category", offendingKey: "<substring>",
  //                                          offendingValue: "<bad-category>" }
  function parseCategoryRulesText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, code: "invalid-json", message: (err && err.message) || String(err) };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "not-object" };
    }
    // Verify every value is in WORKSPACE_CATEGORIES.
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      if (typeof v !== "string" || !WORKSPACE_CATEGORIES.includes(v)) {
        return {
          ok: false,
          code: "invalid-category",
          offendingKey: k,
          offendingValue: v,
        };
      }
    }
    return { ok: true, value: parsed };
  }

  // Validate threshold ms. v1 only allows the three preset values; reject
  // anything outside (defends against arbitrary writes from the UI surface).
  function isValidLongWindowThreshold(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return false;
    return LONG_WINDOW_THRESHOLDS.some((opt) => opt.ms === ms);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Nudges section (PAWPAL-1) — preserved verbatim
  // ─────────────────────────────────────────────────────────────────────

  function buildPresetRow() {
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowNudgePreset");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowNudgePresetDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const segmented = document.createElement("div");
    segmented.className = "segmented-control";
    segmented.style.display = "inline-flex";
    segmented.style.gap = "4px";

    for (const p of PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "soft-btn";
      btn.textContent = t(`labelPreset${p[0].toUpperCase()}${p.slice(1)}`);
      btn.title = t(`descPreset${p[0].toUpperCase()}${p.slice(1)}`);
      btn.dataset.preset = p;
      if (readNudges().preset === p) btn.classList.add("accent");
      btn.addEventListener("click", () => setPreset(p));
      segmented.appendChild(btn);
    }
    control.appendChild(segmented);
    row.appendChild(control);

    // Active preset description below the row, full-width.
    const descBlock = document.createElement("div");
    descBlock.className = "row-desc";
    descBlock.style.marginTop = "4px";
    descBlock.style.gridColumn = "1 / -1";
    descBlock.dataset.role = "preset-active-desc";
    descBlock.textContent = t(`descPreset${capitalize(readNudges().preset)}`);
    row.appendChild(descBlock);

    return row;
  }

  function capitalize(s) {
    if (!s) return "";
    return s[0].toUpperCase() + s.slice(1);
  }

  function buildNudgeToggleRow({ id, labelKey }) {
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);

    // Surface preset-driven suppression so users don't wonder why a "on"
    // toggle never fires. The actual gating lives in nudges.js#shouldFire.
    if (isSuppressedByPreset(id)) {
      const hint = document.createElement("span");
      hint.className = "row-desc";
      hint.style.opacity = "0.7";
      hint.textContent = t("nudgeSuppressedByPreset");
      text.appendChild(hint);
    }

    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.tabIndex = 0;
    if (isNudgeEnabled(id)) sw.classList.add("on");
    sw.setAttribute("aria-checked", isNudgeEnabled(id) ? "true" : "false");
    sw.dataset.nudgeId = id;

    const toggle = () => {
      const next = !isNudgeEnabled(id);
      setNudgeOverrideEnabled(id, next);
      sw.classList.toggle("on", next);
      sw.setAttribute("aria-checked", next ? "true" : "false");
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggle();
      }
    });
    control.appendChild(sw);
    row.appendChild(control);

    return row;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Workspace Awareness section (PAWPAL-2 Task 10)
  // ─────────────────────────────────────────────────────────────────────

  // Permission status row. `kind` is "accessibility" or "inputMonitoring".
  // Shows the live status + a contextual button (Grant access / Open System
  // Settings / nothing for granted/unavailable).
  function buildPermissionStatusRow(kind, labelTextKey) {
    const row = document.createElement("div");
    row.className = "row row-sub";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelTextKey);
    text.appendChild(label);

    const status = document.createElement("span");
    status.className = "row-desc";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const liveState = permissionState[kind];
    const labelKey = permissionLabelKey(kind, liveState, wasGranted, isMac());
    status.textContent = t(labelKey);
    text.appendChild(status);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";

    if (isMac() && liveState !== "granted" && liveState !== "unavailable") {
      const isRevoked = liveState === "denied" && wasGranted[kind];
      const inFlight = !!isPromptingPermission[kind];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "soft-btn accent";
      // Three states: idle "Grant access" / idle "Open System Settings"
      // (revoked) / in-flight "Waiting for grant…". The prompt IPC can block
      // up to PROMPT_REPOLL_DELAY_MS (~30s) waiting for the user to flip the
      // toggle and refocus the app — without this state the button just
      // appears dead. aria-busy lets AT signal the in-flight nature.
      if (inFlight) {
        btn.textContent = t("btnGrantAccessWaiting");
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
      } else {
        btn.textContent = isRevoked ? t("btnOpenSystemSettings") : t("btnGrantAccess");
        btn.addEventListener("click", () => {
          if (isRevoked) {
            openSystemSettings(kind);
          } else {
            promptPermission(kind);
          }
        });
      }
      control.appendChild(btn);
    }
    row.appendChild(control);
    return row;
  }

  // Master toggle row. Top of the section, drives the visual-disabled state
  // of the sub-feature toggles below.
  function buildMasterToggleRow() {
    const wa = readWorkspaceAwareness();
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowWorkspaceMasterToggle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowWorkspaceMasterToggleDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.tabIndex = 0;
    if (wa.enabled) sw.classList.add("on");
    sw.setAttribute("aria-checked", wa.enabled ? "true" : "false");

    const toggle = () => {
      const next = !wa.enabled;
      setMasterEnabled(next);
      sw.classList.toggle("on", next);
      sw.setAttribute("aria-checked", next ? "true" : "false");
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggle();
      }
    });
    control.appendChild(sw);
    row.appendChild(control);

    return row;
  }

  // Sub-feature toggle row (activeApp / systemMonitor / longWindow). Greyed
  // out when master is off, but the underlying stored state is preserved.
  function buildWorkspaceToggleRow(subKey, labelKey, descKey, masterEnabled) {
    const wa = readWorkspaceAwareness();
    const sub = wa[subKey] || {};
    const enabled = !!sub.enabled;

    const row = document.createElement("div");
    row.className = "row row-sub";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t(descKey);
    text.appendChild(desc);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.tabIndex = masterEnabled ? 0 : -1;
    if (enabled) sw.classList.add("on");
    sw.setAttribute("aria-checked", enabled ? "true" : "false");

    if (!masterEnabled) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
    } else {
      const toggle = () => {
        const next = !enabled;
        setSubFeatureEnabled(subKey, next);
        sw.classList.toggle("on", next);
        sw.setAttribute("aria-checked", next ? "true" : "false");
      };
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggle();
        }
      });
    }
    control.appendChild(sw);
    row.appendChild(control);
    return row;
  }

  // Threshold dropdown for long-window-break.
  function buildLongWindowThresholdRow(masterEnabled) {
    const wa = readWorkspaceAwareness();
    const lw = wa.longWindow || {};
    const enabled = !!lw.enabled;
    const currentMs = isValidLongWindowThreshold(lw.sameWindowThresholdMs)
      ? lw.sameWindowThresholdMs
      : 5400000; // default = 90 min, matches prefs.js

    const row = document.createElement("div");
    row.className = "row row-sub";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowWorkspaceLongWindowThreshold");
    text.appendChild(label);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowWorkspaceLongWindowThresholdDesc");
    text.appendChild(desc);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const select = document.createElement("select");
    select.className = "soft-btn";
    const interactive = masterEnabled && enabled;
    if (!interactive) {
      select.disabled = true;
      select.setAttribute("aria-disabled", "true");
    }
    for (const opt of LONG_WINDOW_THRESHOLDS) {
      const option = document.createElement("option");
      option.value = String(opt.ms);
      option.textContent = t(opt.labelKey);
      if (opt.ms === currentMs) option.selected = true;
      select.appendChild(option);
    }
    if (interactive) {
      select.addEventListener("change", (e) => {
        const next = Number(e.target.value);
        if (isValidLongWindowThreshold(next)) setLongWindowThreshold(next);
      });
    }
    control.appendChild(select);
    row.appendChild(control);
    return row;
  }

  // Category rules editor button row.
  function buildCategoryRulesButtonRow(masterEnabled) {
    const wa = readWorkspaceAwareness();
    const activeAppEnabled = !!(wa.activeApp && wa.activeApp.enabled);

    const row = document.createElement("div");
    row.className = "row row-sub";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("labelCategoryRulesTitle");
    text.appendChild(label);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("labelCategoryRulesHint");
    text.appendChild(desc);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = t("btnEditCategoryRules");
    const interactive = masterEnabled && activeAppEnabled;
    if (!interactive) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => openCategoryRulesModal());
    }
    control.appendChild(btn);
    row.appendChild(control);
    return row;
  }

  function buildWorkspaceSection() {
    const wa = readWorkspaceAwareness();
    const masterEnabled = !!wa.enabled;
    const rows = [];

    // Section description (full-width info row).
    const descRow = document.createElement("div");
    descRow.className = "row";
    descRow.style.gridTemplateColumns = "1fr";
    const descText = document.createElement("div");
    descText.className = "row-text";
    const descSpan = document.createElement("span");
    descSpan.className = "row-desc";
    descSpan.textContent = t("sectionWorkspaceAwarenessDesc");
    descText.appendChild(descSpan);
    descRow.appendChild(descText);
    rows.push(descRow);

    // Accessibility permission status row (always visible).
    rows.push(buildPermissionStatusRow("accessibility", "labelAccessibilityPermission"));

    // Master toggle.
    rows.push(buildMasterToggleRow());

    // Active app reactions.
    rows.push(buildWorkspaceToggleRow(
      "activeApp",
      "rowWorkspaceActiveApp",
      "rowWorkspaceActiveAppDesc",
      masterEnabled,
    ));

    // Category rules editor button (only meaningful when activeApp is on).
    rows.push(buildCategoryRulesButtonRow(masterEnabled));

    // System monitor — requires Input Monitoring permission (separate row).
    rows.push(buildPermissionStatusRow("inputMonitoring", "labelInputMonitoringPermission"));
    rows.push(buildWorkspaceToggleRow(
      "systemMonitor",
      "rowWorkspaceSystemMonitor",
      "rowWorkspaceSystemMonitorDesc",
      masterEnabled,
    ));

    // Long-window break toggle + threshold dropdown.
    rows.push(buildWorkspaceToggleRow(
      "longWindow",
      "rowWorkspaceLongWindow",
      "rowWorkspaceLongWindowDesc",
      masterEnabled,
    ));
    rows.push(buildLongWindowThresholdRow(masterEnabled));

    return helpers.buildSection(t("sectionWorkspaceAwareness"), rows);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Category rules editor modal (PAWPAL-2 Task 10)
  // ─────────────────────────────────────────────────────────────────────

  function openCategoryRulesModal() {
    const wa = readWorkspaceAwareness();
    const rules = (wa.activeApp && wa.activeApp.categoryRules) || {};
    const seedText = Object.keys(rules).length === 0
      ? "{}"
      : JSON.stringify(rules, null, 2);
    categoryRulesModal = { text: seedText, error: null };
    mountCategoryRulesModal();
  }

  function closeCategoryRulesModal() {
    categoryRulesModal = null;
    const rootEl = document.getElementById("modalRoot");
    clearChildren(rootEl);
  }

  function mountCategoryRulesModal() {
    const rootEl = document.getElementById("modalRoot");
    if (!rootEl) return;
    const isEmpty = isJsonEmptyObject(categoryRulesModal.text);
    const error = categoryRulesModal.error;

    clearChildren(rootEl);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "doctor-modal";
    modal.style.maxWidth = "560px";
    modal.style.width = "min(560px, 100%)";

    const header = document.createElement("div");
    header.className = "doctor-modal-header";
    const titleWrap = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = t("labelCategoryRulesTitle");
    titleWrap.appendChild(h2);
    const hint = document.createElement("div");
    hint.className = "row-desc";
    hint.textContent = t("labelCategoryRulesHint");
    titleWrap.appendChild(hint);
    header.appendChild(titleWrap);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "doctor-close";
    closeBtn.textContent = "x";
    closeBtn.setAttribute("aria-label", t("btnCancel"));
    closeBtn.addEventListener("click", closeCategoryRulesModal);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const textarea = document.createElement("textarea");
    textarea.value = categoryRulesModal.text;
    textarea.style.width = "100%";
    textarea.style.minHeight = "240px";
    textarea.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
    textarea.style.fontSize = "12px";
    textarea.style.padding = "10px";
    textarea.style.boxSizing = "border-box";
    textarea.style.border = "1px solid var(--border)";
    textarea.style.borderRadius = "8px";
    textarea.style.background = "var(--bg)";
    textarea.style.color = "var(--text-primary)";
    textarea.style.resize = "vertical";
    textarea.spellcheck = false;
    if (error) textarea.style.borderBottomColor = "#c75151";
    textarea.addEventListener("input", () => {
      categoryRulesModal.text = textarea.value;
      // Re-validate on every change so the error/empty hints update live.
      const parsed = parseCategoryRulesText(textarea.value);
      categoryRulesModal.error = parsed.ok ? null : parsed;
      // Lightweight in-place: update error region + Save disabled state.
      updateModalErrorRegion();
      updateModalSaveDisabled();
    });
    modal.appendChild(textarea);

    // Error / empty status region.
    const errorRegion = document.createElement("div");
    errorRegion.dataset.role = "modal-error-region";
    errorRegion.style.minHeight = "20px";
    errorRegion.style.fontSize = "12px";
    modal.appendChild(errorRegion);

    // Empty-state hint + defaults reference + Reset button.
    if (isEmpty) {
      const emptyHint = document.createElement("div");
      emptyHint.className = "row-desc";
      emptyHint.textContent = t("labelCategoryRulesEmpty");
      modal.appendChild(emptyHint);

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = t("labelCategoryRulesDefaults");
      summary.style.cursor = "pointer";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      pre.style.fontSize = "11px";
      pre.style.maxHeight = "200px";
      pre.style.overflow = "auto";
      pre.style.padding = "8px";
      pre.style.border = "1px solid var(--border)";
      pre.style.borderRadius = "6px";
      pre.textContent = JSON.stringify(defaultCategoryRules(), null, 2);
      details.appendChild(pre);
      modal.appendChild(details);
    }

    // Actions row.
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "12px";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "soft-btn";
    resetBtn.textContent = t("btnResetToDefaults");
    resetBtn.addEventListener("click", () => {
      categoryRulesModal.text = JSON.stringify(defaultCategoryRules(), null, 2);
      categoryRulesModal.error = null;
      mountCategoryRulesModal();
    });
    actions.appendChild(resetBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "soft-btn";
    cancelBtn.textContent = t("btnCancel");
    cancelBtn.addEventListener("click", closeCategoryRulesModal);
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = t("btnSave");
    saveBtn.dataset.role = "modal-save";
    saveBtn.addEventListener("click", () => {
      const parsed = parseCategoryRulesText(categoryRulesModal.text);
      if (!parsed.ok) {
        // In-place error surfacing — DON'T remount. mountCategoryRulesModal
        // rebuilds the entire modal DOM, which steals focus from the
        // textarea and resets the cursor position. The live-input handler
        // and the dedicated updaters already cover this surface; reuse them
        // so the user can fix the typo without losing their place.
        categoryRulesModal.error = parsed;
        updateModalErrorRegion();
        updateModalSaveDisabled();
        return;
      }
      setCategoryRules(parsed.value);
      closeCategoryRulesModal();
    });
    actions.appendChild(saveBtn);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    rootEl.appendChild(backdrop);

    // Click outside closes.
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeCategoryRulesModal();
    });
    modal.addEventListener("click", (e) => e.stopPropagation());

    // Initialize error region + save-disabled to reflect seed text.
    updateModalErrorRegion();
    updateModalSaveDisabled();
  }

  function isJsonEmptyObject(text) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.keys(parsed).length === 0;
    } catch (_) {
      return false;
    }
  }

  function updateModalErrorRegion() {
    const region = document.querySelector('[data-role="modal-error-region"]');
    if (!region) return;
    region.textContent = "";
    if (!categoryRulesModal || !categoryRulesModal.error) return;
    const err = categoryRulesModal.error;
    let msg = "";
    if (err.code === "invalid-json") {
      msg = t("errInvalidJson").replace("{message}", err.message || "");
    } else if (err.code === "not-object") {
      msg = t("errInvalidJson").replace("{message}", "expected object");
    } else if (err.code === "invalid-category") {
      msg = t("errInvalidCategory")
        .replace("{category}", String(err.offendingValue))
        .replace("{validList}", WORKSPACE_CATEGORIES.join(", "));
    }
    region.style.color = "#c75151";
    region.textContent = msg;
  }

  function updateModalSaveDisabled() {
    const saveBtn = document.querySelector('[data-role="modal-save"]');
    if (!saveBtn) return;
    const hasError = !!(categoryRulesModal && categoryRulesModal.error);
    saveBtn.disabled = hasError;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Soul-driven idle info row (PAWPAL-1) — preserved
  // ─────────────────────────────────────────────────────────────────────

  function buildSoulIdleRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.style.gridTemplateColumns = "1fr"; // info-only, no control column
    const text = document.createElement("div");
    text.className = "row-text";
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("descSoulIdle");
    text.appendChild(desc);
    row.appendChild(text);
    return row;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Top-level render
  // ─────────────────────────────────────────────────────────────────────

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("sidebarAwareness");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("descPresetNormal");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("sectionSelfCareNudges"), [
      buildPresetRow(),
      ...NUDGE_TOGGLES.map(buildNudgeToggleRow),
    ]));

    // PAWPAL-2 Task 10: workspace awareness goes BELOW self-care nudges and
    // ABOVE soul-driven idle (per plan UI/UX section).
    parent.appendChild(buildWorkspaceSection());

    parent.appendChild(helpers.buildSection(t("sectionSoulIdle"), [
      buildSoulIdleRow(),
    ]));

    // Kick off permission refresh on first render. Detached promises so render
    // returns synchronously; refreshPermission() will request a re-render
    // when the live state lands.
    attachVisibilityListener();
    if (isMac()) {
      refreshPermission("accessibility");
      refreshPermission("inputMonitoring");
    } else {
      // Non-mac: hardcode "unavailable" so permissionLabelKey routes to
      // labelPermissionUnavailable without a probe.
      permissionState = { accessibility: "unavailable", inputMonitoring: "unavailable" };
    }
  }

  function init(c) {
    core = c;
    state = c.state;
    helpers = c.helpers;
    c.tabs.awareness = { render };
  }

  root.ClawdSettingsTabAwareness = {
    init,
    // PAWPAL-2 Task 10: pure helpers exposed for unit testing.
    __test: {
      parseCategoryRulesText,
      isValidLongWindowThreshold,
      permissionLabelKey,
      defaultCategoryRules,
      WORKSPACE_CATEGORIES,
      LONG_WINDOW_THRESHOLDS,
      PRESET_ENABLES,
    },
  };
})(globalThis);
