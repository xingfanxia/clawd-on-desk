const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pairingAPI", {
  pair: (host, port, code) => ipcRenderer.invoke("soul-pair", host, port, code),
  cancel: () => ipcRenderer.send("pairing-cancel"),
  enableLan: () => ipcRenderer.invoke("soul-enable-lan"),
  generateCode: () => ipcRenderer.invoke("soul-generate-pairing-code"),
  getStatus: () => ipcRenderer.invoke("soul-pair-status"),
});
