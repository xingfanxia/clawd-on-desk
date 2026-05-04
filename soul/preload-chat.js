const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  send: (message) => ipcRenderer.invoke("soul-chat-send", message),
  onReply: (cb) => ipcRenderer.on("soul-chat-reply", (_, data) => cb(data)),
  onTyping: (cb) => ipcRenderer.on("soul-chat-typing", () => cb()),
  getHistory: () => ipcRenderer.invoke("soul-chat-history"),
  getContext: () => ipcRenderer.invoke("soul-chat-context"),
});
