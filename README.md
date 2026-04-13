# CaptureDesk

Electron desktop app for screen recording with the Loom Record SDK, a custom drawing overlay, and a lightweight local Express backend.

## Table of Contents

- [Quickstart](#quickstart)
- [Usage](#usage)
- [Additional Information](#additional-information)

## Quickstart

### Requirements

- Node.js and npm
- Linux desktop environment
- A Loom app ID

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your local env file:
   ```bash
   cp example.env .env
   ```
3. Fill in your Loom credentials in `.env`:
   ```env
   private_key="YOUR_PEM_FROM_YOUR_LOOM_APP"
   app_id="YOUR_APP_ID"
   ```
4. Start the app in development mode:
   ```bash
   npm run electron
   ```

## Usage

### Development app

- `npm run electron` starts the Electron app and the embedded local backend.
- `npm run desktop:install` creates a desktop launcher and a desktop icon for the current project checkout.

### Packaged app

- `npm run pack` creates an unpacked build in `release/linux-unpacked/`
- `npm run dist` builds a Linux AppImage in `release/`

### Main features

- Screen recording via the Loom Record SDK
- Floating controls window
- Drawing overlay with pen, highlighter, arrow, rectangle, eraser, undo, and clear
- Optional desktop launcher via `.desktop` entry

## Additional Information

### Environment variables

- `app_id`: Loom application ID
- `private_key`: Loom private key
- `loom_environment`: optional, defaults to `production`

### Relevant scripts

- `npm run electron` — run the app locally
- `npm run desktop:install` — install desktop launcher files
- `npm run pack` — create unpacked Electron output
- `npm run dist` — build AppImage output

### Notes

- `.env` is intentionally ignored by git.
- `release/` contains generated build artifacts and should not be committed.
- If an AppImage does not start on Ubuntu, install FUSE support (`libfuse2` or `libfuse2t64` depending on your system).
