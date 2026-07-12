"""PipeWire/PulseAudio control via pactl."""

import json
import subprocess


def _pactl(*args, parse_json=False):
    cmd = ["pactl"]
    if parse_json:
        cmd += ["--format=json"]
    cmd += list(args)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        if out.returncode != 0:
            return None
        return json.loads(out.stdout) if parse_json else out.stdout.strip()
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def _volume_pct(vol_dict):
    """Max channel volume as 0..1 float from pactl's volume structure."""
    best = 0
    for ch in (vol_dict or {}).values():
        try:
            best = max(best, int(ch.get("value_percent", "0%").rstrip("%")))
        except (ValueError, AttributeError):
            pass
    return best / 100


def _device_kind(name, props):
    name = name.lower()
    bus = (props or {}).get("device.bus", "")
    if name.startswith("bluez") or bus == "bluetooth":
        return "bluetooth"
    if "hdmi" in name:
        return "hdmi"
    if "usb" in name or bus == "usb":
        return "usb"
    return "internal"


def get_audio_state():
    sinks_raw = _pactl("list", "sinks", parse_json=True) or []
    sources_raw = _pactl("list", "sources", parse_json=True) or []
    default_sink = _pactl("get-default-sink") or ""
    default_source = _pactl("get-default-source") or ""

    sinks = []
    for s in sinks_raw:
        sinks.append(
            {
                "name": s.get("name", ""),
                "desc": s.get("description", s.get("name", "?")),
                "vol": _volume_pct(s.get("volume")),
                "mute": bool(s.get("mute")),
                "kind": _device_kind(s.get("name", ""), s.get("properties")),
                "default": s.get("name") == default_sink,
            }
        )

    sources = []
    for s in sources_raw:
        name = s.get("name", "")
        if name.endswith(".monitor"):
            continue
        sources.append(
            {
                "name": name,
                "desc": s.get("description", name),
                "vol": _volume_pct(s.get("volume")),
                "mute": bool(s.get("mute")),
                "kind": _device_kind(name, s.get("properties")),
                "default": name == default_source,
            }
        )

    return {"sinks": sinks, "sources": sources}


def set_volume(kind, name, value):
    """kind: 'sink'|'source', value: 0..1"""
    pct = max(0, min(150, round(value * 100)))
    _pactl(f"set-{kind}-volume", name, f"{pct}%")


def toggle_mute(kind, name):
    _pactl(f"set-{kind}-mute", name, "toggle")


def set_default(kind, name):
    _pactl(f"set-default-{kind}", name)
