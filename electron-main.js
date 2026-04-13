let electronMain;

try {
  electronMain = require("electron/main");
} catch {
  electronMain = require("electron");
}

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = electronMain;
const path = require("path");
const { start } = require("./src/server/index.js");

const LOOM_PARTITION = "persist:loom";
let sessionConfigured = false;
let mainWindow = null;
let cameraWindow = null;
let controlsWindow = null;
let drawOverlayWindow = null;
let mainWindowBounds = null;
let drawingActive = false;
const CONTROLS_WIDTH_NORMAL = 380;
const CONTROLS_WIDTH_DRAWING = 920;

function isLoomUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return (
      hostname === "loom.com" ||
      hostname === "www.loom.com" ||
      hostname.endsWith(".loom.com") ||
      hostname === "loomlocal.com" ||
      hostname.endsWith(".loomlocal.com")
    );
  } catch {
    return false;
  }
}

function relaxFrameAncestorsDirective(values) {
  const cspValues = Array.isArray(values) ? values : [String(values)];
  return cspValues.map((value) =>
    value
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) =>
        directive.toLowerCase().startsWith("frame-ancestors")
          ? "frame-ancestors *"
          : directive,
      )
      .join("; "),
  );
}

function createPopupWindowOptions() {
  return {
    width: 520,
    height: 760,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: LOOM_PARTITION,
      sandbox: true,
    },
  };
}

function createWindowOpenHandler() {
  return ({ url }) => {
    if (!/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => {
        console.error("Failed to open external URL:", error);
      });
      return { action: "deny" };
    }

    return {
      action: "allow",
      overrideBrowserWindowOptions: createPopupWindowOptions(),
    };
  };
}

function configureLoomSession(browserSession) {
  if (sessionConfigured) {
    return;
  }

  sessionConfigured = true;

  // Remove "Electron/x.x.x" from user agent so loom.com serves the browser recorder experience.
  const ua = browserSession.getUserAgent().replace(/\s*Electron\/[\d.]+/, "");
  browserSession.setUserAgent(ua);

  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["media", "screen", "display-capture", "mediaKeySystem"];
    callback(allowed.includes(permission));
  });

  browserSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ["media", "screen", "display-capture", "mediaKeySystem"];
    return allowed.includes(permission);
  });

  if (typeof browserSession.setDisplayMediaRequestHandler === "function") {
    browserSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            thumbnailSize: { width: 0, height: 0 },
            types: ["screen"],
          });
          const selectedSource = sources[0];

          if (!selectedSource) {
            console.error("No display source available for Loom recording.");
            callback({});
            return;
          }

          callback({
            audio: false,
            video: selectedSource,
          });
        } catch (error) {
          console.error("Failed to provide a display source for Loom recording:", error);
          callback({});
        }
      },
      { useSystemPicker: true },
    );
  }

  // Only relax embed headers for Loom-owned pages that the SDK needs to load.
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isLoomUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const headers = { ...details.responseHeaders };
    delete headers["x-frame-options"];
    delete headers["X-Frame-Options"];
    if (headers["content-security-policy"]) {
      headers["content-security-policy"] = relaxFrameAncestorsDirective(headers["content-security-policy"]);
    }
    if (headers["Content-Security-Policy"]) {
      headers["Content-Security-Policy"] = relaxFrameAncestorsDirective(headers["Content-Security-Policy"]);
    }
    callback({ responseHeaders: headers });
  });
}

function createWindow() {
  const loomSession = session.fromPartition(LOOM_PARTITION);
  configureLoomSession(loomSession);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      partition: LOOM_PARTITION,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(createWindowOpenHandler());
  mainWindow.setContentProtection(true);

  mainWindow.loadURL("http://localhost:8080");
  mainWindow.on("closed", () => {
    mainWindow = null;
    closeCameraWindow();
    closeControlsWindow();
    closeDrawOverlayWindow();
  });
}

function createCameraWindow() {
  if (cameraWindow && !cameraWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { height } = primaryDisplay.workAreaSize;

  cameraWindow = new BrowserWindow({
    width: 200,
    height: 200,
    x: 20,
    y: height - 220,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: LOOM_PARTITION,
    },
  });

  cameraWindow.setContentProtection(true);
  cameraWindow.setVisibleOnAllWorkspaces(true);
  cameraWindow.loadFile(path.join(__dirname, "src", "views", "camera.html"));
  cameraWindow.on("closed", () => {
    cameraWindow = null;
  });
}

function createControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  const controlsWidth = CONTROLS_WIDTH_NORMAL;

  controlsWindow = new BrowserWindow({
    width: controlsWidth,
    height: 60,
    x: Math.round((width - controlsWidth) / 2),
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  controlsWindow.setContentProtection(true);
  controlsWindow.setVisibleOnAllWorkspaces(true);
  controlsWindow.setAlwaysOnTop(true, "screen-saver");
  controlsWindow.loadFile(path.join(__dirname, "src", "views", "controls.html"));
  controlsWindow.on("closed", () => {
    controlsWindow = null;
    // If user manually closes controls, restore main window
    closeCameraWindow();
    closeDrawOverlayWindow();
    drawingActive = false;
    restoreMainWindow();
  });
}

function raiseOverlayUiWindows() {
  if (cameraWindow && !cameraWindow.isDestroyed() && typeof cameraWindow.moveTop === "function") {
    cameraWindow.moveTop();
  }
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.setAlwaysOnTop(true, "screen-saver");
    if (typeof controlsWindow.moveTop === "function") {
      controlsWindow.moveTop();
    }
  }
}

function createDrawOverlayWindow() {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  drawOverlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // NO content protection — drawings must appear in the recording.
  // Explicitly disable mouse-event-ignoring so X11/Linux delivers all
  // mouse events to this window (transparent windows need this call).
  drawOverlayWindow.setIgnoreMouseEvents(false);
  drawOverlayWindow.setVisibleOnAllWorkspaces(true);
  drawOverlayWindow.setAlwaysOnTop(true, "status");
  drawOverlayWindow.loadFile(path.join(__dirname, "src", "views", "draw-overlay.html"));
  drawOverlayWindow.webContents.on("did-finish-load", () => {
    raiseOverlayUiWindows();
  });

  drawOverlayWindow.on("closed", () => {
    drawOverlayWindow = null;
    drawingActive = false;
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.webContents.send("draw-state-changed", false);
    }
  });
}

function closeCameraWindow() {
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.close();
  }
  cameraWindow = null;
}

function closeControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    // Remove the close listener to avoid recursive restore
    controlsWindow.removeAllListeners("closed");
    controlsWindow.close();
  }
  controlsWindow = null;
}

function closeDrawOverlayWindow() {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.removeAllListeners("closed");
    drawOverlayWindow.close();
  }
  drawOverlayWindow = null;
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (mainWindowBounds) {
    mainWindow.setBounds(mainWindowBounds);
    mainWindowBounds = null;
  }
}

function registerRecordingShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("stop-recording");
    }
  });
  globalShortcut.register("CommandOrControl+Shift+D", () => {
    toggleDrawOverlay();
  });
}

function unregisterRecordingShortcuts() {
  globalShortcut.unregisterAll();
}

function resizeControlsWindow(width) {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  const bounds = controlsWindow.getBounds();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW } = primaryDisplay.workAreaSize;
  controlsWindow.setBounds({
    x: Math.round((screenW - width) / 2),
    y: bounds.y,
    width,
    height: bounds.height,
  });
  raiseOverlayUiWindows();
}

function toggleDrawOverlay() {
  drawingActive = !drawingActive;
  if (drawingActive) {
    createDrawOverlayWindow();
    resizeControlsWindow(CONTROLS_WIDTH_DRAWING);
  } else {
    closeDrawOverlayWindow();
    resizeControlsWindow(CONTROLS_WIDTH_NORMAL);
  }
  raiseOverlayUiWindows();
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send("draw-state-changed", drawingActive);
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on("recording-started", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindowBounds = mainWindow.getBounds();
  mainWindow.minimize();
  createCameraWindow();
  createControlsWindow();
  registerRecordingShortcuts();
});

ipcMain.on("recording-stopped", () => {
  unregisterRecordingShortcuts();
  closeCameraWindow();
  closeControlsWindow();
  closeDrawOverlayWindow();
  drawingActive = false;
  restoreMainWindow();
});

ipcMain.on("request-stop-recording", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("stop-recording");
  }
});

ipcMain.on("request-toggle-draw", () => {
  toggleDrawOverlay();
});

ipcMain.on("clear-draw", () => {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.webContents.send("clear-draw");
  }
});

ipcMain.on("undo-draw", () => {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.webContents.send("undo-draw");
  }
});

ipcMain.on("raise-overlay-ui", () => {
  raiseOverlayUiWindows();
});

// Forward drawing tool settings from controls window to draw overlay
ipcMain.on("draw-tool-changed", (_, tool) => {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.webContents.send("draw-tool-changed", tool);
  }
});

ipcMain.on("draw-color-changed", (_, color) => {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.webContents.send("draw-color-changed", color);
  }
});

ipcMain.on("draw-size-changed", (_, size) => {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    drawOverlayWindow.webContents.send("draw-size-changed", size);
  }
});

// Handle window.open() calls from within Loom SDK iframes
app.on("web-contents-created", (_, contents) => {
  contents.setWindowOpenHandler((details) => {
    console.log("[sub-frame window.open]", details.url);
    return createWindowOpenHandler()(details);
  });

  // Forward errors from Loom SDK iframes to terminal
  contents.on("console-message", (_, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[iframe ${level === 2 ? "warn" : "error"}]`, message, sourceId ? `(${sourceId}:${line})` : "");
    }
  });
});

app.whenReady().then(() => {
  start(() => {
    createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
