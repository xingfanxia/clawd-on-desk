// soul/speech-bubble.js — Speech bubble window management
//
// Creates and manages a transparent BrowserWindow positioned above the pet
// for showing AI commentary. Uses the same pattern as permission.js bubbles.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const LINUX_WINDOW_TYPE = "toolbar";

const BUBBLE_WIDTH = 280;
const BUBBLE_DEFAULT_HEIGHT = 80;
const BUBBLE_MARGIN_ABOVE_PET = 8; // px gap between bubble tail and pet top

module.exports = function initSpeechBubble(ctx) {
  let bubble = null;
  let measuredHeight = BUBBLE_DEFAULT_HEIGHT;
  let hideTimer = null;
  let isVisible = false;

  function createBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    const petBounds = ctx.win.getBounds();
    const pos = computePosition(petBounds, measuredHeight);

    bubble = new BrowserWindow({
      width: pos.width,
      height: pos.height,
      x: pos.x,
      y: pos.y,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-speech.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    bubble.setIgnoreMouseEvents(true);

    // macOS: visible on all spaces
    if (isMac) {
      bubble.setAlwaysOnTop(true, "pop-up-menu");
      try {
        bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {}
    }

    bubble.loadFile(path.join(__dirname, "speech-bubble.html"));

    bubble.on("closed", () => { bubble = null; isVisible = false; });

    return bubble;
  }

  function computePosition(petBounds, bubbleH) {
    // Position bubble above the pet, horizontally centered
    const x = Math.round(petBounds.x + (petBounds.width - BUBBLE_WIDTH) / 2);
    const y = Math.round(petBounds.y - bubbleH - BUBBLE_MARGIN_ABOVE_PET);

    // Clamp to work area
    const wa = ctx.getNearestWorkArea(
      petBounds.x + petBounds.width / 2,
      petBounds.y + petBounds.height / 2,
    );

    return {
      x: Math.max(wa.x, Math.min(x, wa.x + wa.width - BUBBLE_WIDTH)),
      y: Math.max(wa.y, y),
      width: BUBBLE_WIDTH,
      height: bubbleH,
    };
  }

  /**
   * Show a speech bubble with commentary text.
   * @param {string} text - Commentary text
   * @param {number} duration - Auto-hide after ms (0 = manual hide)
   */
  function show(text, duration = 8000) {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    if (ctx.petHidden) return;

    const bub = createBubble();
    if (!bub || bub.isDestroyed()) return;

    // Clear any pending hide
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    // Position and show
    const petBounds = ctx.win.getBounds();
    const pos = computePosition(petBounds, measuredHeight);
    bub.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: pos.height });

    bub.showInactive();
    isVisible = true;

    // Send text to renderer
    bub.webContents.send("speech-show", { text, duration });

    // Auto-hide
    if (duration > 0) {
      hideTimer = setTimeout(() => hide(), duration);
    }
  }

  /** Show typing indicator (while waiting for AI response) */
  function showTyping() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    if (ctx.petHidden) return;

    const bub = createBubble();
    if (!bub || bub.isDestroyed()) return;

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    const petBounds = ctx.win.getBounds();
    const pos = computePosition(petBounds, 60); // typing dots are small
    bub.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: 60 });

    bub.showInactive();
    isVisible = true;

    bub.webContents.send("speech-show", { typing: true, duration: 0 });
  }

  /** Hide the speech bubble */
  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!bubble || bubble.isDestroyed()) { isVisible = false; return; }

    bubble.webContents.send("speech-hide");
    isVisible = false;

    // Hide window after fade-out animation
    setTimeout(() => {
      if (bubble && !bubble.isDestroyed()) {
        bubble.hide();
      }
    }, 350);
  }

  /** Reposition bubble to follow pet */
  function reposition() {
    if (!bubble || bubble.isDestroyed() || !isVisible) return;
    if (!ctx.win || ctx.win.isDestroyed()) return;

    const petBounds = ctx.win.getBounds();
    const pos = computePosition(petBounds, measuredHeight);
    bubble.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: pos.height });
  }

  /** Clean up */
  function cleanup() {
    hide();
    if (bubble && !bubble.isDestroyed()) {
      bubble.destroy();
      bubble = null;
    }
  }

  // Listen for height reports from the bubble renderer
  ipcMain.on("speech-height", (event, h) => {
    if (bubble && !bubble.isDestroyed() && event.sender === bubble.webContents) {
      measuredHeight = Math.max(40, Math.min(h, 300));
      reposition();
    }
  });

  return {
    show,
    showTyping,
    hide,
    reposition,
    cleanup,
    get isVisible() { return isVisible; },
    get bubble() { return bubble; },
  };
};
