let electronMain;

try {
  electronMain = require("electron/main");
} catch {
  electronMain = require("electron");
}

const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } = electronMain;
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { start, PORT, getAppId, setAppId } = require("./src/server/index.js");
const { isValidAppId, saveAppId, userConfigEnvPath } = require("./src/server/user-config.js");

const LOOM_PARTITION = "persist:loom";
let mainWindow = null;
let cameraWindow = null;
let controlsWindow = null;
let setupWindow = null;
let drawOverlayWindow = null;
let mainWindowBounds = null;
const CONTROLS_WIDTH_NORMAL = 380;
const CONTROLS_WIDTH_DRAWING = 920;
const CAMERA_SIZE_DEFAULT = 200;
const CAMERA_SIZE_MIN = 120;
const CAMERA_SIZE_MAX = 360;
// The scroll step is coarse enough that one notch is visible but it still
// takes a deliberate gesture to cross a preset.
const CAMERA_SIZE_STEP = 10;
const CONTROLS_WINDOW_HEIGHT = 60;
const OVERLAY_UI_MARGIN = 20;
const OVERLAY_UI_GAP = 20;
function isDrawing() { return drawOverlayWindow !== null && !drawOverlayWindow.isDestroyed(); }
let preferredUiDisplayId = null;
// Camera position as an offset from the UI display's work-area origin, so the
// bubble keeps its relative spot when the user switches the UI monitor.
// null = use the default (bottom-left, above the controls bar).
let cameraOffset = null;
let cameraDragOrigin = null;
let cameraSize = CAMERA_SIZE_DEFAULT;
let backgroundBlurEnabled = false;
let _connectorCache = null;
let desktopAudioEnabled = false;
let captureQuality = "balanced";
let uploadInProgress = false;
let forceCloseMainWindow = false;

const CAPTURE_QUALITY_VALUES = ["fast", "balanced", "quality"];
const BALANCED_MAX_DIM = 1920;

function normalizeCaptureQuality(value) {
  return CAPTURE_QUALITY_VALUES.includes(value) ? value : "balanced";
}

function normalizeCameraSize(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return CAMERA_SIZE_DEFAULT;
  return Math.min(Math.max(n, CAMERA_SIZE_MIN), CAMERA_SIZE_MAX);
}

function normalizeCameraOffset(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

const PRELOAD = path.join(__dirname, "preload.js");
const SETUP_PRELOAD = path.join(__dirname, "setup-preload.js");
const LOOM_DEVELOPER_PORTAL_URL = "https://www.loom.com/developer-portal";
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
    desktopAudioEnabled = !!parsed?.desktopAudioEnabled;
    captureQuality = normalizeCaptureQuality(parsed?.captureQuality);
    cameraOffset = normalizeCameraOffset(parsed?.cameraOffset);
    cameraSize = normalizeCameraSize(parsed?.cameraSize);
    backgroundBlurEnabled = !!parsed?.backgroundBlurEnabled;
  } catch {
    preferredUiDisplayId = null;
    desktopAudioEnabled = false;
    captureQuality = "balanced";
    cameraOffset = null;
    cameraSize = CAMERA_SIZE_DEFAULT;
    backgroundBlurEnabled = false;
  }
}

