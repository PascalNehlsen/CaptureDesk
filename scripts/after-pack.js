// electron-builder afterPack hook: puts scripts/capturedesk-launch.sh in front
// of the Electron binary on Linux. electron-builder does not allow overriding
// Exec in the desktop entry, so the launcher takes over the executable's name.
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const executableName = context.packager.executableName;
  const appOutDir = context.appOutDir;
  const binary = path.join(appOutDir, executableName);

  fs.renameSync(binary, path.join(appOutDir, `${executableName}-bin`));
  fs.copyFileSync(path.join(__dirname, "capturedesk-launch.sh"), binary);
  fs.chmodSync(binary, 0o755);

  const helper = path.join(appOutDir, "notify-startup-complete.py");
  fs.copyFileSync(path.join(__dirname, "notify-startup-complete.py"), helper);
  fs.chmodSync(helper, 0o755);
};
