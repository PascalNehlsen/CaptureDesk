const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setupAPI", {
  getState: () => ipcRenderer.invoke("setup-get-state"),
  saveAppId: (appId) => ipcRenderer.invoke("setup-save-app-id", appId),
  openDeveloperPortal: () => ipcRenderer.send("setup-open-developer-portal"),
  cancel: () => ipcRenderer.send("setup-cancel"),
});
