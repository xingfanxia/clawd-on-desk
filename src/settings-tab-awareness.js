// settings-tab-awareness.js — Settings → Awareness panel (PAWPAL-1)
//
// Surfaces the self-care nudge preset (quiet/normal/coach) and per-nudge
// override toggles. Modeled on settings-tab-general.js but builds custom
// row markup for the preset selector and per-nudge toggles since
// helpers.buildSwitchRow only supports top-level prefs keys, not nested
// `nudges.overrides[<id>].enabled` paths.

"use strict";

(function initSettingsTabAwareness(root) {
  const NUDGE_TOGGLES = [
    { id: "pomodoroBreak",  labelKey: "rowPomodoroEnabled" },
    { id: "hydrate",        labelKey: "rowHydrateEnabled" },
    { id: "longSit",        labelKey: "rowLongSitEnabled" },
    { id: "lateNightYawn",  labelKey: "rowLateNightYawnEnabled" },
  ];

  const PRESETS = ["quiet", "normal", "coach"];

  let state = null;
  let helpers = null;

  function t(key) { return helpers.t(key); }

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
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.tabIndex = 0;
    if (isNudgeEnabled(id)) sw.classList.add("on");
    sw.dataset.nudgeId = id;

    const toggle = () => {
      const next = !isNudgeEnabled(id);
      setNudgeOverrideEnabled(id, next);
      sw.classList.toggle("on", next);
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

    parent.appendChild(helpers.buildSection(t("sectionSoulIdle"), [
      buildSoulIdleRow(),
    ]));
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    core.tabs.awareness = { render };
  }

  root.ClawdSettingsTabAwareness = { init };
})(globalThis);
