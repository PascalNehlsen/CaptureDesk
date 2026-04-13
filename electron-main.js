let electronMain;

try {
  electronMain = require("electron/main");
} catch {
  electronMain = require("electron");
}

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = electronMain;
const path = require("path");
const { start, PORT } = require("./src/server/index.js");

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
      .map((directive) => {
        const [directiveName] = directive.split(/\s+/, 1);
        return directiveName.toLowerCase() === "frame-ancestors"
          ? "frame-ancestors *"
          : directive;
      })
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

function normalizeDisplayId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Native-resolution upscale for display capture
// ---------------------------------------------------------------------------
// Electron's desktopCapturer often downscales the display capture (e.g.
// 1920×1200 → 1728×1080) while preserving the aspect ratio. Loom's player
// then shows pillarbox bars because the video is narrower than expected.
// The Chrome Extension captures at native resolution and Loom handles it
// fine — no bars, no crop needed.
//
// Fix: intercept getDisplayMedia and upscale every frame back to the native
// display resolution via Insertable Streams + OffscreenCanvas. No content
// is cropped or distorted — we simply undo Electron's downscale.
//
// Injection: CDP Page.addScriptToEvaluateOnNewDocument runs the script BEFORE
// any page scripts in every frame (including cross-origin Loom SDK iframes),
// preventing the SDK from caching the original getDisplayMedia reference.
// ---------------------------------------------------------------------------

let _captureOverrideScript;

function getCaptureOverrideScript() {
  if (_captureOverrideScript !== undefined) return _captureOverrideScript;

  const { width: nativeW, height: nativeH } = screen.getPrimaryDisplay().size;

  console.log(`[CaptureDesk] Display is ${nativeW}x${nativeH} — will upscale capture to native resolution`);

  // ES5-compatible: runs in sandboxed cross-origin iframes
  _captureOverrideScript = `(function() {
    if (window.__capturedeskApplied) return;
    window.__capturedeskApplied = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return;

    var NATIVE_W = ${nativeW};
    var NATIVE_H = ${nativeH};

    console.warn('[CaptureDesk] Override installed in: ' + location.href.substring(0, 120));

    var _origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getDisplayMedia = function() {
      console.warn('[CaptureDesk] getDisplayMedia intercepted');

      return _origGDM.apply(navigator.mediaDevices, arguments).then(function(stream) {
        var track = (stream.getVideoTracks() || [])[0];
        if (!track) return stream;

        if (typeof MediaStreamTrackProcessor === 'undefined' ||
            typeof MediaStreamTrackGenerator === 'undefined') {
          console.warn('[CaptureDesk] Insertable Streams unavailable');
          return stream;
        }

        return buildUpscaledStream(stream, track);
      });
    };

    function buildUpscaledStream(originalStream, srcTrack) {
      var canvas = new OffscreenCanvas(NATIVE_W, NATIVE_H);
      var ctx    = canvas.getContext('2d');
      var logged = false;

      var processor = new MediaStreamTrackProcessor({ track: srcTrack });
      var generator = new MediaStreamTrackGenerator({ kind: 'video' });

      var transform = new TransformStream({
        transform: function(frame, ctrl) {
          try {
            var fW = frame.displayWidth  || frame.codedWidth;
            var fH = frame.displayHeight || frame.codedHeight;

            if (fW === NATIVE_W && fH === NATIVE_H) {
              ctrl.enqueue(frame);
              return;
            }

            ctx.drawImage(frame, 0, 0, fW, fH, 0, 0, NATIVE_W, NATIVE_H);

            var init = { timestamp: frame.timestamp };
            if (frame.duration != null) init.duration = frame.duration;
            var out = new VideoFrame(canvas, init);
            frame.close();

            if (!logged) {
              console.warn('[CaptureDesk] Frame 0: ' + fW + 'x' + fH +
                ' -> ' + out.codedWidth + 'x' + out.codedHeight);
              logged = true;
            }

            ctrl.enqueue(out);
          } catch (e) {
            console.warn('[CaptureDesk] Frame error: ' + e.message);
            ctrl.enqueue(frame);
          }
        }
      });

      processor.readable.pipeThrough(transform).pipeTo(generator.writable).catch(function(err) {
        if (err.message !== 'Stream closed') {
          console.warn('[CaptureDesk] Pipeline error: ' + err.message);
        }
      });

      patchTrackSettings(generator);

      var tracks = [generator];
      var audio  = originalStream.getAudioTracks();
      for (var i = 0; i < audio.length; i++) tracks.push(audio[i]);

      console.warn('[CaptureDesk] Pipeline active -> ' + NATIVE_W + 'x' + NATIVE_H);
      return new MediaStream(tracks);
    }

    function patchTrackSettings(track) {
      var _orig = track.getSettings.bind(track);
      track.getSettings = function() {
        var s = _orig();
        s.width  = NATIVE_W;
        s.height = NATIVE_H;
        return s;
      };
    }
  })();`;

  return _captureOverrideScript;
}

function pickScreenSourceForRecording(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const primaryDisplayId = normalizeDisplayId(screen.getPrimaryDisplay()?.id);
  if (primaryDisplayId) {
    const primaryMatch = sources.find((source) => normalizeDisplayId(source.display_id) === primaryDisplayId);
    if (primaryMatch) {
      return primaryMatch;
    }
  }

  const availableDisplayIds = new Set(
    screen
      .getAllDisplays()
      .map((display) => normalizeDisplayId(display.id))
      .filter(Boolean),
  );

  const matchedDisplaySource = sources.find((source) => {
    const sourceDisplayId = normalizeDisplayId(source.display_id);
    return sourceDisplayId && availableDisplayIds.has(sourceDisplayId);
  });
  if (matchedDisplaySource) {
    return matchedDisplaySource;
  }

  const numberedScreenSource = sources.find((source) => /^screen\s+\d+$/i.test(source.name));
  return numberedScreenSource || sources[0];
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
          const selectedSource = pickScreenSourceForRecording(sources);

          if (!selectedSource) {
            console.error("No display source available for Loom recording.");
            callback({});
            return;
          }

          console.log(
            "Selected display source for Loom recording:",
            selectedSource.name,
            `(display_id=${selectedSource.display_id || "n/a"})`,
          );

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
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets/capturedesk.svg"),
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

  mainWindow.loadURL(`http://localhost:${PORT}`);
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

// Window controls (frameless title bar)
ipcMain.on("window-minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on("window-maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("window-close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

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

  // Forward warnings/errors and CaptureDesk diagnostics from iframes to terminal
  contents.on("console-message", (_, level, message, _line, sourceId) => {
    if (level >= 2 || message.includes("[CaptureDesk]")) {
      const tag = level <= 1 ? "log" : level === 2 ? "warn" : "error";
      console.log(`[iframe ${tag}]`, message, sourceId ? `(${sourceId})` : "");
    }
  });

  // Inject capture upscale override into every WebContents via CDP.
  const captureScript = getCaptureOverrideScript();
  if (captureScript) {
    try {
      contents.debugger.attach("1.3");
      contents.debugger
        .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: captureScript })
        .catch((err) => console.warn("[CaptureDesk] CDP injection failed:", err.message));
    } catch (err) {
      console.warn("[CaptureDesk] Debugger attach failed:", err.message);
    }

    // Fallback for WebContents where CDP attach failed (guard flag prevents dupes)
    contents.on("did-frame-finish-load", () => {
      try {
        for (const frame of contents.mainFrame.framesInSubtree) {
          frame.executeJavaScript(captureScript).catch(() => {});
        }
      } catch { /* WebContents may already be destroyed */ }
    });
  }
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
