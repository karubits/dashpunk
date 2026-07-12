"""Configuration loading for Dashpunk."""

import json
import os
import tomllib

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "dashpunk"
)
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.toml")
# Pre-rename config location (the app used to be "xeneon-edge"); migrated
# automatically on first run after upgrading.
OLD_CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "xeneon-edge"
)

# Small runtime-state file for values the UI changes at runtime (theme).
# Kept apart from config.toml so the user's commented config is never
# rewritten. State wins over the corresponding config values.
STATE_PATH = os.path.join(CONFIG_DIR, "state.json")


def load_state() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(**updates) -> None:
    state = load_state()
    state.update(updates)
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except OSError as e:
        print(f"[state] could not save {STATE_PATH}: {e}")


DEFAULT_CONFIG_TOML = """\
# Dashpunk configuration

# Dashboard theme:
#   "cyberpunk" | "lcars" | "catppuccin" | "monokai" | "mayukai" | "dracula"
# The THEME button in the header cycles themes at runtime; the last choice
# is remembered in state.json (next to this file) and wins over this value.
[ui]
theme = "cyberpunk"
# Simulated GPU glitch on the cyberpunk theme (a brief flicker/tear, one or
# two per ~20 minutes). Set to false to disable.
glitches = true

[display]
# DRM connector the Xeneon Edge is attached to (see: ls /sys/class/drm)
connector = "DP-2"
# Fallback: substring matched against the monitor model name
model_match = "XENEON EDGE"
# Hide the mouse cursor over the dashboard (it is a touchscreen after all)
hide_cursor = true

[system]
# Seconds between stat updates
update_interval = 1.0
# Mount points to show disk usage for
disks = ["/", "/home"]

[network]
# Ping targets. "gateway" is replaced with your default gateway IP.
ping_targets = ["gateway", "1.1.1.1"]
# Seconds between pings (per target)
ping_interval = 2.0

# Calendar agenda (messages page + next-meeting chip in the header).
# Use a published/secret ICS link, e.g. Outlook: Settings -> Calendar ->
# Shared calendars -> Publish a calendar -> ICS link. Keep this URL private.
[calendar]
ics_url = ""
refresh_minutes = 5
lookahead_days = 7
max_events = 12
# Hide events whose title contains any of these (case-insensitive),
# e.g. Outlook's day-long follow-up bars: ignore = ["following:"]
ignore = []

# Buttons shown on the media panel when nothing is playing.
[media]
launcher_label = "SPOTIFY"
# e.g. "flatpak run com.spotify.Client" or "spotify-launcher"; empty = no button
launcher_command = ""

# Live radio streams, played directly on the dashboard (through the default
# audio output, so the volume slider applies). Direct stream URLs, not
# website links.
#
# [[media.stations]]
# label = "DOUBLE J"
# url = "https://abc.streamguys1.com/live/doublejwa/icecast.audio"

# App launcher page (StreamDeck-style touch tiles). `icon` is a file in
# ui/icons/ (great source: https://selfh.st/icons/).
# Prefer `desktop` (a .desktop entry id): the app launches with a Wayland
# activation token so its window comes to the front even if already running.
# Add `url` to open a link with that app. `command` (any shell command) is
# the fallback and the way to run terminal macros.
#
# [[apps.items]]
# label = "Ghostty"
# icon = "ghostty.png"
# desktop = "com.mitchellh.ghostty.desktop"
# command = "ghostty"

# World clocks page: local time, weather and public holidays per city.
# Weather needs a free OpenWeather API key (openweathermap.org). Holidays
# come from date.nager.at (no key). `region` filters sub-national holidays,
# e.g. "US-GA" for Georgia. Set home = true on your own city.
[world]
openweather_api_key = ""

# [[world.cities]]
# name = "Eindhoven"
# country = "NL"
# tz = "Europe/Amsterdam"
# query = "Eindhoven,NL"
# home = true

# Taskwarrior page (needs the `task` CLI). `filter` is any task filter
# expression; tasks are shown sorted by urgency with tag/project chips.
[tasks]
filter = "status:pending"
refresh_seconds = 30

# Audio visualizer page. Reacts to whatever plays on the default output.
# mode is the startup mode: "bars" | "scope" | "radial" | "stars" |
# "wormhole" | "warp" — tap the visualizer to cycle through them.
[visualizer]
fps = 30
bars = 48
mode = "bars"

# Spotify like button (dash media panel + visualizer page). Create a free
# app at https://developer.spotify.com/dashboard with redirect URI
# http://127.0.0.1:8898/callback, then paste its Client ID here and tap
# LINK SPOTIFY on the dashboard (one-time browser approval).
[spotify]
client_id = ""

# Notification sources shown on the messages page. `match` patterns are
# case-insensitive substrings tested against the notifying app's name,
# desktop-entry and app id.
[[notifications.sources]]
id = "teams"
label = "TEAMS"
match = ["teams"]

[[notifications.sources]]
id = "mattermost"
label = "MATTERMOST"
match = ["mattermost"]

# Custom quick-action buttons (uncomment and edit to add your own).
# Each button runs a shell command when tapped.
#
# [[actions.custom]]
# label = "Files"
# icon = "\\uf07b"
# command = "nautilus"
#
# [[actions.custom]]
# label = "Term"
# icon = ">_"
# command = "ptyxis"
"""

