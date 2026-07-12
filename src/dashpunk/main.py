"""Dashpunk — GTK4 shell hosting a WebKit cyberpunk dashboard.

Fullscreens on the monitor whose DRM connector (or model name) matches the
config, so it lands on the Corsair Xeneon Edge regardless of monitor layout.
"""

import json
import os
import platform
import re
import shlex
import socket
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

from . import actions as actions_mod  # noqa: E402
from . import audio, mpris, netinfo, stats, viz  # noqa: E402
from .calendar_feed import CalendarFeed  # noqa: E402
from .notify_monitor import NotifyMonitor  # noqa: E402
from .spotify import SpotifyClient  # noqa: E402
from .taskwarrior import TaskFeed  # noqa: E402
from .worldinfo import WorldInfo  # noqa: E402
from .config import load_config, load_state, save_state  # noqa: E402

APP_ID = "io.github.karubits.Dashpunk"
VALID_THEMES = ("cyberpunk", "lcars", "catppuccin", "monokai", "mayukai", "dracula")
# ui/ lives at the repo root; this file is at src/dashpunk/main.py
UI_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "ui"
)


class Collector(threading.Thread):
    """Gathers all state off the main loop and pushes JSON to the webview."""

    def __init__(self, cfg, push_cb):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.push_cb = push_cb
        self.stats = stats.StatsCollector(cfg["system"]["disks"])
        self.net = netinfo.NetCollector(
            cfg["network"]["ping_targets"], cfg["network"]["ping_interval"]
        )
        self.mpris = mpris.MprisClient()
        self.actions = actions_mod.Actions(cfg["actions"].get("custom"))
        self.notify = NotifyMonitor(cfg["notifications"].get("sources", []))
        self.calendar = CalendarFeed(cfg["calendar"])
        self.world = WorldInfo(cfg["world"])
        self.spotify = SpotifyClient(cfg["spotify"])
        self.tasks = TaskFeed(cfg["tasks"])
        self.awake = False  # mirrored by App via inhibit; included in state
        self._stop = threading.Event()

    def run(self):
        interval = float(self.cfg["system"]["update_interval"])
        while not self._stop.is_set():
            state = {}
            try:
                state.update(self.stats.read())
                state["net"] = self.net.read()
                state["audio"] = audio.get_audio_state()
                state["media"] = self.mpris.get_state()
                if state["media"]:
                    state["media"]["spotify"] = {
                        "status": self.spotify.status,
                        "liked": self.spotify.is_liked(state["media"].get("trackId")),
                    }
                state["actions"] = self.actions.get_state()
                state["actions"]["awake"] = self.awake
                state["notifs"] = self.notify.read()
                state["cal"] = self.calendar.read()
                state["world"] = self.world.read()
                state["tasks"] = self.tasks.read()
            except Exception as e:  # keep the dashboard alive on collector bugs
                print(f"[collector] {type(e).__name__}: {e}")
            GLib.idle_add(self.push_cb, state)
            self._stop.wait(interval)

    def stop(self):
        self._stop.set()
        self.net.ping.stop()


