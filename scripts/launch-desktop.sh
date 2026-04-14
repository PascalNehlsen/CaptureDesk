#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"
SANDBOX_ARGS=()
if [[ "${ELECTRON_NO_SANDBOX:-0}" == "1" ]]; then
  SANDBOX_ARGS+=(--no-sandbox)
fi

OZONE_ARGS=()
if [[ -n "${CAPTUREDESK_OZONE_PLATFORM:-}" ]]; then
  OZONE_ARGS+=(--ozone-platform="${CAPTUREDESK_OZONE_PLATFORM}")
else
  OZONE_ARGS+=(--ozone-platform=x11)
fi

COMMON_CHROMIUM_ARGS=("${SANDBOX_ARGS[@]}" "${OZONE_ARGS[@]}" --disable-gpu-sandbox --disable-software-rasterizer)

LAUNCH_TARGET="${CAPTUREDESK_LAUNCH_TARGET:-auto}"
UNPACKED_CANDIDATES=(
  "${ROOT_DIR}/release/linux-unpacked/CaptureDesk"
  "${ROOT_DIR}/release/linux-unpacked/loom-sdk-backend-auth"
)

find_unpacked_binary() {
  local candidate
  for candidate in "${UNPACKED_CANDIDATES[@]}"; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

find_appimage() {
  local appimages=("${ROOT_DIR}"/release/CaptureDesk-*.AppImage)
  if [[ ${#appimages[@]} -gt 0 && -x "${appimages[0]}" ]]; then
    echo "${appimages[0]}"
    return 0
  fi
  return 1
}

if [[ "${LAUNCH_TARGET}" == "unpacked" || "${LAUNCH_TARGET}" == "auto" ]]; then
  if UNPACKED_BIN="$(find_unpacked_binary)"; then
    exec env -u ELECTRON_RUN_AS_NODE "${UNPACKED_BIN}" "${COMMON_CHROMIUM_ARGS[@]}"
  fi
fi

if [[ "${LAUNCH_TARGET}" == "appimage" || "${LAUNCH_TARGET}" == "auto" ]]; then
  if APPIMAGE_BIN="$(find_appimage)"; then
    exec "${APPIMAGE_BIN}" "${COMMON_CHROMIUM_ARGS[@]}"
  fi
fi

if [[ "${LAUNCH_TARGET}" != "dev" && "${LAUNCH_TARGET}" != "auto" && "${LAUNCH_TARGET}" != "unpacked" && "${LAUNCH_TARGET}" != "appimage" ]]; then
  echo "Unknown CAPTUREDESK_LAUNCH_TARGET='${LAUNCH_TARGET}'. Use: auto|dev|unpacked|appimage" >&2
  exit 1
fi

exec env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron . "${COMMON_CHROMIUM_ARGS[@]}"
