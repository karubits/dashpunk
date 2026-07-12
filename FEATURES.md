# Dashpunk: Corsair's touchscreen, unlocked on Linux 🐧

A Linux cyberdeck for the Corsair Xeneon Edge. Corsair ships zero Linux
support for the Edge (2560×720 touchscreen). Turns out it doesn't need any:
it's just a monitor with a USB touch panel. So I turned mine into a cyberpunk
touch deck. Fullscreen, borderless, finds the Edge by its DRM connector,
works on GNOME & KDE Wayland.

## Six swipeable pages

**⚡ DASH**: CPU with per-core bars, AMD GPU load/VRAM/power, temps, RAM &
disks, live network throughput + ping quality graphs. Touch volume slider,
tap-to-switch audio output (Bluetooth headset ⇄ speakers), big mic mute.
Spotify/MPRIS now-playing with album art, and live radio streamed *by the
dashboard itself*, no external player. Quick actions: lock, DND, keep-awake,
logout.

**✉ MSGS**: Teams & Mattermost desktop notifications captured off the D-Bus
(works for Flatpaks and even while DND hides banners), per-app columns,
tap-to-dismiss, unread badge. Plus your Outlook agenda from a published ICS
link: recurring meetings, timezones and rescheduled instances handled, with
a next-meeting countdown in the header.

**⊕ WORLD**: world clocks with day/night tint, current weather + 4-day
forecast (OpenWeather), and public holidays per city incl. regional ones
like US-GA (Nager.Date, no key needed).

**⊞ APPS**: StreamDeck-style launcher tiles: apps, Flatpaks, URLs, and
terminal macros (one tap runs `step-cli ssh login` in a Ghostty window).
Launches carry Wayland activation tokens, and a bundled 40-line GNOME Shell
extension focuses already-running windows, no more "app is ready" toasts.

**♫ VIZ**: a full-width audio visualizer straight out of the Winamp era,
reacting to *whatever* plays on the default output (Spotify, browser, the
built-in radio). Six modes, tap to cycle: classic spectrum bars with peak
caps, oscilloscope, radial spectrum, hyperspace starfield, wormhole tunnel,
and a MilkDrop-style feedback warp. Album art + track info sit in the corner
with transport controls and a Spotify like button. Capture (`parec` on the
sink monitor; ships with libpulse, zero new dependencies) only runs while
the page is visible.

**☑ TASKS**: your Taskwarrior pending list, sorted by urgency in a
three-column board with overdue/due-soon highlighting. Filter chips for every
tag and project are derived live from your tasks. Tap ✓ to complete a task;
a 5-second UNDO countdown runs before anything touches the task database, so
fat fingers are survivable. Reads are side-effect-free (`rc.gc=off
rc.hooks=off`); completions run your hooks normally.

## The touch input fix everyone with this screen needs 👇

The Edge's controller (`27c0:0859` wch.cn) exposes **two HID interfaces: a
real touchscreen *and* a legacy absolute-mouse emulation**. Result on Linux:
touches act like a mouse, and because the desktop can't match the "wch.cn"
touch device to the Corsair EDID, taps land on the *wrong monitor*.

Two-part fix (install script does the GNOME half for you):

```
# map the touch panel to the Edge display (GNOME/Mutter)
gsettings set org.gnome.desktop.peripherals.touchscreen:/org/gnome/desktop/peripherals/touchscreens/27c0:0859/ output "['CRX', 'XENEON EDGE', '<your-serial>']"
```

On **KDE Plasma 6**: System Settings → Mouse & Touchpad → Touchscreen → map
*wch.cn TouchScreen* to the Edge (KWin binds it by the display's UUID; a
GUI/D-Bus set makes it stick; hand-editing `OutputName` alone doesn't).

…plus a udev rule (bundled) that hides the mouse-emulation interface from
libinput if it ever acts up. After that: real multitouch, flicks, drags:
tablet behaviour everywhere, not just in this app. Works the same whether the
Edge is on HDMI or USB-C (DisplayPort). Full technical write-up:
[docs/TOUCHSCREEN.md](docs/TOUCHSCREEN.md).

## Under the hood

- Python + GTK4 + WebKitGTK: **no Electron, no Node, no npm**; UI is plain
  HTML/CSS/JS with neon-glow canvas graphs
- Runs on packages a stock CachyOS/GNOME install already has
- Audio via PipeWire (`pactl`), media via MPRIS D-Bus, sensors via sysfs,
  all collection off the UI thread
- One TOML config file; everything (cities, tiles, radio stations, ping
  targets, notification sources) is user-configurable
- GPLv3 licensed

Repo: https://github.com/karubits/dashpunk
