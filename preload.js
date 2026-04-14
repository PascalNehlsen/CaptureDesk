const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls (frameless title bar)
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),

  // Recording lifecycle
  sendRecordingStarted: () => ipcRenderer.send("recording-started"),
  sendRecordingStopped: () => ipcRenderer.send("recording-stopped"),
  requestStopRecording: () => ipcRenderer.send("request-stop-recording"),
  onStopRecording: (callback) => ipcRenderer.on("stop-recording", () => callback()),
  requestPauseRecording: () => ipcRenderer.send("request-pause-recording"),
  onPauseRecording: (callback) => ipcRenderer.on("pause-recording", () => callback()),
  sendRecordingPauseState: (isPaused) => ipcRenderer.send("recording-pause-state-changed", isPaused),
  onRecordingPauseStateChanged: (callback) => ipcRenderer.on("recording-pause-state-changed", (_, isPaused) => callback(isPaused)),

  // Drawing overlay — lifecycle
  requestToggleDraw: () => ipcRenderer.send("request-toggle-draw"),
  onDrawStateChanged: (callback) => ipcRenderer.on("draw-state-changed", (_, active) => callback(active)),
  sendClearDraw: () => ipcRenderer.send("clear-draw"),
  onClearDraw: (callback) => ipcRenderer.on("clear-draw", () => callback()),
  sendUndoDraw: () => ipcRenderer.send("undo-draw"),
  onUndoDraw: (callback) => ipcRenderer.on("undo-draw", () => callback()),

  // Drawing overlay — tool settings (controls → overlay via main)
  sendDrawTool: (tool) => ipcRenderer.send("draw-tool-changed", tool),
  onDrawTool: (callback) => ipcRenderer.on("draw-tool-changed", (_, tool) => callback(tool)),
  sendDrawColor: (color) => ipcRenderer.send("draw-color-changed", color),
  onDrawColor: (callback) => ipcRenderer.on("draw-color-changed", (_, color) => callback(color)),
  sendDrawSize: (size) => ipcRenderer.send("draw-size-changed", size),
  onDrawSize: (callback) => ipcRenderer.on("draw-size-changed", (_, size) => callback(size)),
  requestRaiseOverlayUi: () => ipcRenderer.send("raise-overlay-ui"),
  getUiDisplays: () => ipcRenderer.invoke("get-ui-displays"),
  getPreferredUiDisplay: () => ipcRenderer.invoke("get-preferred-ui-display"),
  setPreferredUiDisplay: (displayId) => ipcRenderer.invoke("set-preferred-ui-display", displayId),
});
