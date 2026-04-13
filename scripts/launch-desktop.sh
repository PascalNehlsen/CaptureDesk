#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron . --no-sandbox --ozone-platform=x11 --disable-gpu-sandbox --disable-software-rasterizer