DEFAULTS = {
    "ui": {
        "theme": "cyberpunk",
        "glitches": True,
    },
    "display": {
        "connector": "DP-2",
        "model_match": "XENEON EDGE",
        "hide_cursor": True,
    },
    "system": {
        "update_interval": 1.0,
        "disks": ["/", "/home"],
    },
    "network": {
        "ping_targets": ["gateway", "1.1.1.1"],
        "ping_interval": 2.0,
    },
    "actions": {
        "custom": [],
    },
    "calendar": {
        "ics_url": "",
        "refresh_minutes": 5,
        "lookahead_days": 7,
        "max_events": 12,
        "ignore": [],
    },
    "apps": {
        "items": [],
    },
    "media": {
        "launcher_label": "SPOTIFY",
        "launcher_command": "",
        "stations": [],
    },
    "world": {
        "openweather_api_key": "",
        "cities": [],
    },
    "tasks": {
        "filter": "status:pending",
        "refresh_seconds": 30,
    },
    "visualizer": {
        "fps": 30,
        "bars": 48,
        "mode": "bars",
    },
    "spotify": {
        "client_id": "",
    },
    "notifications": {
        "sources": [
            {"id": "teams", "label": "TEAMS", "match": ["teams"]},
            {"id": "mattermost", "label": "MATTERMOST", "match": ["mattermost"]},
        ],
    },
}


def load_config() -> dict:
    """Load config, writing a commented default file on first run."""
    # One-time migration from the pre-rename location (~/.config/xeneon-edge).
    if not os.path.exists(CONFIG_DIR) and os.path.isdir(OLD_CONFIG_DIR):
        try:
            os.rename(OLD_CONFIG_DIR, CONFIG_DIR)
            print(f"[config] migrated {OLD_CONFIG_DIR} -> {CONFIG_DIR}")
        except OSError:
            pass

    if not os.path.exists(CONFIG_PATH):
        try:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                f.write(DEFAULT_CONFIG_TOML)
        except OSError:
            pass

    cfg = {k: dict(v) if isinstance(v, dict) else v for k, v in DEFAULTS.items()}
    try:
        with open(CONFIG_PATH, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            if section in cfg and isinstance(values, dict):
                cfg[section].update(values)
            else:
                cfg[section] = values
    except (OSError, tomllib.TOMLDecodeError) as e:
        print(f"[config] failed to load {CONFIG_PATH}: {e} — using defaults")
    return cfg
