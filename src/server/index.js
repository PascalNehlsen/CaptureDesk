const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const express = require("express");
const { isValidAppId, userConfigEnvPath } = require("./user-config");

function resolveDotenvPath() {
  const userEnvPath = userConfigEnvPath();
  if (fs.existsSync(userEnvPath)) {
    return userEnvPath;
  }

  const baseDirs = [
    path.resolve(__dirname, "../../"),
    process.cwd(),
    process.resourcesPath,
    path.dirname(process.execPath),
    process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : null,
  ].filter(Boolean);

  const seen = new Set();
  for (const baseDir of baseDirs) {
    let currentDir = path.resolve(baseDir);
    while (!seen.has(currentDir)) {
      seen.add(currentDir);
      const envPath = path.join(currentDir, ".env");
      if (fs.existsSync(envPath)) {
        return envPath;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  return null;
}

const dotenvPath = resolveDotenvPath();
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
  console.log(`Loaded environment from ${dotenvPath}`);
} else {
  console.warn("No .env file found. Falling back to process environment.");
}

// Pull Loom app configuration from env
let appId = isValidAppId(process.env.app_id) ? process.env.app_id.trim() : null;
const LOOM_ENVIRONMENT = process.env.loom_environment || "production";
const parsedPort = Number.parseInt(process.env.PORT, 10);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(
  "/assets",
  express.static(PUBLIC_DIR, {
    // Everything under /assets is content-addressed by release, so let the
    // renderer cache it instead of re-reading the 12 MB wasm on every start.
    maxAge: "1h",
    immutable: false,
  }),
);

app.get("/", (_, res) => {
  return res.render("index");
});

// The camera overlay is served over http rather than loaded from disk: it
// pulls the MediaPipe WASM runtime for background blur, and fetching wasm from
// a file:// origin is blocked. localhost counts as a secure context, so
// getUserMedia keeps working.
app.get("/camera", (_, res) => {
  return res.sendFile(path.join(__dirname, "../views/camera.html"));
});

app.get("/api/loom-token", async (_, res, next) => {
  try {
    if (!appId) {
      throw new Error("Missing Loom app ID. Set it in the setup window or in .env.");
    }

    res.json({
      appId,
      environment: LOOM_ENVIRONMENT,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Failed to handle request:", error);
  res.status(500).json({ error: error.message });
});

function start(callback) {
  app.listen(PORT, () => {
    console.log(`Example app listening at http://localhost:${PORT}`);
    if (callback) callback();
  });
}

if (require.main === module) {
  start();
}

function getAppId() {
  return appId;
}

// Called by the setup window once it has saved a new app ID.
function setAppId(value) {
  if (!isValidAppId(value)) throw new Error("Invalid Loom app ID.");
  appId = value.trim();
}

module.exports = { start, PORT, getAppId, setAppId };
