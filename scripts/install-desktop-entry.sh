#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${DESKTOP_DIR}/capturedesk.desktop"
USER_DESKTOP_DIR="${HOME}/Desktop"
USER_DESKTOP_FILE="${USER_DESKTOP_DIR}/CaptureDesk.desktop"

mkdir -p "${DESKTOP_DIR}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=CaptureDesk
Comment=Launch the CaptureDesk Electron app
Exec=${ROOT_DIR}/scripts/launch-desktop.sh
Icon=${ROOT_DIR}/assets/capturedesk.svg
Path=${ROOT_DIR}
Terminal=false
Categories=Utility;
StartupNotify=true
EOF

chmod +x "${ROOT_DIR}/scripts/launch-desktop.sh"
chmod +x "${DESKTOP_FILE}"

if [ -d "${USER_DESKTOP_DIR}" ]; then
  cp "${DESKTOP_FILE}" "${USER_DESKTOP_FILE}"
  chmod +x "${USER_DESKTOP_FILE}"
  if command -v gio >/dev/null 2>&1; then
    gio set "${USER_DESKTOP_FILE}" metadata::trusted true || true
  fi
  echo "Installed desktop icon: ${USER_DESKTOP_FILE}"
fi

echo "Installed desktop launcher: ${DESKTOP_FILE}"
