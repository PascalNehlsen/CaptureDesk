window.global = window;

(function bootstrapApp() {
  // ── DOM references ──────────────────────────────────────────────────────────
  const recordButton = document.getElementById("record-button");
  const recordContainer = document.getElementById("record-container");
  const statusElement = document.getElementById("status");
  const statusBadge = document.getElementById("status-badge");
  const debugLogElement = document.getElementById("debug-log");
  const consoleToggle = document.getElementById("console-toggle");
  const consoleChevron = document.getElementById("console-chevron");
  const monitorSelect = document.getElementById("monitor-select");
  const desktopAudioToggle = document.getElementById("desktop-audio-toggle");
  const captureQualitySelect = document.getElementById("capture-quality-select");
  const cameraSizeSelect = document.getElementById("camera-size-select");
  const backgroundBlurToggle = document.getElementById("background-blur-toggle");
  const loomAppIdButton = document.getElementById("loom-app-id-btn");

  // ── Window controls (frameless title bar) ───────────────────────────────────
  document.getElementById("btn-minimize")?.addEventListener("click", () => {
    if (window.electronAPI?.minimizeWindow) window.electronAPI.minimizeWindow();
  });
  document.getElementById("btn-maximize")?.addEventListener("click", () => {
    if (window.electronAPI?.maximizeWindow) window.electronAPI.maximizeWindow();
  });
  document.getElementById("btn-close")?.addEventListener("click", () => {
    if (window.electronAPI?.closeWindow) window.electronAPI.closeWindow();
  });

  // ── Console toggle ──────────────────────────────────────────────────────────
  consoleToggle.addEventListener("click", () => {
    const isOpen = debugLogElement.classList.toggle("open");
    consoleChevron.classList.toggle("open", isOpen);
  });

  // ── Logging & status ────────────────────────────────────────────────────────
  function appendLog(message, detail) {
    const parts = [message];
    if (detail !== undefined) {
      parts.push(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    }
    const line = parts.join(" ");
    console.log("[loom app]", line);
    debugLogElement.textContent = `${line}\n${debugLogElement.textContent}`.trim();
  }

  function setStatus(message, state = "loading") {
    statusElement.textContent = message;
    statusBadge.className = "status-badge " + state;
    recordContainer.classList.toggle("ready", state === "ready");
  }

  function getDisplayLabel(display) {
    if (!display) return "Monitor";
    const baseName = display.name || (typeof display.index === "number" ? `Monitor ${display.index + 1}` : "Monitor");
    const size = display.width && display.height ? ` (${display.width}x${display.height})` : "";
    const primary = display.primary ? " - Primaer" : "";
    return `${baseName}${size}${primary}`;
  }

  async function populateMonitorSelector() {
    if (!monitorSelect || !window.electronAPI?.getUiDisplays || !window.electronAPI?.getPreferredUiDisplay) {
      if (monitorSelect) monitorSelect.disabled = true;
      return;
    }

    try {
      const [displays, preferredId] = await Promise.all([
        window.electronAPI.getUiDisplays(),
        window.electronAPI.getPreferredUiDisplay(),
      ]);

      monitorSelect.innerHTML = "";
      const validDisplays = Array.isArray(displays) ? displays : [];

      for (const display of validDisplays) {
        const option = document.createElement("option");
        option.value = String(display.id);
        option.textContent = getDisplayLabel(display);
        if (String(display.id) === String(preferredId)) {
          option.selected = true;
        }
        monitorSelect.appendChild(option);
      }

      monitorSelect.disabled = validDisplays.length <= 1;
    } catch (error) {
      monitorSelect.disabled = true;
      appendLog("Monitor list could not be loaded", error.message || String(error));
    }
  }

  function isLoomOrigin(origin) {
    try {
      const { hostname } = new URL(origin);
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

  // ── Loom SDK init ───────────────────────────────────────────────────────────
  async function fetchLoomConfig() {
    const response = await fetch("/api/loom-token", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch Loom credentials (${response.status})`);
    }
    return response.json();
  }

  // Kick off the credentials request immediately so it runs in parallel with
  // SDK parsing / UI initialisation — `initializeLoom` awaits it when ready.
  const loomConfigPromise = fetchLoomConfig();
  loomConfigPromise.catch(() => {}); // prevent unhandledrejection before init consumes it

  async function initializeLoom() {
    const sdk = window.loomSdk;
    const isSupported =
      window.loomSdkIsSupported ||
      (sdk && typeof sdk.isSupported === "function" ? sdk.isSupported.bind(sdk) : null);

    if (!sdk || typeof sdk.setup !== "function" || typeof isSupported !== "function") {
      throw new Error("Loom SDK did not load correctly.");
    }

    setStatus("Checking Loom support…", "loading");
    const { supported, error } = isSupported();
    if (!supported) {
      throw new Error(`Loom is not supported in this environment: ${error}`);
    }

    setStatus("Fetching credentials…", "loading");
    const { appId, environment } = await loomConfigPromise;
    if (!appId) {
      throw new Error("Missing Loom app ID from backend.");
    }

    setStatus("Initializing recorder…", "loading");
    const init =
      typeof sdk.createInstance === "function"
        ? sdk.createInstance.bind(sdk)
        : typeof sdk.setup === "function"
          ? sdk.setup.bind(sdk)
          : null;

    if (!init) {
      throw new Error("Loom SDK init method not available.");
    }

    const { configureButton } = await init({
      environment,
      mode: "standard",
      publicAppId: appId,
      config: {
        allowedRecordingTypes: ["screen"],
        defaultRecordingType: "screen",
      },
    });

    let uploadInProgress = false;
    let uploadStartTs = 0;
    const setUploadInProgress = (value, video) => {
      const next = !!value;
      if (next === uploadInProgress) return;
      uploadInProgress = next;
      if (next) {
        uploadStartTs = Date.now();
        appendLog(`[upload] started at ${new Date(uploadStartTs).toISOString()} for video`, video?.id || "?");
      } else {
        const ms = uploadStartTs ? Date.now() - uploadStartTs : 0;
        appendLog(`[upload] ended after ${(ms / 1000).toFixed(1)}s for video`, video?.id || "?");
        uploadStartTs = 0;
      }
      window.electronAPI?.sendUploadInProgress?.(next);
    };

    const sdkButton = configureButton({
      element: recordButton,
      hooks: {
        onCancel: () => {
          setStatus("Recording cancelled.", "ready");
          setUploadInProgress(false);
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onComplete: () => {
          setStatus("Recording complete.", "ready");
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onInsertClicked: (video) => appendLog("Insert clicked for video", video),
        onLifecycleUpdate: (state) => {
          setStatus(`Recorder: ${state}`, "loading");
        },
        onRecordingComplete: (video) => {
          appendLog("Recording complete", video);
          setUploadInProgress(true, video);
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onRecordingStarted: () => {
          setStatus("Recording…", "loading");
          if (window.electronAPI) window.electronAPI.sendRecordingStarted();
        },
        onUploadComplete: (video) => {
          setStatus("Upload complete.", "ready");
          appendLog("Upload complete", video);
          setUploadInProgress(false, video);
        },
      },
    });

    if (window.electronAPI && typeof window.electronAPI.onStopRecording === "function") {
      window.electronAPI.onStopRecording(() => {
        setStatus("Stopping…", "loading");
        if (typeof sdkButton.endRecording === "function") {
          try {
            sdkButton.endRecording();
          } catch (err) {
            appendLog("endRecording() threw", err.message);
          }
        } else {
          appendLog("endRecording not available on sdkButton");
        }
      });
    }

    if (window.electronAPI && typeof window.electronAPI.onPauseRecording === "function") {
      window.electronAPI.onPauseRecording(() => {
        try {
          sdkButton.store.dispatch({ type: "consumer_trigger/toggle_pause_recording" });
        } catch (err) {
          appendLog("togglePauseRecording dispatch threw", err.message);
        }
      });
    }

    // Forward pause state changes from the SDK store to the controls window
    if (sdkButton.store && typeof sdkButton.store.subscribe === "function") {
      let lastPauseState = false;
      sdkButton.store.subscribe(() => {
        try {
          const state = sdkButton.store.getState();
          const isPaused = !!(state && state.recorder && state.recorder.appStage === "paused");
          if (isPaused !== lastPauseState) {
            lastPauseState = isPaused;
            if (window.electronAPI && typeof window.electronAPI.sendRecordingPauseState === "function") {
              window.electronAPI.sendRecordingPauseState(isPaused);
            }
          }
        } catch (err) {
          // Store may not be ready yet — ignore
        }
      });
    }

    recordButton.disabled = false;
    setStatus("Ready to record", "ready");
  }

  // ── Global listeners ────────────────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    if (!event.origin || !isLoomOrigin(event.origin)) return;
    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data).slice(0, 600);
    appendLog(`[loom postMessage from ${event.origin}]`, payload);
  });

  window.addEventListener("error", (event) => appendLog("Renderer error", event.message));
  window.addEventListener("unhandledrejection", (event) => {
    appendLog("Unhandled promise rejection", event.reason ? String(event.reason) : "unknown");
  });

  monitorSelect?.addEventListener("change", async () => {
    if (!window.electronAPI?.setPreferredUiDisplay) return;
    try {
      await window.electronAPI.setPreferredUiDisplay(monitorSelect.value);
    } catch (error) {
      appendLog("Failed to set UI monitor", error.message || String(error));
    }
  });

  desktopAudioToggle?.addEventListener("change", () => {
    applyDesktopAudioSetting(desktopAudioToggle.checked);
  });

  initializeDesktopAudioToggle().catch(() => {
    // Keep default checkbox state if persisted value cannot be loaded.
    if (desktopAudioToggle) applyDesktopAudioSetting(desktopAudioToggle.checked);
  });

  captureQualitySelect?.addEventListener("change", () => {
    applyCaptureQualitySetting(captureQualitySelect.value);
  });

  initializeCaptureQualitySelect().catch(() => {
    if (captureQualitySelect) applyCaptureQualitySetting(captureQualitySelect.value);
  });

  loomAppIdButton?.addEventListener("click", () => {
    window.electronAPI?.openSetup?.();
  });

  cameraSizeSelect?.addEventListener("change", async () => {
    if (!window.electronAPI?.setCameraSize) return;
    try {
      showCameraSize(await window.electronAPI.setCameraSize(cameraSizeSelect.value));
    } catch (error) {
      appendLog("Failed to set camera size", error.message || String(error));
    }
  });

  // Scrolling on the bubble changes the size behind the dropdown's back.
  if (typeof window.electronAPI?.onCameraSizeChanged === "function") {
    window.electronAPI.onCameraSizeChanged((size) => showCameraSize(size));
  }

  backgroundBlurToggle?.addEventListener("change", () => {
    window.electronAPI?.setBackgroundBlur?.(backgroundBlurToggle.checked);
  });

  initializeCameraSizeSelect().catch(() => {});
  initializeBackgroundBlurToggle().catch(() => {});

  window.addEventListener("focus", () => {
    populateMonitorSelector().catch(() => {});
  });

  if (typeof window.electronAPI?.onUiDisplaysUpdated === "function") {
    window.electronAPI.onUiDisplaysUpdated(() => {
      populateMonitorSelector().catch(() => {});
    });
  }

  populateMonitorSelector().catch(() => {});

  initializeLoom().catch((error) => {
    recordButton.disabled = true;
    setStatus(error.message, "error");
    appendLog("Initialization failed", error.stack || error.message);
  });

  function applyDesktopAudioSetting(enabled) {
    const isEnabled = !!enabled;
    window.__capturedeskAudioEnabled = isEnabled;
    window.electronAPI?.setDesktopAudio(isEnabled);
  }

  async function initializeDesktopAudioToggle() {
    if (!desktopAudioToggle) return;
    if (!window.electronAPI?.getDesktopAudio) {
      applyDesktopAudioSetting(desktopAudioToggle.checked);
      return;
    }

    const savedValue = await window.electronAPI.getDesktopAudio();
    desktopAudioToggle.checked = !!savedValue;
    applyDesktopAudioSetting(savedValue);
  }

  // The wheel over the camera bubble produces sizes between the presets, so
  // the dropdown grows a custom entry rather than silently showing a value the
  // camera does not have.
  const CAMERA_SIZE_PRESETS = ["140", "200", "280"];

  function showCameraSize(size) {
    if (!cameraSizeSelect) return;
    const value = String(size);
    let custom = cameraSizeSelect.querySelector("option[data-custom]");

    if (CAMERA_SIZE_PRESETS.includes(value)) {
      if (custom) custom.remove();
    } else {
      if (!custom) {
        custom = document.createElement("option");
        custom.dataset.custom = "true";
        cameraSizeSelect.appendChild(custom);
      }
      custom.value = value;
      custom.textContent = `Benutzerdefiniert (${value} px)`;
    }

    cameraSizeSelect.value = value;
  }

  async function initializeCameraSizeSelect() {
    if (!cameraSizeSelect || !window.electronAPI?.getCameraSize) return;
    showCameraSize(await window.electronAPI.getCameraSize());
  }

  async function initializeBackgroundBlurToggle() {
    if (!backgroundBlurToggle) return;
    if (!window.electronAPI?.getBackgroundBlur) {
      window.electronAPI?.setBackgroundBlur?.(backgroundBlurToggle.checked);
      return;
    }
    backgroundBlurToggle.checked = !!(await window.electronAPI.getBackgroundBlur());
  }

  function applyCaptureQualitySetting(value) {
    const normalized = ["fast", "balanced", "quality"].includes(value) ? value : "balanced";
    window.__capturedeskCaptureQuality = normalized;
    window.electronAPI?.setCaptureQuality?.(normalized);
  }

  async function initializeCaptureQualitySelect() {
    if (!captureQualitySelect) return;
    if (!window.electronAPI?.getCaptureQuality) {
      applyCaptureQualitySetting(captureQualitySelect.value);
      return;
    }

    const savedValue = await window.electronAPI.getCaptureQuality();
    const normalized = ["fast", "balanced", "quality"].includes(savedValue) ? savedValue : "balanced";
    captureQualitySelect.value = normalized;
    applyCaptureQualitySetting(normalized);
  }
})();
