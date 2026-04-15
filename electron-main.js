let electronMain;

try {
  electronMain = require("electron/main");
} catch {
  electronMain = require("electron");
}

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = electronMain;
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { start, PORT } = require("./src/server/index.js");

const LOOM_PARTITION = "persist:loom";
let mainWindow = null;
let cameraWindow = null;
let controlsWindow = null;
let drawOverlayWindow = null;
let mainWindowBounds = null;
const CONTROLS_WIDTH_NORMAL = 380;
const CONTROLS_WIDTH_DRAWING = 920;
function isDrawing() { return drawOverlayWindow !== null && !drawOverlayWindow.isDestroyed(); }
let preferredUiDisplayId = null;

const PRELOAD = path.join(__dirname, "preload.js");
const BASE_PREFS = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const UI_SETTINGS_FILE = "ui-settings.json";

function getUiSettingsPath() {
  return path.join(app.getPath("userData"), UI_SETTINGS_FILE);
}

function loadUiSettings() {
  try {
    const raw = fs.readFileSync(getUiSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    preferredUiDisplayId = normalizeDisplayId(parsed?.preferredUiDisplayId);
  } catch {
    preferredUiDisplayId = null;
  }
}

function saveUiSettings() {
  try {
    fs.writeFileSync(
      getUiSettingsPath(),
      JSON.stringify({ preferredUiDisplayId }, null, 2),
      "utf8",
    );
  } catch (error) {
    console.warn("Failed to save UI settings:", error.message);
  }
}

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
    webPreferences: { ...BASE_PREFS, partition: LOOM_PARTITION },
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

function getSafeDisplayArea(display) {
  const area = display?.workArea || display?.bounds;
  if (
    area
    && Number.isFinite(area.x)
    && Number.isFinite(area.y)
    && Number.isFinite(area.width)
    && Number.isFinite(area.height)
    && area.width > 0
    && area.height > 0
  ) {
    return area;
  }

  const primary = screen.getPrimaryDisplay();
  const primaryArea = primary?.workArea || primary?.bounds;
  if (
    primaryArea
    && Number.isFinite(primaryArea.x)
    && Number.isFinite(primaryArea.y)
    && Number.isFinite(primaryArea.width)
    && Number.isFinite(primaryArea.height)
    && primaryArea.width > 0
    && primaryArea.height > 0
  ) {
    return primaryArea;
  }

  return { x: 0, y: 0, width: 1920, height: 1080 };
}

function getUiDisplays() {
  const linuxConnectorNames = getLinuxConnectorNamesByBounds();

  return screen.getAllDisplays().map((display, index) => {
    const area = getSafeDisplayArea(display);
    return {
      id: normalizeDisplayId(display.id),
      index,
      name: getDisplayName(display, index, linuxConnectorNames),
      primary: !!display?.primary,
      width: area.width,
      height: area.height,
    };
  });
}

function getDisplayName(display, index, linuxConnectorNames) {
  const label = typeof display?.label === "string" ? display.label.trim() : "";
  if (label) return label;

  const area = getSafeDisplayArea(display);
  const key = `${area.x},${area.y},${area.width},${area.height}`;
  const connector = linuxConnectorNames.get(key);
  if (connector) {
    if (/^(eDP|LVDS)/i.test(connector)) return `Laptop-Display (${connector})`;
    if (/^HDMI/i.test(connector)) return `HDMI-Display (${connector})`;
    if (/^DP/i.test(connector)) return `DisplayPort-Display (${connector})`;
    if (/^DVI/i.test(connector)) return `DVI-Display (${connector})`;
    if (/^VGA/i.test(connector)) return `VGA-Display (${connector})`;
    return `Externer Bildschirm (${connector})`;
  }

  return `Monitor ${index + 1}`;
}

function getLinuxConnectorNamesByBounds() {
  if (process.platform !== "linux") return new Map();

  try {
    const output = execSync("xrandr --listactivemonitors", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const mapping = new Map();
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      const match = line.match(/\s(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)\s+(.+)$/);
      if (!match) continue;
      const width = Number(match[1]);
      const height = Number(match[2]);
      const x = Number(match[3]);
      const y = Number(match[4]);
      const connector = String(match[5] || "").trim();
      if (!connector) continue;
      mapping.set(`${x},${y},${width},${height}`, connector);
    }

    return mapping;
  } catch {
    return new Map();
  }
}

function getResolvedUiDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return screen.getPrimaryDisplay();
  }

  if (preferredUiDisplayId) {
    const matched = displays.find((d) => normalizeDisplayId(d.id) === preferredUiDisplayId);
    if (matched) return matched;
  }

  return screen.getPrimaryDisplay() || displays[0];
}