function saveUiSettings() {
  try {
    fs.writeFileSync(
      getUiSettingsPath(),
      JSON.stringify(
        {
          preferredUiDisplayId,
          desktopAudioEnabled,
          captureQuality,
          cameraOffset,
          cameraSize,
          backgroundBlurEnabled,
        },
        null,
        2,
      ),
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

function getDesktopAudioSyncScript() {
  return `window.__capturedeskAudioEnabled = ${desktopAudioEnabled ? "true" : "false"};`;
}

function getCaptureQualitySyncScript() {
  return `window.__capturedeskCaptureQuality = ${JSON.stringify(captureQuality)};`;
}

function syncScriptInContents(contents, script) {
  if (!contents || contents.isDestroyed() || !script) return;
  try {
    const mainFrame = contents.mainFrame;
    if (!mainFrame) return;
    for (const frame of mainFrame.framesInSubtree) {
      // Capture override globals are only consumed inside Loom-origin iframes.
      // The main frame gets the script too (our own localhost page initializes
      // the override in case the renderer ever calls getDisplayMedia).
      if (frame !== mainFrame && !isLoomUrl(frame.url || "")) continue;
      frame.executeJavaScript(script).catch(() => {});
    }
  } catch {
    // Ignore transient frame access errors during navigation/destruction.
  }
}

// Both globals travel in one script so a frame load costs a single
// executeJavaScript round-trip per frame instead of one per setting.
function getSettingsSyncScript() {
  return `${getDesktopAudioSyncScript()}${getCaptureQualitySyncScript()}`;
}

function syncSettingsEverywhere() {
  const script = getSettingsSyncScript();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      syncScriptInContents(win.webContents, script);
    }
  }
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

let _connectorLoadPromise = null;

function parseXrandrOutput(output) {
  const mapping = new Map();
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
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
}

// Non-blocking: returns the cached connector map immediately (empty on first
// call on Linux), and kicks off the async xrandr load in the background. When
// the load resolves, `_connectorCache` is populated and subscribers are
// notified via a "ui-displays-updated" IPC so the UI can refresh labels.
function getLinuxConnectorNamesByBounds() {
  if (process.platform !== "linux") return new Map();
  if (_connectorCache !== null) return _connectorCache;

  if (!_connectorLoadPromise) {
    _connectorLoadPromise = new Promise((resolve) => {
      execFile("xrandr", ["--listactivemonitors"], { encoding: "utf8" }, (err, stdout) => {
        if (err) {
          _connectorCache = new Map();
        } else {
          _connectorCache = parseXrandrOutput(stdout);
        }
        resolve(_connectorCache);
        notifyUiDisplaysUpdated();
      });
    });
  }

  return new Map();
}

function notifyUiDisplaysUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ui-displays-updated");
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
    var INITIAL_DESKTOP_AUDIO_ENABLED = ${desktopAudioEnabled ? "true" : "false"};
    var INITIAL_CAPTURE_QUALITY = ${JSON.stringify(captureQuality)};
    var BALANCED_MAX_DIM = ${BALANCED_MAX_DIM};

    if (typeof window.__capturedeskAudioEnabled !== 'boolean') {
      window.__capturedeskAudioEnabled = INITIAL_DESKTOP_AUDIO_ENABLED;
    }
    if (typeof window.__capturedeskCaptureQuality !== 'string') {
      window.__capturedeskCaptureQuality = INITIAL_CAPTURE_QUALITY;
    }

    function getCaptureQuality() {
      var q = window.__capturedeskCaptureQuality;
      return (q === 'fast' || q === 'balanced' || q === 'quality') ? q : 'balanced';
    }

    function clampToBalanced(target) {
      var w = Number(target && target.width);
      var h = Number(target && target.height);
      if (!(w > 0 && h > 0)) return { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
      if (w <= BALANCED_MAX_DIM && h <= BALANCED_MAX_DIM) return { width: w, height: h };
      var scale = Math.min(BALANCED_MAX_DIM / w, BALANCED_MAX_DIM / h);
      return {
        width: Math.max(2, Math.round(w * scale / 2) * 2),
        height: Math.max(2, Math.round(h * scale / 2) * 2)
      };
    }

    function pickBestTargetForSource(srcW, srcH) {
      var best;
      if (!(srcW > 0 && srcH > 0) || !Array.isArray(DISPLAY_TARGETS) || DISPLAY_TARGETS.length === 0) {
        best = { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
      } else {
        var srcAspect = srcW / srcH;
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

        if (!best) best = { width: DEFAULT_NATIVE_W, height: DEFAULT_NATIVE_H };
      }

      return getCaptureQuality() === 'balanced' ? clampToBalanced(best) : best;
    }

    function posOrZero(value) {
      var n = Number(value);
      return n > 0 ? n : 0;
    }

    // Single source of truth for the capture target size: an explicit
    // __capturedeskTargetSize override wins, otherwise the best-matching
    // display for the incoming frame size. Memoised because this is called
    // once per frame while its inputs change approximately never.
    var _targetMemo = null;

    function computeTarget(srcW, srcH) {
      var override = window.__capturedeskTargetSize || {};
      var ow = posOrZero(override.width);
      var oh = posOrZero(override.height);
      if (ow > 0 && oh > 0) {
        var target = { width: Math.round(ow), height: Math.round(oh) };
        return getCaptureQuality() === 'balanced' ? clampToBalanced(target) : target;
      }
      return pickBestTargetForSource(srcW, srcH);
    }

    function resolveTarget(srcW, srcH) {
      var override = window.__capturedeskTargetSize || {};
      var quality = getCaptureQuality();
      var ow = posOrZero(override.width);
      var oh = posOrZero(override.height);
      var memo = _targetMemo;

      if (memo && memo.srcW === srcW && memo.srcH === srcH &&
          memo.quality === quality && memo.ow === ow && memo.oh === oh) {
        return memo.target;
      }

      var resolved = computeTarget(srcW, srcH);
      _targetMemo = {
        srcW: srcW, srcH: srcH, quality: quality, ow: ow, oh: oh, target: resolved
      };
      return resolved;
    }

    console.warn('[CaptureDesk] Override installed in: ' + location.href.substring(0, 120));

    var _origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    var _origGUM = (navigator.mediaDevices.getUserMedia || null) &&
                  navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    // Intercept getUserMedia to request higher-quality audio from the microphone.
    if (_origGUM) {
      navigator.mediaDevices.getUserMedia = function(constraints) {
        var c = (constraints && typeof constraints === 'object')
          ? JSON.parse(JSON.stringify(constraints))
          : (constraints || {});
        if (c.audio === true) {
          c.audio = { sampleRate: { ideal: 48000 }, channelCount: { ideal: 2 } };
        } else if (c.audio && typeof c.audio === 'object') {
          if (!c.audio.sampleRate)    c.audio.sampleRate    = { ideal: 48000 };
          if (!c.audio.channelCount)  c.audio.channelCount  = { ideal: 2 };
        }
        return _origGUM.call(navigator.mediaDevices, c);
      };
    }

    navigator.mediaDevices.getDisplayMedia = function() {
      console.warn('[CaptureDesk] getDisplayMedia intercepted');

      var args = Array.prototype.slice.call(arguments);
      var constraints = args[0];
      var c = (constraints && typeof constraints === 'object')
        ? JSON.parse(JSON.stringify(constraints))
        : {};

      if (shouldIncludeDesktopAudio()) {
        // Preserve existing detailed constraints; only force-enable when disabled/missing.
        if (c.audio === undefined || c.audio === false) c.audio = true;
      } else {
        // Hard-disable desktop audio capture when toggle is off.
        c.audio = false;
      }
      args[0] = c;
      console.warn('[CaptureDesk] getDisplayMedia audio=' + String(c.audio));

      return _origGDM.apply(navigator.mediaDevices, args).then(function(stream) {
        var track = (stream.getVideoTracks() || [])[0];
        if (!track) return stream;

        if (typeof window.__capturedeskAudioEnabled !== 'boolean') {
          window.__capturedeskAudioEnabled = INITIAL_DESKTOP_AUDIO_ENABLED;
        }

        var quality = getCaptureQuality();
        if (quality === 'fast') {
          console.warn('[CaptureDesk] Quality=fast; using passthrough stream');
          return buildPassthroughStream(stream, track);
        }
        if (typeof MediaStreamTrackProcessor === 'undefined' ||
            typeof MediaStreamTrackGenerator === 'undefined') {
          console.warn('[CaptureDesk] Insertable Streams unavailable; using passthrough stream');
          return buildPassthroughStream(stream, track);
        }

        // The per-frame rescale is the expensive part, so first ask the source
        // to deliver the target resolution itself. When that works the stream
        // needs no processing at all; otherwise we fall back to the pipeline.
        // Set window.__capturedeskTryNativeCapture = false to skip the attempt.
        return requestNativeResolution(track).then(function(isNative) {
          if (isNative) {
            console.warn('[CaptureDesk] Quality=' + quality + '; source delivers target size, passthrough');
            return buildPassthroughStream(stream, track);
          }
          console.warn('[CaptureDesk] Quality=' + quality + '; using upscaled stream');
          return buildUpscaledStream(stream, track);
        });
      });
    };

    function shouldIncludeDesktopAudio() {
      return window.__capturedeskAudioEnabled === true;
    }

    function settingsMatchTarget(settings, target) {
      return posOrZero(settings && settings.width) === target.width &&
             posOrZero(settings && settings.height) === target.height;
    }

    function requestNativeResolution(srcTrack) {
      if (window.__capturedeskTryNativeCapture === false ||
          typeof srcTrack.applyConstraints !== 'function' ||
          typeof srcTrack.getSettings !== 'function') {
        return Promise.resolve(false);
      }

      var settings = srcTrack.getSettings();
      var target = resolveTarget(posOrZero(settings.width), posOrZero(settings.height));
      if (settingsMatchTarget(settings, target)) return Promise.resolve(true);

      // Using 'exact' so a partial match still falls through to the rescale
      // pipeline rather than silently recording at some third resolution. A
      // rejected applyConstraints leaves the previous settings untouched.
      return srcTrack.applyConstraints({
        width: { exact: target.width },
        height: { exact: target.height }
      }).then(function() {
        return settingsMatchTarget(srcTrack.getSettings(), target);
      }).catch(function() {
        return false;
      });
    }

    function buildPassthroughStream(originalStream, srcTrack) {
      var tracks = [srcTrack];
      if (shouldIncludeDesktopAudio()) {
        var audio = originalStream.getAudioTracks();
        for (var i = 0; i < audio.length; i++) tracks.push(audio[i]);
      }
      return new MediaStream(tracks);
    }

    function buildUpscaledStream(originalStream, srcTrack) {
      var initialSettings = srcTrack.getSettings ? srcTrack.getSettings() : {};
      var initialTarget = resolveTarget(
        posOrZero(initialSettings.width),
        posOrZero(initialSettings.height)
      );

      var canvas = new OffscreenCanvas(initialTarget.width, initialTarget.height);
      // alpha:false drops per-frame alpha compositing and desynchronized lets
      // the 2D backend skip a synchronisation round-trip. Screen capture is
      // fully opaque, so neither costs anything here.
      var ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      var logged = false;

      // Letterbox geometry only changes when the source or target size
      // changes, so the canvas only needs clearing then — a clearRect per
      // frame is pure overhead when drawImage covers the whole surface.
      var geom = null;

      function resolveGeometry(fW, fH, targetW, targetH) {
        if (geom && geom.fW === fW && geom.fH === fH &&
            geom.targetW === targetW && geom.targetH === targetH) {
          return geom;
        }

        var drawW = targetW;
        var drawH = targetH;
        var drawX = 0;
        var drawY = 0;
        var srcAspect = fW / fH;
        var dstAspect = targetW / targetH;

        if (Math.abs(srcAspect - dstAspect) > 0.001) {
          if (srcAspect > dstAspect) {
            drawH = Math.round(targetW / srcAspect);
            drawY = Math.floor((targetH - drawH) / 2);
          } else {
            drawW = Math.round(targetH * srcAspect);
            drawX = Math.floor((targetW - drawW) / 2);
          }
        }

        geom = {
          fW: fW, fH: fH, targetW: targetW, targetH: targetH,
          drawW: drawW, drawH: drawH, drawX: drawX, drawY: drawY
        };

        // New geometry can leave stale pixels outside the draw rect.
        if (drawW !== targetW || drawH !== targetH) {
          ctx.clearRect(0, 0, targetW, targetH);
        }
        return geom;
      }

      // maxBufferSize 1 plus a writable high-water mark of 1: when a frame
      // takes too long the source drops the next one instead of building a
      // queue, which would trade latency and memory for frames nobody sees.
      var processor = new MediaStreamTrackProcessor({ track: srcTrack, maxBufferSize: 1 });
      var generator = new MediaStreamTrackGenerator({ kind: 'video' });
      var frameInit = {};

      var transform = new TransformStream({
        transform: function(frame, ctrl) {
          try {
            var fW = frame.displayWidth || frame.codedWidth;
            var fH = frame.displayHeight || frame.codedHeight;
            var target = resolveTarget(fW, fH);
            var targetW = target.width;
            var targetH = target.height;

            if (fW === targetW && fH === targetH) {
              ctrl.enqueue(frame);
              return;
            }

            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
              geom = null; // the resize already cleared the backing store
            }

            var g = resolveGeometry(fW, fH, targetW, targetH);
            ctx.drawImage(frame, 0, 0, fW, fH, g.drawX, g.drawY, g.drawW, g.drawH);

            frameInit.timestamp = frame.timestamp;
            if (frame.duration != null) {
              frameInit.duration = frame.duration;
            } else {
              delete frameInit.duration;
            }

            var out = new VideoFrame(canvas, frameInit);
            frame.close();

            if (!logged) {
              console.warn('[CaptureDesk] Frame 0: ' + fW + 'x' + fH +
                ' -> ' + out.codedWidth + 'x' + out.codedHeight +
                ' (draw ' + g.drawW + 'x' + g.drawH + ' at ' + g.drawX + ',' + g.drawY + ')');
              logged = true;
            }

            ctrl.enqueue(out);
          } catch (e) {
            console.warn('[CaptureDesk] Frame error: ' + e.message);
            ctrl.enqueue(frame);
          }
        }
      }, { highWaterMark: 1 }, { highWaterMark: 0 });

      // Without this the processor keeps pulling frames until GC gets around
      // to it, and the desktop capture stays alive after the consumer is done
      // with our generator track.
      var abort = new AbortController();
      var shuttingDown = false;

      function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        abort.abort();
        try { srcTrack.stop(); } catch (e) { /* already ended */ }
        try {
          if (generator.readyState === 'live') generator.stop();
        } catch (e) { /* already ended */ }
      }

      srcTrack.addEventListener('ended', shutdown);

      processor.readable
        .pipeThrough(transform, { signal: abort.signal })
        .pipeTo(generator.writable, { signal: abort.signal })
        .catch(function(err) {
          var name = err && err.name;
          var message = (err && err.message) || '';
          if (name !== 'AbortError' && message !== 'Stream closed') {
            console.warn('[CaptureDesk] Pipeline error: ' + message);
          }
        })
        .then(shutdown);

      patchTrackSettings(generator, srcTrack);

      var tracks = [generator];
      if (shouldIncludeDesktopAudio()) {
        var audio = originalStream.getAudioTracks();
        for (var i = 0; i < audio.length; i++) tracks.push(audio[i]);
      }

      console.warn('[CaptureDesk] Pipeline active -> ' + initialTarget.width + 'x' + initialTarget.height);
      return new MediaStream(tracks);
    }

    // The SDK reads getSettings() to decide the recording resolution, so the
    // generator has to report the size we actually produce, not the source's.
    function patchTrackSettings(track, srcTrack) {
      var _orig = track.getSettings.bind(track);
      track.getSettings = function() {
        var s = _orig();
        var src = srcTrack.getSettings ? srcTrack.getSettings() : {};
        var target = resolveTarget(posOrZero(src.width), posOrZero(src.height));
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

          const streams = { video: selectedSource };
          // Electron loopback via setDisplayMediaRequestHandler is only supported on Windows.
          if (desktopAudioEnabled && process.platform === "win32") {
            streams.audio = "loopback";
          }
          callback(streams);
        } catch (error) {
          console.error("Failed to provide a display source for Loom recording:", error);
          callback({});
        }
      },
      // On Linux, the OS/system picker can override audio intent and still attach
      // system sound even when constraints request audio=false.
      { useSystemPicker: process.platform === "win32" },
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

// Asks for the Loom app ID. Opened on first start when none is configured, and
// from the settings in the main window to change it.
function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  const hasMainWindow = mainWindow && !mainWindow.isDestroyed();
  setupWindow = new BrowserWindow({
    width: 560,
    height: 440,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "CaptureDesk einrichten",
    icon: path.join(__dirname, "assets/capturedesk.svg"),
    backgroundColor: "#060a13",
    parent: hasMainWindow ? mainWindow : undefined,
    modal: hasMainWindow,
    webPreferences: { ...BASE_PREFS, preload: SETUP_PRELOAD },
  });

  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  setupWindow.loadFile(path.join(__dirname, "src/views/setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
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
      // This window is hidden for the whole recording (see "recording-started"),
      // yet the Loom SDK records and uploads from it. Chromium throttles timers
      // to ~1/minute and pauses rAF in hidden windows, which would stall the
      // recorder's chunking and upload cadence.
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(createWindowOpenHandler());
  mainWindow.setContentProtection(true);
  installCaptureOverride(mainWindow.webContents);

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on("close", (event) => {
    if (!uploadInProgress || forceCloseMainWindow) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      title: "Upload laeuft noch",
      message: "Ein Upload wird gerade uebertragen.",
      detail: "Wenn du jetzt schliesst, wird der Upload abgebrochen und das Video geht verloren.",
      buttons: ["Abbrechen", "Trotzdem schliessen"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) {
      forceCloseMainWindow = true;
      mainWindow.close();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    uploadInProgress = false;
    forceCloseMainWindow = false;
    closeCameraWindow();
    closeControlsWindow();
    closeDrawOverlayWindow();
  });
}

function createCameraWindow() {
  if (cameraWindow && !cameraWindow.isDestroyed()) return;

  const cameraBounds = getCameraWindowBounds();

  cameraWindow = new BrowserWindow({
    width: cameraBounds.width,
    height: cameraBounds.height,
    x: cameraBounds.x,
    y: cameraBounds.y,
    frame: false,
    transparent: true,
    // Electron 43+ rounds frameless windows on Linux; keep overlays square.
    roundedCorners: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: process.platform === "linux" ? "toolbar" : "normal",
    webPreferences: { ...BASE_PREFS, preload: PRELOAD, partition: LOOM_PARTITION },
  });

  cameraWindow.webContents.on("did-finish-load", () => {
    cameraWindow.webContents.send("background-blur-changed", backgroundBlurEnabled);
  });
  cameraWindow.setContentProtection(true);
  cameraWindow.setSkipTaskbar(true);
  cameraWindow.setVisibleOnAllWorkspaces(true);
  cameraWindow.loadURL(`http://localhost:${PORT}/camera`);
  cameraWindow.on("closed", () => {
    cameraWindow = null;
  });
}

function createControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) return;

  const controlsWidth = CONTROLS_WIDTH_NORMAL;
  const controlsBounds = getControlsWindowBounds(controlsWidth);

  controlsWindow = new BrowserWindow({
    width: controlsBounds.width,
    height: controlsBounds.height,
    x: controlsBounds.x,
    y: controlsBounds.y,
    frame: false,
    transparent: true,
    roundedCorners: false,
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

function getDefaultCameraOffset(area) {
  return {
    x: OVERLAY_UI_MARGIN,
    y: area.height - OVERLAY_UI_MARGIN - CONTROLS_WINDOW_HEIGHT - OVERLAY_UI_GAP - cameraSize,
  };
}

function clampCameraOffset(offset, area) {
  return {
    x: Math.min(Math.max(Math.round(offset.x), 0), Math.max(0, area.width - cameraSize)),
    y: Math.min(Math.max(Math.round(offset.y), 0), Math.max(0, area.height - cameraSize)),
  };
}

function getCameraWindowBounds() {
  const area = getUiWorkArea();
  const offset = clampCameraOffset(cameraOffset || getDefaultCameraOffset(area), area);
  return {
    x: area.x + offset.x,
    y: area.y + offset.y,
    width: cameraSize,
    height: cameraSize,
  };
}

// The controls bar tracks the camera bubble: centred under it when there is
// room, flipped above it when the bubble sits at the bottom edge.
function getControlsWindowBounds(controlsWidth) {
  const area = getUiWorkArea();
  const cameraBounds = getCameraWindowBounds();
  const minX = area.x + OVERLAY_UI_MARGIN;
  const maxX = area.x + area.width - OVERLAY_UI_MARGIN - controlsWidth;
  const centeredX = cameraBounds.x + Math.round((cameraBounds.width - controlsWidth) / 2);

  const minY = area.y + OVERLAY_UI_MARGIN;
  const maxY = area.y + area.height - OVERLAY_UI_MARGIN - CONTROLS_WINDOW_HEIGHT;
  const below = cameraBounds.y + cameraBounds.height + OVERLAY_UI_GAP;
  const above = cameraBounds.y - OVERLAY_UI_GAP - CONTROLS_WINDOW_HEIGHT;
  const preferredY = below <= maxY ? below : above >= minY ? above : maxY;

  return {
    x: Math.min(Math.max(centeredX, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(preferredY, minY), Math.max(minY, maxY)),
    width: controlsWidth,
    height: CONTROLS_WINDOW_HEIGHT,
  };
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
    roundedCorners: false,
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
  const maxScaleFactor = Math.max(
    1,
    ...screen.getAllDisplays().map((d) => Number(d?.scaleFactor) || 1),
  );
  drawOverlayWindow.loadFile(path.join(__dirname, "src", "views", "draw-overlay.html"), {
    query: { dpr: String(maxScaleFactor) },
  });
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

function showCameraWindow() {
  if (!cameraWindow || cameraWindow.isDestroyed()) {
    createCameraWindow();
    return;
  }
  cameraWindow.setBounds(getCameraWindowBounds());
  cameraWindow.webContents.send("camera-resume");
  cameraWindow.showInactive();
  if (typeof cameraWindow.moveTop === "function") cameraWindow.moveTop();
}

function showControlsWindow() {
  if (!controlsWindow || controlsWindow.isDestroyed()) {
    createControlsWindow();
    return;
  }
  const ctrlWidth = isDrawing() ? CONTROLS_WIDTH_DRAWING : CONTROLS_WIDTH_NORMAL;
  controlsWindow.setBounds(getControlsWindowBounds(ctrlWidth));
  controlsWindow.setAlwaysOnTop(true, "screen-saver");
  controlsWindow.webContents.send("reset-recording-timer");
  controlsWindow.show();
  if (typeof controlsWindow.moveTop === "function") controlsWindow.moveTop();
}

function hideCameraWindow() {
  if (!cameraWindow || cameraWindow.isDestroyed()) return;
  // Tell the renderer to release the device *before* hiding, so the message is
  // handled while the window is still visible and unthrottled.
  cameraWindow.webContents.send("camera-suspend");
  cameraWindow.hide();
}

function hideControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.hide();
}

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
  controlsWindow.setBounds(getControlsWindowBounds(width));
  raiseOverlayUiWindows();
}

function repositionUiWindows() {
  const cameraBounds = getCameraWindowBounds();

  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.setBounds(cameraBounds);
  }

  if (controlsWindow && !controlsWindow.isDestroyed()) {
    const ctrlWidth = isDrawing() ? CONTROLS_WIDTH_DRAWING : CONTROLS_WIDTH_NORMAL;
    controlsWindow.setBounds(getControlsWindowBounds(ctrlWidth));
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
ipcMain.on("open-setup", () => {
  openSetupWindow();
});

ipcMain.handle("setup-get-state", () => ({
  appId: getAppId(),
  configPath: userConfigEnvPath(),
  firstRun: !mainWindow || mainWindow.isDestroyed(),
}));

ipcMain.handle("setup-save-app-id", (_event, value) => {
  const appId = typeof value === "string" ? value.trim() : "";
  if (!isValidAppId(appId)) {
    return { ok: false, error: "Das ist keine gültige App-ID (Format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)." };
  }
  if (uploadInProgress) {
    return { ok: false, error: "Ein Upload läuft noch. Bitte warte, bis er fertig ist." };
  }

  try {
    saveAppId(appId);
  } catch (error) {
    return { ok: false, error: `Speichern fehlgeschlagen: ${error.message}` };
  }
  setAppId(appId);

  // The Loom SDK reads the app ID once at startup, so the main window has to
  // reload to pick up a new one.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.reload();
  } else {
    createWindow();
  }
  setupWindow?.close();
  return { ok: true };
});

ipcMain.on("setup-open-developer-portal", () => {
  shell.openExternal(LOOM_DEVELOPER_PORTAL_URL);
});

ipcMain.on("setup-cancel", () => {
  setupWindow?.close();
});

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

ipcMain.on("set-desktop-audio", (_, enabled) => {
  desktopAudioEnabled = !!enabled;
  saveUiSettings();
  syncSettingsEverywhere();
});

ipcMain.handle("get-desktop-audio", () => {
  return !!desktopAudioEnabled;
});

ipcMain.on("set-capture-quality", (_, value) => {
  captureQuality = normalizeCaptureQuality(value);
  saveUiSettings();
  syncSettingsEverywhere();
});

ipcMain.handle("get-capture-quality", () => {
  return captureQuality;
});

ipcMain.on("upload-in-progress", (_, inProgress) => {
  uploadInProgress = !!inProgress;
});

ipcMain.on("recording-started", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindowBounds = mainWindow.getBounds();
  mainWindow.hide();
  showCameraWindow();
  showControlsWindow();
  registerRecordingShortcuts();
});

ipcMain.on("recording-stopped", () => {
  unregisterRecordingShortcuts();
  hideCameraWindow();
  hideControlsWindow();
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

// ── Camera bubble dragging ────────────────────────────────────────────────────
// `-webkit-app-region: drag` is unreliable for transparent, toolbar-type
// windows on X11, so the camera window drives its own move: the renderer
// reports screen-space pointer deltas (pointer capture keeps them coming even
// when the cursor outruns the 200px window) and the main process applies them.

// Resizing keeps the bubble's centre where it is, which is what the eye
// expects when scrolling over it, then clamps the result back into the work
// area so it cannot grow off-screen.
function setCameraSize(nextSize) {
  const area = getUiWorkArea();
  const previous = cameraSize;
  const resolved = normalizeCameraSize(nextSize);
  if (resolved === previous) return cameraSize;

  const current = cameraOffset || getDefaultCameraOffset(area);
  const delta = (previous - resolved) / 2;
  cameraSize = resolved;
  cameraOffset = clampCameraOffset({ x: current.x + delta, y: current.y + delta }, area);

  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.setBounds(getCameraWindowBounds());
  }
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    const ctrlWidth = isDrawing() ? CONTROLS_WIDTH_DRAWING : CONTROLS_WIDTH_NORMAL;
    controlsWindow.setBounds(getControlsWindowBounds(ctrlWidth));
  }
  raiseOverlayUiWindows();
  return cameraSize;
}

function moveCameraToOffset(offset) {
  const area = getUiWorkArea();
  cameraOffset = clampCameraOffset(offset, area);

  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.setPosition(area.x + cameraOffset.x, area.y + cameraOffset.y);
  }
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    const ctrlWidth = isDrawing() ? CONTROLS_WIDTH_DRAWING : CONTROLS_WIDTH_NORMAL;
    const { x, y } = getControlsWindowBounds(ctrlWidth);
    controlsWindow.setPosition(x, y);
  }
}

ipcMain.on("camera-drag-start", () => {
  if (!cameraWindow || cameraWindow.isDestroyed()) return;
  const area = getUiWorkArea();
  const bounds = cameraWindow.getBounds();
  cameraDragOrigin = { x: bounds.x - area.x, y: bounds.y - area.y };
});

ipcMain.on("camera-drag-move", (_event, delta) => {
  if (!cameraDragOrigin) return;
  const dx = Number(delta?.dx) || 0;
  const dy = Number(delta?.dy) || 0;
  moveCameraToOffset({ x: cameraDragOrigin.x + dx, y: cameraDragOrigin.y + dy });
});

ipcMain.on("camera-drag-end", () => {
  if (!cameraDragOrigin) return;
  cameraDragOrigin = null;
  saveUiSettings();
  raiseOverlayUiWindows();
});

ipcMain.on("camera-reset-position", () => {
  cameraDragOrigin = null;
  cameraOffset = null;
  cameraSize = CAMERA_SIZE_DEFAULT;
  saveUiSettings();
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.setBounds(getCameraWindowBounds());
  }
  repositionUiWindows();
  notifyCameraSizeChanged();
});

// Scroll wheel over the bubble. The renderer sends the direction; the step
// lives here so the dropdown and the wheel cannot drift apart.
ipcMain.on("camera-size-step", (_event, direction) => {
  const step = Number(direction) > 0 ? CAMERA_SIZE_STEP : -CAMERA_SIZE_STEP;
  setCameraSize(cameraSize + step);
  saveUiSettings();
  notifyCameraSizeChanged();
});

ipcMain.handle("get-camera-size", () => cameraSize);

ipcMain.handle("set-camera-size", (_event, value) => {
  setCameraSize(value);
  saveUiSettings();
  return cameraSize;
});

ipcMain.handle("get-background-blur", () => backgroundBlurEnabled);

ipcMain.on("set-background-blur", (_event, enabled) => {
  backgroundBlurEnabled = !!enabled;
  saveUiSettings();
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.webContents.send("background-blur-changed", backgroundBlurEnabled);
  }
});

