"""MPRIS media player integration over D-Bus (no playerctl needed)."""

import os

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
ROOT_IFACE = "org.mpris.MediaPlayer2"
OBJ_PATH = "/org/mpris/MediaPlayer2"


def _spotify_track_id(player, meta):
    """Spotify track id (for the Web API like button), or None."""
    if "spotify" not in player.lower():
        return None
    tid = str(meta.get("mpris:trackid") or "")
    if "/track/" in tid:  # /com/spotify/track/<id>
        return tid.rsplit("/", 1)[-1]
    if tid.startswith("spotify:track:"):
        return tid.rsplit(":", 1)[-1]
    url = str(meta.get("xesam:url") or "")
    if "open.spotify.com/track/" in url:
        return url.rsplit("/", 1)[-1].split("?")[0]
    return None


class MprisClient:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self._last_player = None
        self._self_cache = {}  # bus name -> bool (owned by our process tree)

    def _call(self, dest, iface, method, params=None, reply_type=None, timeout=500):
        try:
            return self.bus.call_sync(
                dest, OBJ_PATH, iface, method, params,
                GLib.VariantType(reply_type) if reply_type else None,
                Gio.DBusCallFlags.NONE, timeout, None,
            )
        except GLib.Error:
            return None

    def _list_players(self):
        try:
            res = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "ListNames", None,
                GLib.VariantType("(as)"), Gio.DBusCallFlags.NONE, 500, None,
            )
        except GLib.Error:
            return []
        return [n for n in res.unpack()[0]
                if n.startswith(MPRIS_PREFIX)
                and "xeneonedge" not in n.lower()  # our own webview's player
                and not self._is_self(n)]

    def _is_self(self, name):
        """True if the player is published by our own process tree — the
        WebKit webview registers the dashboard's radio playback on MPRIS."""
        if name in self._self_cache:
            return self._self_cache[name]
        result = False
        try:
            res = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                GLib.Variant("(s)", (name,)), GLib.VariantType("(u)"),
                Gio.DBusCallFlags.NONE, 500, None,
            )
            pid, me = res.unpack()[0], os.getpid()
            for _ in range(8):  # walk up: WebKitWebProcess / bwrap -> us
                if pid == me:
                    result = True
                    break
                if pid <= 1:
                    break
                with open(f"/proc/{pid}/status") as f:
                    ppid = None
                    for line in f:
                        if line.startswith("PPid:"):
                            ppid = int(line.split()[1])
                            break
                if ppid is None:
                    break
                pid = ppid
        except (GLib.Error, OSError, ValueError):
            pass
        self._self_cache[name] = result
        return result

    def _get_all(self, dest, iface):
        res = self._call(
            dest, "org.freedesktop.DBus.Properties", "GetAll",
            GLib.Variant("(s)", (iface,)), "(a{sv})",
        )
        return res.unpack()[0] if res else None

    def get_state(self):
        """Return state of the most relevant player, or None."""
        players = self._list_players()
        if not players:
            self._last_player = None
            return None

        # Prefer a playing player, then the one we controlled last, then the first.
        chosen, chosen_props = None, None
        candidates = players
        if self._last_player in players:
            candidates = [self._last_player] + [p for p in players if p != self._last_player]
        for p in candidates:
            props = self._get_all(p, PLAYER_IFACE)
            if props is None:
                continue
            if chosen is None:
                chosen, chosen_props = p, props
            if props.get("PlaybackStatus") == "Playing":
                chosen, chosen_props = p, props
                break
            # prefer a player that actually has a track loaded (browsers
            # register on MPRIS even with nothing playing)
            has_track = (props.get("Metadata") or {}).get("xesam:title")
            chosen_has = (chosen_props.get("Metadata") or {}).get("xesam:title")
            if has_track and not chosen_has:
                chosen, chosen_props = p, props
        if chosen is None:
            return None
        self._last_player = chosen

        meta = chosen_props.get("Metadata") or {}
        status = chosen_props.get("PlaybackStatus", "Stopped")
        # A player with no track metadata (e.g. a browser that merely
        # registered on MPRIS, even one claiming "Playing") counts as no
        # media, so the UI can offer the launcher instead.
        if not meta.get("xesam:title") and not meta.get("xesam:artist"):
            return None

        root = self._get_all(chosen, ROOT_IFACE) or {}
        artists = meta.get("xesam:artist") or []
        if isinstance(artists, str):
            artists = [artists]

        # Position isn't included in PropertiesChanged for most players; Get it live.
        position = None
        pos_res = self._call(
            chosen, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", (PLAYER_IFACE, "Position")), "(v)",
        )
        if pos_res:
            position = pos_res.unpack()[0]

        return {
            "player": chosen,
            "identity": root.get("Identity") or chosen[len(MPRIS_PREFIX):],
            "status": status,
            "title": meta.get("xesam:title") or "",
            "artist": ", ".join(a for a in artists if a),
            "album": meta.get("xesam:album") or "",
            "art": meta.get("mpris:artUrl") or "",
            "trackId": _spotify_track_id(chosen, meta),
            "length": meta.get("mpris:length"),  # microseconds
            "position": position,  # microseconds
            "canNext": bool(chosen_props.get("CanGoNext")),
            "canPrev": bool(chosen_props.get("CanGoPrevious")),
        }

    def command(self, action, player=None):
        dest = player or self._last_player
        if not dest:
            return
        method = {"playpause": "PlayPause", "next": "Next", "previous": "Previous"}.get(action)
        if method:
            self._call(dest, PLAYER_IFACE, method)
