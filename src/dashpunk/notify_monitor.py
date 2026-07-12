"""Capture desktop notifications from selected apps by monitoring the D-Bus
session bus, plus best-effort unread badges from Electron's Unity launcher
broadcasts. No configuration needed inside the watched apps."""

import itertools
import threading
import time
from collections import deque

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

MAX_ITEMS = 50


class NotifyMonitor:
    def __init__(self, sources):
        """sources: [{id, label, match: [substr, ...]}, ...]"""
        self.lock = threading.Lock()
        self.sources = []
        for s in sources:
            self.sources.append({
                "id": s["id"],
                "label": s.get("label", s["id"].upper()),
                "match": [m.lower() for m in s.get("match", [s["id"]])],
                "badge": None,
                "items": deque(maxlen=MAX_ITEMS),
            })
        self._seq = itertools.count(1)
        self._last_fp = None
        self._last_fp_ts = 0.0
        self._monitor_conn = None
        self._start_monitor()
        self._subscribe_badges()

    # -- notification capture (monitor connection) -----------------------------

    def _start_monitor(self):
        try:
            addr = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
            conn = Gio.DBusConnection.new_for_address_sync(
                addr,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
                | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None,
            )
            conn.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus.Monitoring", "BecomeMonitor",
                GLib.Variant("(asu)", ([
                    # classic desktop notifications
                    "type='method_call',interface='org.freedesktop.Notifications',"
                    "member='Notify'",
                    # portal backend + GLib notification legs: these carry the
                    # app id for sandboxed (Flatpak) apps
                    "type='method_call',interface='org.freedesktop.impl.portal.Notification',"
                    "member='AddNotification'",
                    "type='method_call',interface='org.gtk.Notifications',"
                    "member='AddNotification'",
                ], 0)),
                None, Gio.DBusCallFlags.NONE, 3000, None,
            )
            conn.add_filter(self._on_message)
            self._monitor_conn = conn
        except GLib.Error as e:
            print(f"[notify] cannot monitor session bus ({e.message}) — "
                  "notification capture disabled")

    def _on_message(self, _conn, message, incoming):
        # Runs on the GDBus worker thread.
        try:
            iface = message.get_interface()
            member = message.get_member()
            if iface == "org.freedesktop.Notifications" and member == "Notify":
                body = message.get_body()
                if body:
                    self._handle_notify(*body.unpack())
            elif member == "AddNotification":
                body = message.get_body()
                if body:
                    vals = body.unpack()
                    if len(vals) >= 3:  # (app_id, id, data)
                        app_id, _nid, data = vals[:3]
                        if isinstance(data, dict):
                            title = str(data.get("title", ""))
                            text = str(data.get("body", ""))
                            self._add(app_id, 0, title, text)
        except Exception as e:  # never break the bus filter
            print(f"[notify] filter error: {e}")
        # Swallow all incoming monitored traffic: if GDBus dispatched these
        # method calls it would auto-reply "unknown method", and the bus
        # disconnects a monitor the moment it sends anything.
        return None if incoming else message

    def _handle_notify(self, app_name, replaces_id, _icon, summary, body,
                       _actions, hints, _timeout):
        desktop_entry = ""
        if isinstance(hints, dict):
            desktop_entry = str(hints.get("desktop-entry", ""))
        self._add(f"{app_name} {desktop_entry}", replaces_id, summary, body)

    def _match_source(self, ident):
        ident = ident.lower()
        for src in self.sources:
            if any(m in ident for m in src["match"]):
                return src
        return None

    def _add(self, ident, replaces_id, summary, body):
        src = self._match_source(ident)
        if src is None or not (summary or body):
            return
        # The same notification can pass the bus twice (client -> portal/proxy
        # -> daemon); drop identical content seen within a short window.
        now = time.time()
        fp = (src["id"], summary, body)
        if fp == self._last_fp and now - self._last_fp_ts < 2.0:
            return
        self._last_fp, self._last_fp_ts = fp, now
        item = {
            "id": next(self._seq),
            "rid": replaces_id or None,
            "sender": summary or "(no title)",
            "body": body or "",
            "ts": time.time(),
        }
        with self.lock:
            if replaces_id:
                src["items"] = deque(
                    (i for i in src["items"] if i["rid"] != replaces_id),
                    maxlen=MAX_ITEMS,
                )
            src["items"].append(item)

    # -- unread badges (Unity LauncherEntry broadcasts) ------------------------

    def _subscribe_badges(self):
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            bus.signal_subscribe(
                None, "com.canonical.Unity.LauncherEntry", "Update", None, None,
                Gio.DBusSignalFlags.NONE, self._on_badge,
            )
        except GLib.Error as e:
            print(f"[notify] badge subscription failed: {e.message}")

    def _on_badge(self, _conn, _sender, _path, _iface, _signal, params):
        try:
            app_uri, props = params.unpack()
            src = self._match_source(app_uri)
            if src is None:
                return
            count = props.get("count")
            visible = props.get("count-visible", True)
            with self.lock:
                src["badge"] = int(count) if (count is not None and visible) else None
        except Exception as e:
            print(f"[notify] badge parse error: {e}")

    # -- API -------------------------------------------------------------------

    def read(self):
        with self.lock:
            return {
                "sources": [
                    {
                        "id": s["id"],
                        "label": s["label"],
                        "badge": s["badge"],
                        "items": [
                            {k: i[k] for k in ("id", "sender", "body", "ts")}
                            for i in reversed(s["items"])  # newest first
                        ],
                    }
                    for s in self.sources
                ]
            }

    def dismiss(self, source_id, item_id):
        with self.lock:
            for s in self.sources:
                if s["id"] == source_id:
                    s["items"] = deque(
                        (i for i in s["items"] if i["id"] != item_id),
                        maxlen=MAX_ITEMS,
                    )

    def clear(self, source_id):
        with self.lock:
            for s in self.sources:
                if s["id"] == source_id:
                    s["items"].clear()
