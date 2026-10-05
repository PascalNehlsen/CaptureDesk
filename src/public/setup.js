(() => {
  const form = document.getElementById("setup-form");
  const input = document.getElementById("app-id");
  const errorEl = document.getElementById("error");
  const configPathEl = document.getElementById("config-path");
  const saveBtn = document.getElementById("save-btn");
  const cancelBtn = document.getElementById("cancel-btn");

  function showError(message) {
    errorEl.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  window.setupAPI.getState().then(({ appId, configPath, firstRun }) => {
    input.value = appId || "";
    configPathEl.textContent = `Wird gespeichert in ${configPath}`;
    if (firstRun) cancelBtn.textContent = "Beenden";
    input.focus();
    input.select();
  });

  document.getElementById("portal-link").addEventListener("click", () => {
    window.setupAPI.openDeveloperPortal();
  });

  cancelBtn.addEventListener("click", () => window.setupAPI.cancel());

  input.addEventListener("input", () => showError(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      const result = await window.setupAPI.saveAppId(input.value);
      if (!result.ok) showError(result.error);
    } finally {
      saveBtn.disabled = false;
    }
  });
})();
