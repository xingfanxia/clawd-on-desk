const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onboardingAPI", {
  getSoulConfig: () => ipcRenderer.invoke("soul-get-config"),
  updateSoulConfig: (data) => ipcRenderer.invoke("soul-update-config", data),
  testKey: (provider, credentials) => ipcRenderer.invoke("soul-test-key", provider, credentials),
  complete: (data) => ipcRenderer.send("onboarding-complete", data),
  skip: () => ipcRenderer.send("onboarding-skip"),
  getStrings: () => ipcRenderer.invoke("onboarding-strings"),
});
