"""Quick actions: lock, do-not-disturb, keep-awake, custom commands."""

import os
import shlex
import subprocess


def _run(cmd_list):
    try:
        subprocess.Popen(
            cmd_list, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as e:
        print(f"[actions] failed to run {cmd_list}: {e}")


def _gsettings_get(schema, key):
    try:
        out = subprocess.run(
            ["gsettings", "get", schema, key], capture_output=True, text=True, timeout=3
        )
        return out.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return None


def _gsettings_set(schema, key, value):
    try:
        subprocess.run(
            ["gsettings", "set", schema, key, value],
            capture_output=True, timeout=3,
        )
    except (subprocess.SubprocessError, OSError):
        pass


class Actions:
    def __init__(self, custom):
        self.custom = custom or []
        self.is_kde = "kde" in os.environ.get("XDG_CURRENT_DESKTOP", "").lower()

    # -- state ---------------------------------------------------------------

    def dnd_enabled(self):
        if self.is_kde:
            return None  # not tracked on KDE
        v = _gsettings_get("org.gnome.desktop.notifications", "show-banners")
        if v is None:
            return None
        return v == "false"  # banners hidden == DND on

    def get_state(self):
        return {
            "dnd": self.dnd_enabled(),
            "custom": [
                {"id": f"custom-{i}", "label": c.get("label", "?"), "icon": c.get("icon", "")}
                for i, c in enumerate(self.custom)
            ],
        }

    # -- actions -------------------------------------------------------------

    def lock(self):
        _run(["loginctl", "lock-session"])

    def logout(self):
        if self.is_kde:
            _run(["qdbus", "org.kde.Shutdown", "/Shutdown", "org.kde.Shutdown.logout"])
        else:
            _run(["gnome-session-quit", "--logout"])  # asks for confirmation

    def toggle_dnd(self):
        if self.is_kde:
            # KDE Plasma DND toggle
            _run(["qdbus", "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                  "org.freedesktop.Notifications.Inhibited"])
            return
        current = self.dnd_enabled()
        if current is None:
            return
        _gsettings_set("org.gnome.desktop.notifications", "show-banners",
                       "true" if current else "false")

    def run_custom(self, action_id):
        try:
            idx = int(action_id.split("-", 1)[1])
            cmd = self.custom[idx].get("command")
        except (IndexError, ValueError):
            return
        if cmd:
            _run(shlex.split(cmd))