// Keeps the main window's dropdown in sync when the wheel or a reset changes
// the size behind its back.
function notifyCameraSizeChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("camera-size-changed", cameraSize);
  }
}

// Forward drawing tool settings from controls window to draw overlay
for (const channel of ["draw-tool-changed", "draw-color-changed", "draw-size-changed"]) {
  ipcMain.on(channel, (_, value) => {
    if (isDrawing()) drawOverlayWindow.webContents.send(channel, value);
  });
}

// Handle window.open() calls from within Loom SDK iframes
// The capture override is injected into our own page and into the Loom SDK's
// iframes on every frame load.
//
// This used to attach a CDP debugger and register the script with
// Page.addScriptToEvaluateOnNewDocument, on the theory that running before any
// page script stops the SDK from caching the original getDisplayMedia. That
// never actually worked here: the registration reports success and the script
// never runs — at window construction it is lost when the initial target is
// swapped for the real document, and registering it later cannot reach frames
// that already exist. Every override in practice came from the injection
// below, so the debugger attach was pure cost and is gone.
//
// Injecting after frame load is fine in practice because getDisplayMedia is
// only called on user action, long after the override is in place.
function installCaptureOverride(contents) {
  if (!getCaptureOverrideScript()) return;

  contents.on("did-frame-finish-load", () => {
    injectCaptureScriptIntoFrames(contents);
  });
  injectCaptureScriptIntoFrames(contents);
}

