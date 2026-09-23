# Third-Party Notices

The MIT license in [`LICENSE`](LICENSE) covers only the code written for CaptureDesk. Third-party components keep their own licenses.

## Included in this repository

### MediaPipe Selfie Segmenter model

- File: `src/public/vendor/models/selfie_segmenter.tflite`
- Source: [Google MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter)
- License: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- Copyright: Google LLC

The file is redistributed unmodified.

## Installed via npm (not included in this repository)

### Loom Record SDK (`@loomhq/record-sdk`, `@loomhq/loom-embed`)

- Proprietary software by Loom, Inc., licensed under the [Loom SDK Beta Agreement](http://cdn.loom.com/assets/marketing/sdk-beta-agreement.pdf).
- The SDK is **not** part of this repository and is not covered by its MIT license. `npm install` downloads it from npm, and `npm run vendor:sync` bundles it locally into `src/public/loom-sdk-browser.js` / `.css` (both git-ignored).
- Anyone who uses CaptureDesk needs their own Loom developer app and must accept Loom's terms.

### MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)

- License: Apache License 2.0, Copyright Google LLC.
- `npm run vendor:sync` copies the WASM runtime locally into `src/public/vendor/tasks-vision/` (git-ignored).

### Other npm dependencies

Express, EJS, dotenv, Electron, and the other dependencies in `package.json` are distributed under their own permissive open-source licenses (MIT, Apache-2.0, ISC). See each package in `node_modules/` for details.