function setPreferredUiDisplayId(displayId) {
  const normalized = normalizeDisplayId(displayId);
  const displays = screen.getAllDisplays();
  const matched = displays.find((d) => normalizeDisplayId(d.id) === normalized);
  preferredUiDisplayId = normalizeDisplayId((matched || screen.getPrimaryDisplay())?.id);
  saveUiSettings();
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
// display resolution via Insertable Streams + OffscreenCanvas.
// To avoid distortion when the selected monitor has a different aspect ratio
// than the primary display, frames are fit proportionally (no stretching).
//
// Injection: CDP Page.addScriptToEvaluateOnNewDocument runs the script BEFORE
// any page scripts in every frame (including cross-origin Loom SDK iframes),
// preventing the SDK from caching the original getDisplayMedia reference.
// ---------------------------------------------------------------------------

let _captureOverrideScript = null;

function getCaptureOverrideScript() {
  if (_captureOverrideScript !== null) return _captureOverrideScript;

  const { width: nativeW, height: nativeH } = screen.getPrimaryDisplay().size;
  const displayTargets = screen
    .getAllDisplays()
    .map((d) => ({ width: Number(d?.size?.width), height: Number(d?.size?.height) }))
    .filter((d) => d.width > 0 && d.height > 0);

  console.log(`[CaptureDesk] Display is ${nativeW}x${nativeH} — will upscale capture to native resolution`);

  // ES5-compatible: runs in sandboxed cross-origin iframes
  _captureOverrideScript = `(function() {
    if (window.__capturedeskApplied) return;
    window.__capturedeskApplied = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return;

    var DEFAULT_NATIVE_W = ${nativeW};
    var DEFAULT_NATIVE_H = ${nativeH};
    var DISPLAY_TARGETS = ${JSON.stringify(displayTargets)};

    function pickBestTargetForSource(srcW, srcH) {
      if (!(srcW > 0 && srcH > 0) || !Array.isArray(DISPLAY_TARGETS) || DISPLAY_TARGETS.length === 0) {
        return { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
      }

      var srcAspect = srcW / srcH;
      var best = null;
      var bestScore = Number.POSITIVE_INFINITY;

      for (var i = 0; i < DISPLAY_TARGETS.length; i++) {
        var t = DISPLAY_TARGETS[i] || {};
        var w = Number(t.width);
        var h = Number(t.height);
        if (!(w > 0 && h > 0)) continue;

        var aspect = w / h;
        var aspectDiff = Math.abs(aspect - srcAspect);
        var scaleX = w / srcW;
        var scaleY = h / srcH;
        var scaleSkew = Math.abs(scaleX - scaleY);

        // Strongly prefer aspect match, then prefer close proportional scale.
        var score = (aspectDiff * 1000) + (scaleSkew * 100) + Math.abs(1 - Math.min(scaleX, scaleY));
        if (score < bestScore) {
          bestScore = score;
          best = { width: Math.round(w), height: Math.round(h) };
        }
      }

      return best || { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
    }

    function getConfiguredTargetSize() {
      var maybeTarget = window.__capturedeskTargetSize || {};
      var w = Number(maybeTarget.width);
      var h = Number(maybeTarget.height);
      if (w > 0 && h > 0) {
        return { width: Math.round(w), height: Math.round(h) };
      }
      return { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
    }

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
      var initialSettings = srcTrack.getSettings ? srcTrack.getSettings() : {};
      var initialSourceW = Number(initialSettings.width) || 0;
      var initialSourceH = Number(initialSettings.height) || 0;
      var inferredTarget = pickBestTargetForSource(initialSourceW, initialSourceH);
      var initialTarget = getConfiguredTargetSize();
      if (!(window.__capturedeskTargetSize && window.__capturedeskTargetSize.width && window.__capturedeskTargetSize.height)) {
        initialTarget = inferredTarget;
      }
      var canvas = new OffscreenCanvas(initialTarget.width, initialTarget.height);
      var ctx    = canvas.getContext('2d');
      var logged = false;

      var processor = new MediaStreamTrackProcessor({ track: srcTrack });
      var generator = new MediaStreamTrackGenerator({ kind: 'video' });

      var transform = new TransformStream({
        transform: function(frame, ctrl) {
          try {
            var fW = frame.displayWidth  || frame.codedWidth;
            var fH = frame.displayHeight || frame.codedHeight;
            var target = getConfiguredTargetSize();
            if (!(window.__capturedeskTargetSize && window.__capturedeskTargetSize.width && window.__capturedeskTargetSize.height)) {
              target = pickBestTargetForSource(fW, fH);
            }
            var targetW = target.width;
            var targetH = target.height;

            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
            }

            if (fW === targetW && fH === targetH) {
              ctrl.enqueue(frame);
              return;
            }

            var srcAspect = fW / fH;
            var dstAspect = targetW / targetH;
            var drawW = targetW;
            var drawH = targetH;
            var drawX = 0;
            var drawY = 0;

            if (Math.abs(srcAspect - dstAspect) > 0.001) {
              if (srcAspect > dstAspect) {
                drawW = targetW;
                drawH = Math.round(targetW / srcAspect);
                drawY = Math.floor((targetH - drawH) / 2);
              } else {
                drawH = targetH;
                drawW = Math.round(targetH * srcAspect);
                drawX = Math.floor((targetW - drawW) / 2);
              }
            }

            ctx.clearRect(0, 0, targetW, targetH);
            ctx.drawImage(frame, 0, 0, fW, fH, drawX, drawY, drawW, drawH);

            var init = { timestamp: frame.timestamp };
            if (frame.duration != null) init.duration = frame.duration;
            var out = new VideoFrame(canvas, init);
            frame.close();

            if (!logged) {
              console.warn('[CaptureDesk] Frame 0: ' + fW + 'x' + fH +
                ' -> ' + out.codedWidth + 'x' + out.codedHeight +
                ' (draw ' + drawW + 'x' + drawH + ' at ' + drawX + ',' + drawY + ')');
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

      var finalTarget = getConfiguredTargetSize();
      if (!(window.__capturedeskTargetSize && window.__capturedeskTargetSize.width && window.__capturedeskTargetSize.height)) {
        finalTarget = inferredTarget;
      }
      console.warn('[CaptureDesk] Pipeline active -> ' + finalTarget.width + 'x' + finalTarget.height);
      return new MediaStream(tracks);
    }

    function patchTrackSettings(track) {
      var _orig = track.getSettings.bind(track);
      track.getSettings = function() {
        var s = _orig();
        var target = getConfiguredTargetSize();
        if (!(window.__capturedeskTargetSize && window.__capturedeskTargetSize.width && window.__capturedeskTargetSize.height)) {
          var sWidth = Number(s.width) || 0;
          var sHeight = Number(s.height) || 0;
          target = pickBestTargetForSource(sWidth, sHeight);
        }
        s.width  = target.width;
        s.height = target.height;
        return s;
      };
    }
  })();`;

  return _captureOverrideScript;
}

// Returns { source, display } — display is the Electron Display object that
// best matches the selected capture source, so the draw overlay can be placed
// on exactly the screen being recorded.
// On Linux, source.display_id is often empty, so we fall back to matching by
// source order: desktopCapturer sources and screen.getAllDisplays() are both
// sorted by display index, so source[i] corresponds to display[i].
function pickScreenSourceForRecording(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const allDisplays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  // Helper: given a source, find its matching display via display_id (when
  // available) or by positional index as a fallback.
  function displayForSource(source, sourceIndex) {
    const sid = normalizeDisplayId(source.display_id);
    if (sid) {
      const byId = allDisplays.find((d) => normalizeDisplayId(d.id) === sid);
      if (byId) return byId;
    }
    // Positional fallback: source order matches display order on Linux/X11
    return allDisplays[sourceIndex] || primaryDisplay;
  }

  // 1. Try to find the source whose display_id matches the primary display
  const primaryDisplayId = normalizeDisplayId(primaryDisplay?.id);
  if (primaryDisplayId) {
    const idx = sources.findIndex((s) => normalizeDisplayId(s.display_id) === primaryDisplayId);
    if (idx !== -1) {
      return { source: sources[idx], display: primaryDisplay };
    }
  }

  // 2. Try any source that has a display_id matching a known display
  const availableDisplayIds = new Set(
    allDisplays.map((d) => normalizeDisplayId(d.id)).filter(Boolean),
  );
  const matchedIdx = sources.findIndex((s) => {
    const sid = normalizeDisplayId(s.display_id);
    return sid && availableDisplayIds.has(sid);
  });
  if (matchedIdx !== -1) {
    return { source: sources[matchedIdx], display: displayForSource(sources[matchedIdx], matchedIdx) };
  }

  // 3. "Screen N" named source
  const numberedIdx = sources.findIndex((s) => /^screen\s+\d+$/i.test(s.name));
  if (numberedIdx !== -1) {
    return { source: sources[numberedIdx], display: displayForSource(sources[numberedIdx], numberedIdx) };
  }

  // 4. First source
  return { source: sources[0], display: displayForSource(sources[0], 0) };
}

function configureLoomSession(browserSession) {
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
      async (request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            thumbnailSize: { width: 0, height: 0 },
            types: ["screen"],
          });
          const picked = pickScreenSourceForRecording(sources);

          if (!picked) {
            console.error("No display source available for Loom recording.");
            callback({});
            return;
          }

          const { source: selectedSource, display: selectedDisplay } = picked;
          const selectedSize = selectedDisplay?.size || {};
          const selectedW = Number(selectedSize.width);
          const selectedH = Number(selectedSize.height);

          console.log(
            "Selected display source for Loom recording:",
            selectedSource.name,
            `(display_id=${selectedSource.display_id || "n/a"}, resolved display bounds: ${JSON.stringify(selectedDisplay.bounds)}, target=${selectedW || "n/a"}x${selectedH || "n/a"})`,
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
      ...BASE_PREFS,
      preload: PRELOAD,
      allowRunningInsecureContent: false,
      partition: LOOM_PARTITION,
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

  const { x: dispX, y: dispY, height } = getUiWorkArea();

  cameraWindow = new BrowserWindow({
    width: 200,
    height: 200,
    x: dispX + 20,
    y: dispY + height - 220,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: process.platform === "linux" ? "toolbar" : "normal",
    webPreferences: { ...BASE_PREFS, partition: LOOM_PARTITION },
  });

  cameraWindow.setContentProtection(true);
  cameraWindow.setSkipTaskbar(true);
  cameraWindow.setVisibleOnAllWorkspaces(true);
  cameraWindow.loadFile(path.join(__dirname, "src", "views", "camera.html"));
  cameraWindow.on("closed", () => {
    cameraWindow = null;
  });
}

function createControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) return;

  const { x: dispX, y: dispY, width } = getUiWorkArea();
  const controlsWidth = CONTROLS_WIDTH_NORMAL;

  controlsWindow = new BrowserWindow({
    width: controlsWidth,
    height: 60,
    x: dispX + Math.round((width - controlsWidth) / 2),
    y: dispY + 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: process.platform === "linux" ? "toolbar" : "normal",
    webPreferences: { ...BASE_PREFS, preload: PRELOAD },
  });

  controlsWindow.setContentProtection(true);
  controlsWindow.setSkipTaskbar(true);
  controlsWindow.setVisibleOnAllWorkspaces(true);
  controlsWindow.setAlwaysOnTop(true, "screen-saver");
  controlsWindow.loadFile(path.join(__dirname, "src", "views", "controls.html"));
  controlsWindow.on("closed", () => {
    controlsWindow = null;
    // If user manually closes controls, restore main window
    closeCameraWindow();
    closeDrawOverlayWindow();
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

function getUiWorkArea() {
  const display = getResolvedUiDisplay();
  return getSafeDisplayArea(display);
}

// Returns a bounding rect that covers every connected display so the draw
// overlay works regardless of which screen is being recorded.
function getVirtualDesktopBounds() {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxRight = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxBottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxRight - minX, height: maxBottom - minY };
}

function createDrawOverlayWindow() {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) return;

  const { x, y, width, height } = getVirtualDesktopBounds();

  drawOverlayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: { ...BASE_PREFS, preload: PRELOAD },
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
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.webContents.send("draw-state-changed", false);
    }
  });
}

