const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("diaryAPI", {
  getEntries: (limit) => ipcRenderer.invoke("soul-diary-list", limit),
  getEntry: (date) => ipcRenderer.invoke("soul-diary-get", date),
  generate: () => ipcRenderer.invoke("soul-diary-generate"),
  getStrings: () => ipcRenderer.invoke("diary-strings"),
});
