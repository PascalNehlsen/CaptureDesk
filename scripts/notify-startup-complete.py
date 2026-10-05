#!/usr/bin/env python3
"""Tell the desktop that CaptureDesk has finished starting.

Electron does not send the X11 startup-notification "remove" message, so GNOME
keeps the busy cursor until its timeout. This waits until a window owned by the
given PID is mapped, then sends "remove: ID=<startup id>" the way GTK would.

Usage: notify-startup-complete.py <pid> <startup id>
"""

import ctypes
import ctypes.util
import sys
import time

TIMEOUT_SECONDS = 30
POLL_SECONDS = 0.1

ClientMessage = 33
PropertyChangeMask = 1 << 22


class XClientMessageData(ctypes.Union):
    # Xlib declares data as union { char b[20]; short s[10]; long l[5]; }, so
    # it is long-aligned (offset 56 on x86_64), not packed right after format.
    _fields_ = [("b", ctypes.c_char * 20), ("l", ctypes.c_long * 5)]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", XClientMessageData),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", XClientMessageEvent), ("pad", ctypes.c_long * 24)]


def load_xlib():
    path = ctypes.util.find_library("X11")
    if not path:
        return None
    x = ctypes.cdll.LoadLibrary(path)
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XGetWindowProperty.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
        ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
    ]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XCreateSimpleWindow.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong,
    ]
    x.XCreateSimpleWindow.restype = ctypes.c_ulong
    x.XSendEvent.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent),
    ]
    x.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    return x


def get_window_property(x, display, window, atom):
    """Return a format-32 property as a list of ints (any property type)."""
    actual_type = ctypes.c_ulong()
    actual_format = ctypes.c_int()
    n_items = ctypes.c_ulong()
    bytes_after = ctypes.c_ulong()
    data = ctypes.c_void_p()
    status = x.XGetWindowProperty(
        display, window, atom, 0, 4096, 0, 0,
        ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(n_items),
        ctypes.byref(bytes_after), ctypes.byref(data),
    )
    if status != 0 or not data.value:
        return []
    try:
        if actual_format.value != 32:
            return []
        values = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))
        return [values[i] for i in range(n_items.value)]
    finally:
        x.XFree(data)


def find_window_for_pid(x, display, root, pid):
    client_list = x.XInternAtom(display, b"_NET_CLIENT_LIST", 0)
    wm_pid = x.XInternAtom(display, b"_NET_WM_PID", 0)
    for window in get_window_property(x, display, root, client_list):
        if get_window_property(x, display, window, wm_pid) == [pid]:
            return window
    return None


def send_remove(x, display, root, startup_id):
    # Startup-notification spec: the message is split into 20-byte chunks, the
    # first sent as _NET_STARTUP_INFO_BEGIN and the rest as _NET_STARTUP_INFO,
    # terminated by a NUL byte.
    escaped = startup_id.replace("\\", "\\\\").replace('"', '\\"').replace(" ", "\\ ")
    message = f"remove: ID={escaped}".encode() + b"\0"
    begin = x.XInternAtom(display, b"_NET_STARTUP_INFO_BEGIN", 0)
    more = x.XInternAtom(display, b"_NET_STARTUP_INFO", 0)
    sender = x.XCreateSimpleWindow(display, root, -100, -100, 1, 1, 0, 0, 0)

    for offset in range(0, len(message), 20):
        event = XEvent()
        event.xclient.type = ClientMessage
        event.xclient.send_event = 1
        event.xclient.display = display
        event.xclient.window = sender
        event.xclient.message_type = begin if offset == 0 else more
        event.xclient.format = 8
        event.xclient.data.b = message[offset:offset + 20].ljust(20, b"\0")
        x.XSendEvent(display, root, 0, PropertyChangeMask, ctypes.byref(event))

    x.XFlush(display)
    x.XDestroyWindow(display, sender)
    x.XFlush(display)


def log(message):
    print(f"notify-startup-complete: {message}", file=sys.stderr, flush=True)


def main():
    if len(sys.argv) != 3 or not sys.argv[2]:
        return 0
    pid = int(sys.argv[1])
    startup_id = sys.argv[2]

    x = load_xlib()
    if x is None:
        log("libX11 not found")
        return 0
    display = x.XOpenDisplay(None)
    if not display:
        log("cannot open X display")
        return 0
    root = x.XDefaultRootWindow(display)

    started = time.monotonic()
    try:
        while time.monotonic() - started < TIMEOUT_SECONDS:
            window = find_window_for_pid(x, display, root, pid)
            if window:
                send_remove(x, display, root, startup_id)
                log(f"sent remove for {startup_id} (window {window:#x}, pid {pid}) "
                    f"after {time.monotonic() - started:.1f}s")
                return 0
            time.sleep(POLL_SECONDS)
        log(f"no window for pid {pid} within {TIMEOUT_SECONDS}s")
        return 0
    finally:
        x.XCloseDisplay(display)


if __name__ == "__main__":
    sys.exit(main())
