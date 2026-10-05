const fs = require("fs");
const os = require("os");
const path = require("path");

// Loom public app IDs are UUIDs. Anything else (empty, the example.env
// placeholder, a pasted private key) counts as "not configured".
const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidAppId(value) {
  return typeof value === "string" && APP_ID_PATTERN.test(value.trim());
}

// Installed builds (e.g. the .deb in /opt) read their config from here, and the
// setup window writes to it.
function userConfigEnvPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "CaptureDesk", ".env");
}

// Sets app_id in the user config file and keeps every other line as it is.
function saveAppId(appId) {
  const envPath = userConfigEnvPath();
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, "utf8").split("\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const entry = `app_id="${appId.trim()}"`;
  const index = lines.findIndex((line) => /^\s*app_id\s*=/.test(line));
  if (index === -1) {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(entry);
  } else {
    lines[index] = entry;
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return envPath;
}

module.exports = { isValidAppId, saveAppId, userConfigEnvPath };
