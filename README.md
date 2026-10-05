# CaptureDesk

Electron desktop app for screen recording with the Loom Record SDK, a custom drawing overlay, and a lightweight local Express backend.

> CaptureDesk is an independent project. It is not affiliated with, endorsed by, or supported by Loom, Inc. or Atlassian. "Loom" is a trademark of its respective owner.

## Table of Contents

- [Quickstart](#quickstart)
- [Usage](#usage)
- [Additional Information](#additional-information)
- [License](#license)

## Quickstart

### Requirements

- Node.js and npm
- Linux desktop environment
- Your own Loom developer app (app ID and private key). Using the Loom SDK means accepting the [Loom SDK Beta Agreement](http://cdn.loom.com/assets/marketing/sdk-beta-agreement.pdf).

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
   PORT=8090
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
- `npm run dist:deb` builds a Debian/Ubuntu package in `release/`

Install the `.deb` and put your credentials where the installed app looks for them:

```bash
sudo apt install ./release/capturedesk_1.0.0_amd64.deb
mkdir -p ~/.config/CaptureDesk
cp example.env ~/.config/CaptureDesk/.env   # then fill in app_id and private_key
```

The app is installed to `/opt/CaptureDesk` and shows up in the application menu. Remove it with `sudo apt remove capturedesk`. `~/.config/CaptureDesk/.env` (or `$XDG_CONFIG_HOME/CaptureDesk/.env`) takes precedence over any other `.env`.

Packaged builds contain the proprietary Loom SDK. The Loom SDK Beta Agreement does not allow redistributing it, so build them for your own use only and do not publish them (for example as GitHub releases).

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
- `PORT`: optional, defaults to `8080` (valid range: `1-65535`)

### Relevant scripts

- `npm run electron` — run the app locally
- `npm run desktop:install` — install desktop launcher files
- `npm run pack` — create unpacked Electron output
- `npm run dist` — build AppImage output

### Notes

- `.env` is intentionally ignored by git.
- `release/` contains generated build artifacts and should not be committed.
- If an AppImage does not start on Ubuntu, install FUSE support (`libfuse2` or `libfuse2t64` depending on your system).

## License

The CaptureDesk source code is released under the [MIT License](LICENSE).

This license does not cover third-party components. The Loom Record SDK is proprietary and is not included in this repository. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.
