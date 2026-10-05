#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESKTOP_DIR="${HOME}/.local/share/applications"
# The installed .deb owns capturedesk.desktop. A user entry with the same id
# would shadow it, so the launcher for this checkout gets its own id.
DESKTOP_FILE="${DESKTOP_DIR}/capturedesk-dev.desktop"
USER_DESKTOP_DIR="${HOME}/Desktop"
USER_DESKTOP_FILE="${USER_DESKTOP_DIR}/capturedesk-dev.desktop"
ICON_THEME_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
ICON_THEME_FILE="${ICON_THEME_DIR}/capturedesk.svg"

# Remove launchers from earlier versions of this script, which used the ids
# capturedesk.desktop and CaptureDesk.desktop. Only entries that start this
# script are touched.
for legacy in "${DESKTOP_DIR}/capturedesk.desktop" "${DESKTOP_DIR}/CaptureDesk.desktop" "${USER_DESKTOP_DIR}/CaptureDesk.desktop"; do
  if [[ -f "${legacy}" ]] && grep -q "scripts/launch-desktop.sh" "${legacy}"; then
    rm -f "${legacy}"
    echo "Removed old launcher: ${legacy}"
  fi
done

mkdir -p "${DESKTOP_DIR}"
mkdir -p "${ICON_THEME_DIR}"

cp "${ROOT_DIR}/assets/capturedesk.svg" "${ICON_THEME_FILE}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=CaptureDesk (Dev)
Comment=Launch CaptureDesk from ${ROOT_DIR}
Exec=${ROOT_DIR}/scripts/launch-desktop.sh
Icon=capturedesk
Path=${ROOT_DIR}
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=capturedesk
EOF

chmod +x "${ROOT_DIR}/scripts/launch-desktop.sh"
chmod +x "${DESKTOP_FILE}"

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
