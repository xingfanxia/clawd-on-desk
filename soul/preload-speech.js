const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speechAPI", {
  onShow: (cb) => ipcRenderer.on("speech-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("speech-hide", () => cb()),
  reportHeight: (h) => ipcRenderer.send("speech-height", h),
  openChat: () => ipcRenderer.send("speech-open-chat"),
});
