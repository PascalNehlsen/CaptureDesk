#!/usr/bin/env bash
# Copies the MediaPipe WASM runtime out of node_modules into src/public so the
# camera window can load it over http://localhost. The runtime is ~12 MB and
# already comes with `npm install`, so it is kept out of git and re-synced here
# instead. The segmentation model itself is committed (250 KB) so the app works
# without network access.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT_DIR}/node_modules/@mediapipe/tasks-vision"
DEST="${ROOT_DIR}/src/public/vendor/tasks-vision"

if [[ ! -d "${SRC}" ]]; then
  echo "sync-vendor-assets: @mediapipe/tasks-vision not installed — run npm install" >&2
  exit 1
fi

mkdir -p "${DEST}"
# SIMD build only: Electron's Chromium always has WebAssembly SIMD, so the
# nosimd fallback would be 11 MB of dead weight.
cp "${SRC}/vision_bundle.mjs" "${DEST}/"
cp "${SRC}/wasm/vision_wasm_internal.js" "${DEST}/"
cp "${SRC}/wasm/vision_wasm_internal.wasm" "${DEST}/"

echo "sync-vendor-assets: synced $(du -sh "${DEST}" | cut -f1) to ${DEST}"