function closeWindow(win, removeListeners = false) {
  if (win && !win.isDestroyed()) {
    if (removeListeners) win.removeAllListeners("closed");
    win.close();
  }
}

function closeCameraWindow() { closeWindow(cameraWindow); cameraWindow = null; }
function closeControlsWindow() { closeWindow(controlsWindow, true); controlsWindow = null; }
function closeDrawOverlayWindow() { closeWindow(drawOverlayWindow, true); drawOverlayWindow = null; }

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pause-recording");
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
  const { x: dispX, width: screenW } = getUiWorkArea();
  controlsWindow.setBounds({
    x: dispX + Math.round((screenW - width) / 2),
    y: bounds.y,
    width,
    height: bounds.height,
  });
  raiseOverlayUiWindows();
}

function repositionUiWindows() {
  const { x: dispX, y: dispY, width, height } = getUiWorkArea();

  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.setBounds({ x: dispX + 20, y: dispY + height - 220, width: 200, height: 200 });
  }

  if (controlsWindow && !controlsWindow.isDestroyed()) {
    const ctrlWidth = isDrawing() ? CONTROLS_WIDTH_DRAWING : CONTROLS_WIDTH_NORMAL;
    controlsWindow.setBounds({
      x: dispX + Math.round((width - ctrlWidth) / 2),
      y: dispY + 20,
      width: ctrlWidth,
      height: 60,
    });
  }

  raiseOverlayUiWindows();
}

