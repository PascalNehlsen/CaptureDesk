#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${DESKTOP_DIR}/capturedesk.desktop"
LEGACY_DESKTOP_FILE="${DESKTOP_DIR}/CaptureDesk.desktop"
USER_DESKTOP_DIR="${HOME}/Desktop"
USER_DESKTOP_FILE="${USER_DESKTOP_DIR}/CaptureDesk.desktop"
ICON_THEME_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
ICON_THEME_FILE="${ICON_THEME_DIR}/capturedesk.svg"

mkdir -p "${DESKTOP_DIR}"
mkdir -p "${ICON_THEME_DIR}"

cp "${ROOT_DIR}/assets/capturedesk.svg" "${ICON_THEME_FILE}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=CaptureDesk
Comment=Launch the CaptureDesk Electron app
Exec=${ROOT_DIR}/scripts/launch-desktop.sh
Icon=capturedesk
Path=${ROOT_DIR}
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=CaptureDesk
EOF

chmod +x "${ROOT_DIR}/scripts/launch-desktop.sh"
chmod +x "${DESKTOP_FILE}"

# Keep a hidden legacy launcher id so existing Dash favorites continue to work
# without creating a second visible search result.
cat > "${LEGACY_DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=CaptureDesk
Comment=Launch the CaptureDesk Electron app
Exec=${ROOT_DIR}/scripts/launch-desktop.sh
Icon=capturedesk
Path=${ROOT_DIR}
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=CaptureDesk
NoDisplay=true
EOF
chmod +x "${LEGACY_DESKTOP_FILE}"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${DESKTOP_DIR}" || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" || true
fi

if [ -d "${USER_DESKTOP_DIR}" ]; then
  cp "${DESKTOP_FILE}" "${USER_DESKTOP_FILE}"
  chmod +x "${USER_DESKTOP_FILE}"
  if command -v gio >/dev/null 2>&1; then
    gio set "${USER_DESKTOP_FILE}" metadata::trusted true || true
  fi
  echo "Installed desktop icon: ${USER_DESKTOP_FILE}"
fi

echo "Installed desktop launcher: ${DESKTOP_FILE}"
echo "Installed icon theme asset: ${ICON_THEME_FILE}"
