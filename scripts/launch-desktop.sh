#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

LOG_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/capturedesk"
LOG_FILE="${LOG_DIR}/launcher.log"
mkdir -p "${LOG_DIR}"
exec >>"${LOG_FILE}" 2>&1

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] launcher invoked"
echo "PWD(before): ${PWD}"
echo "ROOT_DIR: ${ROOT_DIR}"

cd "${ROOT_DIR}"

resolve_port_from_env_file() {
  local env_file="$1"
  if [[ ! -f "${env_file}" ]]; then
    return 1
  fi

  local raw
  raw="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "${env_file}" | tail -n 1 | cut -d '=' -f 2- | tr -d "'\"[:space:]")"
  if [[ "${raw}" =~ ^[0-9]+$ ]] && (( raw >= 1 && raw <= 65535 )); then
    echo "${raw}"
    return 0
  fi
  return 1
}

if [[ -n "${CAPTUREDESK_PORT:-}" ]] && [[ "${CAPTUREDESK_PORT}" =~ ^[0-9]+$ ]] && (( CAPTUREDESK_PORT >= 1 && CAPTUREDESK_PORT <= 65535 )); then
  export PORT="${CAPTUREDESK_PORT}"
  echo "Using CAPTUREDESK_PORT: ${PORT}"
elif PORT_FROM_DOTENV="$(resolve_port_from_env_file "${ROOT_DIR}/.env")"; then
  export PORT="${PORT_FROM_DOTENV}"
  echo "Using PORT from .env: ${PORT}"
else
  echo "Using inherited/default PORT: ${PORT:-<unset>}"
fi

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

LAUNCH_TARGET="${CAPTUREDESK_LAUNCH_TARGET:-dev}"
echo "LAUNCH_TARGET: ${LAUNCH_TARGET}"
echo "COMMON_CHROMIUM_ARGS: ${COMMON_CHROMIUM_ARGS[*]}"

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

ensure_unpacked_sandbox_compat() {
  local unpacked_bin="$1"
  local sandbox_bin
  sandbox_bin="$(dirname "${unpacked_bin}")/chrome-sandbox"

  # If sandbox is explicitly requested, keep current flags unchanged.
  if [[ "${ELECTRON_NO_SANDBOX:-0}" == "1" ]]; then
    return 0
  fi

  if [[ ! -f "${sandbox_bin}" ]]; then
    return 0
  fi

  local sandbox_owner sandbox_mode
  sandbox_owner="$(stat -c '%u' "${sandbox_bin}" 2>/dev/null || echo '?')"
  sandbox_mode="$(stat -c '%a' "${sandbox_bin}" 2>/dev/null || echo '?')"

  # Electron unpacked builds commonly fail if chrome-sandbox is not root:4755.
  # Add --no-sandbox automatically so launcher works from GNOME panel.
  if [[ "${sandbox_owner}" != "0" ]] || [[ "${sandbox_mode}" != "4755" ]]; then
    COMMON_CHROMIUM_ARGS=(--no-sandbox "${COMMON_CHROMIUM_ARGS[@]}")
    echo "Added --no-sandbox (chrome-sandbox owner=${sandbox_owner}, mode=${sandbox_mode})"
  fi
}

ensure_dev_sandbox_compat() {
  local sandbox_bin="${ROOT_DIR}/node_modules/electron/dist/chrome-sandbox"

  if [[ "${ELECTRON_NO_SANDBOX:-0}" == "1" ]]; then
    return 0
  fi

  if [[ ! -f "${sandbox_bin}" ]]; then
    return 0
  fi

  local sandbox_owner sandbox_mode
  sandbox_owner="$(stat -c '%u' "${sandbox_bin}" 2>/dev/null || echo '?')"
  sandbox_mode="$(stat -c '%a' "${sandbox_bin}" 2>/dev/null || echo '?')"

  if [[ "${sandbox_owner}" != "0" ]] || [[ "${sandbox_mode}" != "4755" ]]; then
    COMMON_CHROMIUM_ARGS=(--no-sandbox "${COMMON_CHROMIUM_ARGS[@]}")
    echo "Added --no-sandbox for dev runtime (chrome-sandbox owner=${sandbox_owner}, mode=${sandbox_mode})"
  fi
}

if [[ "${LAUNCH_TARGET}" == "dev" ]]; then
  ensure_dev_sandbox_compat
  echo "Launching dev Electron runtime"
  exec env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron . "${COMMON_CHROMIUM_ARGS[@]}"
fi

if [[ "${LAUNCH_TARGET}" == "unpacked" || "${LAUNCH_TARGET}" == "auto" ]]; then
  if UNPACKED_BIN="$(find_unpacked_binary)"; then
    ensure_unpacked_sandbox_compat "${UNPACKED_BIN}"
    echo "Launching unpacked binary: ${UNPACKED_BIN}"
    exec env -u ELECTRON_RUN_AS_NODE "${UNPACKED_BIN}" "${COMMON_CHROMIUM_ARGS[@]}"
  fi
fi

if [[ "${LAUNCH_TARGET}" == "appimage" || "${LAUNCH_TARGET}" == "auto" ]]; then
  if APPIMAGE_BIN="$(find_appimage)"; then
    echo "Launching AppImage: ${APPIMAGE_BIN}"
    exec "${APPIMAGE_BIN}" "${COMMON_CHROMIUM_ARGS[@]}"
  fi
fi

if [[ "${LAUNCH_TARGET}" != "dev" && "${LAUNCH_TARGET}" != "auto" && "${LAUNCH_TARGET}" != "unpacked" && "${LAUNCH_TARGET}" != "appimage" ]]; then
  echo "Unknown CAPTUREDESK_LAUNCH_TARGET='${LAUNCH_TARGET}'. Use: auto|dev|unpacked|appimage" >&2
  exit 1
fi

echo "Launching dev Electron runtime"
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron . "${COMMON_CHROMIUM_ARGS[@]}"