function injectCaptureScriptIntoFrames(contents) {
  if (!contents || contents.isDestroyed()) return;
  const captureScript = getCaptureOverrideScript();
  if (!captureScript) return;

  // The override's own __capturedeskApplied guard makes a repeat injection a
  // no-op, while the settings sync that follows it always applies the current
  // values. Both go in one script so a frame load costs one round-trip.
  const script = `${captureScript}${getSettingsSyncScript()}`;

  try {
    const mainFrame = contents.mainFrame;
    if (!mainFrame) return;
    for (const frame of mainFrame.framesInSubtree) {
      // Only our own page and Loom-origin frames consume the override.
      if (frame !== mainFrame && !isLoomUrl(frame.url || "")) continue;
      frame.executeJavaScript(script).catch(() => {});
    }
  } catch { /* WebContents may already be destroyed */ }
}

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

  // `opener` is set only for window.open() popups — the windows we create
  // ourselves have none, so this separates the two without relying on
  // construction order. A Loom popup gets the override too; anything else
  // (OAuth pages and the like) never captures and is left alone.
  if (contents.opener) {
    contents.on("did-frame-finish-load", () => {
      if (isLoomUrl(contents.getURL() || "")) injectCaptureScriptIntoFrames(contents);
    });
  }
});

app.whenReady().then(() => {
  loadUiSettings();

  // Invalidate display-derived caches when the topology changes. The capture
  // override script bakes in the display sizes, so a stale copy would upscale
  // to a monitor that is no longer connected.
  const invalidateDisplayCaches = () => {
    _connectorCache = null;
    _connectorLoadPromise = null;
    _captureOverrideScript = null;
  };
  screen.on("display-added", invalidateDisplayCaches);
  screen.on("display-removed", invalidateDisplayCaches);
  screen.on("display-metrics-changed", invalidateDisplayCaches);

  start(() => {
    if (getAppId()) createWindow();
    else openSetupWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    if (getAppId()) createWindow();
    else openSetupWindow();
  });
});

app.on("before-quit", (event) => {
  if (!uploadInProgress || forceCloseMainWindow) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  event.preventDefault();
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    title: "Upload laeuft noch",
    message: "Ein Upload wird gerade uebertragen.",
    detail: "Wenn du jetzt beendest, wird der Upload abgebrochen und das Video geht verloren.",
    buttons: ["Abbrechen", "Trotzdem beenden"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice === 1) {
    forceCloseMainWindow = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
