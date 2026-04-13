// soul/chat-window.js — Chat window management
//
// Small floating chat window that opens when:
// 1. User clicks the speech bubble
// 2. User clicks the pet (double-click)
// 3. Right-click menu → "Chat with Clawd"
//
// Pre-populated with the pet's last observation comment as context.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

module.exports = function initChatWindow(ctx) {
  let chatWin = null;
  let _lastCommentary = ""; // last observation comment (shown when opening)

  function open() {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.show();
      chatWin.focus();
      return;
    }

    // Position near the pet
    const petBounds = ctx.win ? ctx.win.getBounds() : { x: 200, y: 200 };
    const wa = ctx.getNearestWorkArea(
      petBounds.x + petBounds.width / 2,
      petBounds.y + petBounds.height / 2,
    );

    // Place to the left of the pet, or right if no room
    let x = petBounds.x - 320 - 16;
    if (x < wa.x) x = petBounds.x + petBounds.width + 16;
    let y = Math.max(wa.y, petBounds.y + petBounds.height - 460);

    chatWin = new BrowserWindow({
      width: 320,
      height: 460,
      x, y,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      minimizable: true,
      skipTaskbar: false,
      alwaysOnTop: true,
      minWidth: 280,
      minHeight: 300,
      title: "Chat with Clawd",
      backgroundColor: "#f5f5f5",
      webPreferences: {
        preload: path.join(__dirname, "preload-chat.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    chatWin.loadFile(path.join(__dirname, "chat-window.html"));
    chatWin.once("ready-to-show", () => {
      chatWin.show();
      chatWin.focus();
    });
    chatWin.on("closed", () => { chatWin = null; });
  }

  function close() {
    if (chatWin && !chatWin.isDestroyed()) chatWin.close();
  }

  function setLastCommentary(text) {
    _lastCommentary = text;
  }

  /** Send a pet message to the chat window (proactive/observation) */
  function pushMessage(text) {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send("soul-chat-reply", { text });
    }
  }

  // IPC handlers
  ipcMain.handle("soul-chat-send", async (_e, message) => {
    if (!ctx.soul || !ctx.soul.healthy) {
      return { ok: false, error: "Soul not connected" };
    }
    return ctx.soul.chat(message);
  });

  ipcMain.handle("soul-chat-context", () => {
    return { lastCommentary: _lastCommentary };
  });

  ipcMain.handle("soul-chat-history", () => {
    // Could return stored history in future
    return { messages: [] };
  });

  return {
    open,
    close,
    setLastCommentary,
    pushMessage,
    get isOpen() { return chatWin && !chatWin.isDestroyed() && chatWin.isVisible(); },
  };
};
