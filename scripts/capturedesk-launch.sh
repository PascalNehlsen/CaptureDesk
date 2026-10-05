#!/bin/sh
# Installed as "capturedesk" next to the Electron binary (renamed to
# capturedesk-bin by scripts/after-pack.js), so the desktop entry, the
# /usr/bin symlink and the AppImage all start through here.
#
# GNOME keeps a busy cursor until the launch is reported complete, which
# Electron never does; it also copies the launch token into _NET_STARTUP_ID with
# a type GNOME rejects. Drop the token from Electron's environment and let
# notify-startup-complete.py send the "launch complete" message once the window
# is up. exec keeps this PID, so the helper can find the window by _NET_WM_PID.
APP_DIR="$(dirname "$(readlink -f "$0")")"

STARTUP_TOKEN="${DESKTOP_STARTUP_ID:-${XDG_ACTIVATION_TOKEN:-}}"
unset DESKTOP_STARTUP_ID XDG_ACTIVATION_TOKEN
if [ -n "${STARTUP_TOKEN}" ] && command -v python3 >/dev/null 2>&1; then
  python3 "${APP_DIR}/notify-startup-complete.py" "$$" "${STARTUP_TOKEN}" &
fi

# The overlay windows cannot be positioned under native Wayland.
exec "${APP_DIR}/capturedesk-bin" --ozone-platform=x11 "$@"
