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

exec env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron . "${SANDBOX_ARGS[@]}" "${OZONE_ARGS[@]}" --disable-gpu-sandbox --disable-software-rasterizer