class App(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID)
        self.cfg = load_config()
        # theme: runtime choice (state.json) wins over the config default
        theme = load_state().get("theme") or self.cfg["ui"]["theme"]
        self.theme = theme if theme in VALID_THEMES else "cyberpunk"
        self.win = None
        self.webview = None
        self.collector = None
        self.viz = None
        self._inhibit_cookie = 0
        self._js_ready = False
        # latest-audio-chunk slot: at most one idle callback pending, always
        # pushing the newest chunk (no burst replay if the main loop stalls)
        self._audio_b64 = None
        self._audio_scheduled = False
        self._audio_lock = threading.Lock()

    # -- window / monitor ------------------------------------------------------

    def find_target_monitor(self):
        display = Gdk.Display.get_default()
        monitors = display.get_monitors()
        want_connector = self.cfg["display"]["connector"]
        want_model = self.cfg["display"]["model_match"].lower()
        fallback = None
        for i in range(monitors.get_n_items()):
            mon = monitors.get_item(i)
            if mon.get_connector() == want_connector:
                return mon
            model = (mon.get_model() or "").lower()
            if want_model and want_model in model:
                fallback = mon
        return fallback

    def do_activate(self):
        if self.win:
            self.win.present()
            return

        ucm = WebKit.UserContentManager()
        ucm.register_script_message_handler("bridge")
        ucm.connect("script-message-received::bridge", self.on_bridge_message)

        # WebKit's web process can slowly leak over days of uptime until GC
        # thrash freezes the page. Cap it well above normal usage (a few
        # hundred MiB) so WebKit recycles it instead; web-process-terminated
        # below reloads the UI, which is stateless (all state lives here).
        mps = WebKit.MemoryPressureSettings.new()
        mps.set_memory_limit(1200)  # MiB
        mps.set_kill_threshold(1.0)
        ctx = WebKit.WebContext(memory_pressure_settings=mps)

        self.webview = WebKit.WebView(user_content_manager=ucm, web_context=ctx)
        self.webview.connect("web-process-terminated", self.on_web_process_terminated)
        settings = self.webview.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_allow_file_access_from_file_urls(True)
        settings.set_allow_universal_access_from_file_urls(True)
        settings.set_enable_write_console_messages_to_stdout(True)
        self.webview.set_background_color(Gdk.RGBA(red=0.02, green=0.03, blue=0.05, alpha=1))

        self.win = Gtk.ApplicationWindow(application=self, title="Dashpunk")
        self.win.set_decorated(False)
        self.win.set_default_size(1280, 720)
        self.win.set_child(self.webview)

        if self.cfg["display"]["hide_cursor"]:
            cursor = Gdk.Cursor.new_from_name("none")
            if cursor:
                self.webview.set_cursor(cursor)

        # Keyboard escape hatches: F11 window/fullscreen, Ctrl+Q quit, F12 inspector
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.on_key)
        self.win.add_controller(keys)

        index = os.path.join(UI_DIR, "index.html")
        self.webview.load_uri(GLib.filename_to_uri(index, None))

        mon = self.find_target_monitor()
        if mon:
            self.win.fullscreen_on_monitor(mon)
        else:
            print("[display] target monitor not found — starting windowed "
                  f"(looked for connector={self.cfg['display']['connector']!r})")
        self.win.present()

        self.collector = Collector(self.cfg, self.push_state)
        self.collector.start()

        self.viz = viz.AudioCapture(self.on_audio_chunk, fps=self.cfg["visualizer"]["fps"])
        self.viz.start()

    def on_key(self, _ctrl, keyval, _keycode, state):
        if keyval == Gdk.KEY_F11:
            if self.win.is_fullscreen():
                self.win.unfullscreen()
            else:
                mon = self.find_target_monitor()
                self.win.fullscreen_on_monitor(mon) if mon else self.win.fullscreen()
            return True
        if keyval == Gdk.KEY_q and state & Gdk.ModifierType.CONTROL_MASK:
            self.quit()
            return True
        if keyval == Gdk.KEY_F12:
            self.webview.get_inspector().show()
            return True
        return False

    def on_web_process_terminated(self, webview, reason):
        print(f"[webview] web process terminated ({reason.value_nick}); reloading UI")
        self._js_ready = False
        if self.viz:  # fresh page starts on page 0; it re-requests capture
            self.viz.set_active(False)
        index = os.path.join(UI_DIR, "index.html")
        webview.load_uri(GLib.filename_to_uri(index, None))

    # -- python -> js ----------------------------------------------------------

    def push_state(self, state):
        if not self._js_ready:
            return False
        js = f"window.__update({json.dumps(state)})"
        self.webview.evaluate_javascript(js, -1, None, None, None, None)
        return False  # one-shot idle callback

    def on_audio_chunk(self, b64):
        """Called ~30×/s from the capture thread with base64 PCM."""
        with self._audio_lock:
            self._audio_b64 = b64
            if self._audio_scheduled:
                return
            self._audio_scheduled = True
        GLib.idle_add(self.push_audio)

    def push_audio(self):
        with self._audio_lock:
            b64, self._audio_scheduled = self._audio_b64, False
        if self._js_ready and b64:
            # base64 alphabet is safe inside a double-quoted JS literal
            self.webview.evaluate_javascript(
                f'window.__audio("{b64}")', -1, None, None, None, None
            )
        return False  # one-shot idle callback

    def push_static(self):
        info = {
            "hostname": socket.gethostname(),
            "kernel": platform.release(),
            "distro": _distro_name(),
            "hideCursor": bool(self.cfg["display"]["hide_cursor"]),
            "mediaLauncher": (self.cfg["media"]["launcher_label"]
                              if self.cfg["media"]["launcher_command"] else None),
            "stations": self.cfg["media"].get("stations", []),
            "apps": [{"label": a.get("label", "?"), "icon": a.get("icon", "")}
                     for a in self.cfg["apps"].get("items", [])],
            "viz": {"bars": self.cfg["visualizer"]["bars"],
                    "mode": self.cfg["visualizer"]["mode"]},
            "theme": self.theme,
            "glitches": bool(self.cfg["ui"].get("glitches", True)),
        }
        js = f"window.__static({json.dumps(info)})"
        self.webview.evaluate_javascript(js, -1, None, None, None, None)

    # -- js -> python ----------------------------------------------------------

    def on_bridge_message(self, _ucm, js_value):
        try:
            msg = json.loads(js_value.to_string())
        except (ValueError, AttributeError) as e:
            print(f"[bridge] bad message: {e}")
            return
        cmd = msg.get("cmd")
        c = self.collector

        if cmd == "ready":
            self._js_ready = True
            if self.viz:  # fresh page always starts on page 0
                self.viz.set_active(False)
            self.push_static()
        elif cmd == "viz-active":
            if self.viz:
                self.viz.set_active(bool(msg.get("active")))
        elif cmd == "theme":
            name = str(msg.get("name", ""))
            if name in VALID_THEMES:
                self.theme = name
                save_state(theme=name)
        elif cmd == "spotify-like":
            threading.Thread(
                target=c.spotify.toggle_like,
                args=(msg.get("trackId"), bool(msg.get("liked"))), daemon=True,
            ).start()
        elif cmd == "spotify-auth":
            threading.Thread(target=c.spotify.start_auth, daemon=True).start()
        elif cmd == "volume":
            threading.Thread(
                target=audio.set_volume,
                args=(msg["kind"], msg["name"], float(msg["value"])), daemon=True,
            ).start()
        elif cmd == "mute":
            threading.Thread(
                target=audio.toggle_mute, args=(msg["kind"], msg["name"]), daemon=True
            ).start()
        elif cmd == "default":
            threading.Thread(
                target=audio.set_default, args=(msg["kind"], msg["name"]), daemon=True
            ).start()
        elif cmd == "media":
            threading.Thread(
                target=c.mpris.command,
                args=(msg["action"], msg.get("player")), daemon=True,
            ).start()
        elif cmd == "action":
            self.handle_action(msg.get("id", ""))
        elif cmd == "app-launch":
            try:
                item = self.cfg["apps"]["items"][int(msg.get("idx", -1))]
            except (IndexError, ValueError, TypeError):
                item = None
            if item:
                self.launch_app(item)
        elif cmd == "media-launch":
            command = self.cfg["media"]["launcher_command"]
            if command:
                actions_mod._run(shlex.split(command))
        elif cmd == "notif-dismiss":
            c.notify.dismiss(msg.get("source", ""), msg.get("id"))
        elif cmd == "notif-clear":
            c.notify.clear(msg.get("source", ""))
        elif cmd == "task-done":
            uuid = str(msg.get("uuid", ""))
            if re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", uuid):
                threading.Thread(target=c.tasks.mark_done, args=(uuid,), daemon=True).start()

    def activate_window(self, query):
        """Focus an existing window via the bundled GNOME Shell extension.
        Returns False if the extension isn't installed or no window matches."""
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            res = bus.call_sync(
                "org.gnome.Shell",
                "/io/github/karubits/Dashpunk/WindowActivator",
                "io.github.karubits.Dashpunk.WindowActivator", "Activate",
                GLib.Variant("(s)", (query,)), GLib.VariantType("(b)"),
                Gio.DBusCallFlags.NONE, 1000, None,
            )
            return bool(res.unpack()[0])
        except GLib.Error:
            return False

    def launch_app(self, item):
        """Focus the app's existing window if one is open (compositor-side,
        immune to focus-stealing prevention); otherwise launch it via its
        desktop entry with a Wayland activation token."""
        desktop = item.get("desktop") or ""
        # URL tiles always launch (they need to open the link);
        # app tiles first try to raise a window that is already open.
        if desktop and not item.get("url"):
            query = item.get("wm_class") or desktop.removesuffix(".desktop")
            if self.activate_window(query):
                return
        if desktop:
            try:
                info = Gio.DesktopAppInfo.new(desktop)
                if info:
                    ctx = self.win.get_display().get_app_launch_context()
                    if item.get("url"):
                        info.launch_uris([item["url"]], ctx)
                    else:
                        info.launch([], ctx)
                    return
            except GLib.Error as e:
                print(f"[apps] desktop launch {desktop} failed: {e.message}")
        if item.get("command"):
            actions_mod._run(shlex.split(item["command"]))

    def handle_action(self, action_id):
        c = self.collector
        if action_id == "lock":
            c.actions.lock()
        elif action_id == "logout":
            c.actions.logout()
        elif action_id == "dnd":
            threading.Thread(target=c.actions.toggle_dnd, daemon=True).start()
        elif action_id == "awake":
            if self._inhibit_cookie:
                self.uninhibit(self._inhibit_cookie)
                self._inhibit_cookie = 0
                c.awake = False
            else:
                self._inhibit_cookie = self.inhibit(
                    self.win, Gtk.ApplicationInhibitFlags.IDLE, "Xeneon Edge keep-awake"
                )
                c.awake = True
        elif action_id.startswith("custom-"):
            c.actions.run_custom(action_id)

    def do_shutdown(self):
        if self.viz:
            self.viz.stop()
        if self.collector:
            self.collector.stop()
        Gtk.Application.do_shutdown(self)


def _distro_name():
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "Linux"


def main():
    app = App()
    return app.run(None)


if __name__ == "__main__":
    raise SystemExit(main())
