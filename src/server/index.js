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

// Binding to 127.0.0.1 keeps the LAN out, but not a web page in the user's
// browser: DNS rebinding points an attacker's hostname at 127.0.0.1, and the
// browser then treats this server as same-origin with that page. The request
// still carries the attacker's hostname in Host, so only our own names pass.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(421).end();
  }
  return next();
});

// The vendored MediaPipe runtime only changes with a dependency update, so let
// the renderer cache it instead of re-reading the 12 MB wasm on every start.
app.use(
  "/assets/vendor",
  express.static(path.join(PUBLIC_DIR, "vendor"), {
    maxAge: "1h",
    immutable: false,
  }),
);
// Everything else under /assets is our own code and changes with every update.
// maxAge 0 makes the renderer revalidate via ETag (a cheap 304), so an updated
// renderer.js is never shadowed by a stale cached copy.
app.use(
  "/assets",
  express.static(PUBLIC_DIR, {
    maxAge: 0,
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
  // Loopback only: the pages and the app ID are for this machine, not the LAN.
  app.listen(PORT, "127.0.0.1", () => {
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
