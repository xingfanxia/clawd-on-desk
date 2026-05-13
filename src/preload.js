const { contextBridge, ipcRenderer } = require("electron");

// Parse theme config from additionalArguments (synchronous, available on first load)
const themeArg = process.argv.find(a => a.startsWith("--theme-config="));
const themeConfig = themeArg ? JSON.parse(themeArg.slice("--theme-config=".length)) : null;

contextBridge.exposeInMainWorld("themeConfig", themeConfig);

contextBridge.exposeInMainWorld("electronAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  onViewportOffset: (cb) => ipcRenderer.on("viewport-offset", (_, offsetY) => cb(offsetY)),
  // State sync from main
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, state, svg) => callback(state, svg)),
  onKimiPermissionPulse: (callback) => ipcRenderer.on("kimi-permission-pulse", () => callback()),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled, edge, options) => cb(enabled, edge, options)),
  onLowPowerIdleModeChange: (cb) => ipcRenderer.on("low-power-idle-mode-change", (_, enabled) => cb(enabled)),
  // Reaction control (from main, relayed from hit window)
  onStartDragReaction: (cb) => ipcRenderer.on("start-drag-reaction", () => cb()),
  onEndDragReaction: (cb) => ipcRenderer.on("end-drag-reaction", () => cb()),
  onPlayClickReaction: (cb) => ipcRenderer.on("play-click-reaction", (_, svg, duration) => cb(svg, duration)),
  // Sound playback (from main)
  onPlaySound: (cb) => ipcRenderer.on("play-sound", (_, payload) => cb(payload)),
  onInvalidateSoundCache: (cb) => ipcRenderer.on("invalidate-sound-cache", (_, url) => cb(url)),
  // PAWPAL-1 — behavior overlay layer (transient APNG above the state machine).
  // Main pushes a behavior with { behaviorId, file, duration }; renderer
  // displays the file for `duration` ms then auto-pops. Pop fires earlier on
  // explicit cancel.
  onPushBehavior: (cb) => ipcRenderer.on("push-behavior", (_, payload) => cb(payload)),
  onPopBehavior: (cb) => ipcRenderer.on("pop-behavior", (_, payload) => cb(payload)),
  // Render window → main (cursor polling control during reactions)
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),

  // PAWPAL-2 — OS-level permission gate (Accessibility / Input Monitoring).
  // Settings UI uses these to check + prompt the user for required macOS
  // permissions before enabling workspace-awareness detectors.
  osPermission: {
    check: (kind) => ipcRenderer.invoke("os-permission:check", kind),
    prompt: (kind) => ipcRenderer.invoke("os-permission:prompt", kind),
  },
});
