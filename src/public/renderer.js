window.global = window;

(function bootstrapLoom() {
  const recordButton = document.querySelector("#record-button");
  const statusElement = document.querySelector("#status");
  const debugLogElement = document.querySelector("#debug-log");

  function appendLog(message, detail) {
    const parts = [message];

    if (detail !== undefined) {
      parts.push(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    }

    const line = parts.join(" ");
    console.log("[loom app]", line);
    debugLogElement.textContent = `${line}\n${debugLogElement.textContent}`.trim();
  }

  function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", isError);
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

  async function fetchLoomConfig() {
    const response = await fetch("/api/loom-token", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Failed to fetch Loom credentials (${response.status})`);
    }

    return response.json();
  }

  async function initializeLoom() {
    const sdk = window.loomSdk;
    const isSupported =
      window.loomSdkIsSupported ||
      (sdk && typeof sdk.isSupported === "function" ? sdk.isSupported.bind(sdk) : null);

    if (!sdk || typeof sdk.setup !== "function" || typeof isSupported !== "function") {
      throw new Error("Loom SDK did not load correctly.");
    }

    setStatus("Checking Loom support…");
    const { supported, error } = isSupported();

    if (!supported) {
      throw new Error(`Loom is not supported in this environment: ${error}`);
    }

    setStatus("Fetching Loom credentials…");
    const { appId, environment } = await fetchLoomConfig();

    if (!appId) {
      throw new Error("Missing Loom app ID from backend.");
    }

    setStatus("Initializing Loom recorder…");
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

    // Single configureButton call — the returned instance becomes the activeButton
    // when the user starts recording, so endRecording() will work correctly.
    const sdkButton = configureButton({
      element: recordButton,
      hooks: {
        onCancel: () => {
          setStatus("Recording cancelled.");
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onComplete: () => {
          setStatus("Recording complete.");
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onInsertClicked: (video) => appendLog("Insert clicked for video", video),
        onLifecycleUpdate: (state) => {
          setStatus(`Recorder state: ${state}`);
        },
        onRecordingComplete: (video) => {
          appendLog("Recording complete", video);
          if (window.electronAPI) window.electronAPI.sendRecordingStopped();
        },
        onRecordingStarted: () => {
          setStatus("Recording started.");
          if (window.electronAPI) window.electronAPI.sendRecordingStarted();
        },
        onUploadComplete: (video) => {
          setStatus("Upload complete.");
          appendLog("Upload complete", video);
        },
      },
    });

    // Listen for stop-recording command from controls window (or keyboard shortcut)
    if (window.electronAPI && typeof window.electronAPI.onStopRecording === "function") {
      window.electronAPI.onStopRecording(() => {
        setStatus("Stopping recording…");
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

    recordButton.disabled = false;

    setStatus("Ready to record.");
  }

  window.addEventListener("message", (event) => {
    if (!event.origin || !isLoomOrigin(event.origin)) {
      return;
    }

    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data).slice(0, 600);
    appendLog(`[loom postMessage from ${event.origin}]`, payload);
  });

  window.addEventListener("error", (event) => {
    appendLog("Renderer error", event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendLog("Unhandled promise rejection", event.reason ? String(event.reason) : "unknown");
  });

  initializeLoom().catch((error) => {
    recordButton.disabled = true;
    setStatus(error.message, true);
    appendLog("Initialization failed", error.stack || error.message);
  });
})();