function toggleDrawOverlay() {
  if (isDrawing()) {
    closeDrawOverlayWindow();
    resizeControlsWindow(CONTROLS_WIDTH_NORMAL);
  } else {
    createDrawOverlayWindow();
    resizeControlsWindow(CONTROLS_WIDTH_DRAWING);
  }
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send("draw-state-changed", isDrawing());
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
  mainWindow.hide();
  createCameraWindow();
  createControlsWindow();
  registerRecordingShortcuts();
});

ipcMain.on("recording-stopped", () => {
  unregisterRecordingShortcuts();
  closeCameraWindow();
  closeControlsWindow();
  closeDrawOverlayWindow();
  restoreMainWindow();
});

ipcMain.on("request-stop-recording", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("stop-recording");
  }
});

ipcMain.on("request-pause-recording", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pause-recording");
  }
});

ipcMain.on("recording-pause-state-changed", (_, isPaused) => {
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send("recording-pause-state-changed", isPaused);
  }
});

ipcMain.on("request-toggle-draw", () => {
  toggleDrawOverlay();
});

ipcMain.handle("get-ui-displays", () => {
  return getUiDisplays();
});

ipcMain.handle("get-preferred-ui-display", () => {
  return normalizeDisplayId(getResolvedUiDisplay()?.id);
});

ipcMain.handle("set-preferred-ui-display", (_event, displayId) => {
  setPreferredUiDisplayId(displayId);
  repositionUiWindows();
  return normalizeDisplayId(getResolvedUiDisplay()?.id);
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
for (const channel of ["draw-tool-changed", "draw-color-changed", "draw-size-changed"]) {
  ipcMain.on(channel, (_, value) => {
    if (isDrawing()) drawOverlayWindow.webContents.send(channel, value);
  });
}

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
  loadUiSettings();

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
