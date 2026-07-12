# Dashpunk for Xeneon Edge: getting the touchscreen working properly on Linux

A technical breakdown of why touch on the Corsair Xeneon Edge misbehaves on
Linux out of the box, and the two-part fix. `install.sh` applies the fix
automatically on GNOME and KDE Plasma 6 (and `./install.sh --verify` checks
an existing setup); this document explains what it does and why.

**TL;DR**: it's not a driver problem. The compositor maps the touch panel's
coordinates to the *wrong monitor* because it cannot associate the generic
USB touch controller with the Corsair display's EDID. One `gsettings` write
fixes it permanently.

## The hardware

The Edge's touch panel is a USB HID device from WCH (Nanjing Qinheng),
`27c0:0859`, named `wch.cn TouchScreen`. It enumerates as a composite device
with **two input interfaces**:

| Interface | Event node (example) | udev classification | What it is |
|---|---|---|---|
| `if00` | `event13` | `ID_INPUT_TOUCHSCREEN=1`, `INPUT_PROP_DIRECT` | The real touch digitizer (absolute coordinates, touch contacts) |
| `if02` | `event14` | `ID_INPUT_MOUSE=1` | Legacy absolute-mouse emulation, for OSes without touch support |

Both report a physical size of 215×90 mm. The kernel handles both correctly:
`hid-multitouch` binds the digitizer and events flow with no extra drivers.

Inspect your own unit:

```bash
# how udev classified each interface
udevadm info /dev/input/by-id/usb-wch.cn_TouchScreen_*-event-if00 | grep ID_INPUT
udevadm info /dev/input/by-id/usb-wch.cn_TouchScreen_*-if02-event-mouse | grep ID_INPUT

# confirm which interface emits events while you touch the panel
sudo evtest /dev/input/event13
```

## The actual bug: output association, not input

On Wayland, a touchscreen's absolute coordinates must be mapped to exactly
one output. Compositors do this automatically by *matching the input device
to a display*, via the device name, physical dimensions vs. the monitor's
EDID, and connector hints for built-in panels.

For the Edge that association is impossible to make automatically:

- The **input device** identifies as `wch.cn TouchScreen` over USB, a
  generic chip-vendor string.
- The **display** identifies via EDID as vendor `CRX`, product
  `XENEON EDGE`, plus a unit serial, on whichever video connector you plugged
  into: HDMI (`HDMI-A-1`) or DisplayPort (`DP-2`, incl. USB-C alt mode).
  Touch always arrives over the separate USB cable either way.

Nothing links the two. Mutter's fallback maps the unmatched touchscreen to
another output, in practice the primary monitor. The symptom: the digitizer
streams touch events perfectly (on our test unit, ~1100 events in 8 seconds
from `event13`, and notably **zero** from the mouse interface; the mouse-emu
HID is innocent), but the coordinates are scaled onto the *main* display.
Taps land on the wrong screen, which superficially looks like "the
touchscreen acts like a broken mouse".

## Fix part 1: explicit touchscreen→output mapping

GNOME/Mutter supports per-device output mapping through a **relocatable
GSettings schema**, keyed by the input device's USB `VID:PID`, valued with
the monitor's EDID identity triple:

```bash
gsettings set \
  org.gnome.desktop.peripherals.touchscreen:/org/gnome/desktop/peripherals/touchscreens/27c0:0859/ \
  output "['CRX', 'XENEON EDGE', '<your-serial>']"
```

Get your exact EDID triple from Mutter itself (each monitor tuple is
`(connector, vendor, product, serial)`):

```bash
gdbus call --session \
  --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCurrentState
```

Mutter watches this key and remaps **live**: no restart, no replug. From
that moment libinput's touch events are transformed into that output's
coordinate space and you get genuine touch semantics desktop-wide: taps,
drags, flicks, kinetic scrolling, multitouch.

Other environments:

- **KDE Plasma 6 (KWin/Wayland)**: same concept, KWin's per-device output
  binding; see the dedicated section below.
- **X11**: `xinput map-to-output '<device>' <output>` (session-scoped; put it
  in an autostart script).

### KDE Plasma 6 (KWin/Wayland)

KWin has the same per-device output binding as Mutter, but with a subtlety
that bites you if you edit config by hand.

**Easy way (the GUI):** System Settings → Mouse & Touchpad → Touchscreen →
select *wch.cn TouchScreen* and map it to the Xeneon Edge display. This
applies live and persists. Done.

**Scriptable way (D-Bus, for install scripts / headless setup):** set the
device's `outputName` live; KWin applies it immediately *and* writes it back
to `~/.config/kcminputrc` for you:

```bash
# Find the touch device's KWin event node (name == "wch.cn TouchScreen")
node=$(for d in $(qdbus6 org.kde.KWin /org/kde/KWin/InputDevice \
      org.kde.KWin.InputDeviceManager.devicesSysNames); do
  name=$(qdbus6 org.kde.KWin /org/kde/KWin/InputDevice/$d \
    org.freedesktop.DBus.Properties.Get org.kde.KWin.InputDevice name)
  [ "$name" = "wch.cn TouchScreen" ] && echo "$d" && break
done)

# Map it to the Edge's connector (e.g. HDMI-A-1 or DP-2; see `kscreen-doctor -o`)
qdbus6 org.kde.KWin /org/kde/KWin/InputDevice/$node \
  org.freedesktop.DBus.Properties.Set org.kde.KWin.InputDevice outputName HDMI-A-1
```

> **The gotcha:** KWin keys the touchscreen→display binding by the output's
> **UUID**, not just the connector name. If you write only `OutputName=` into
> `kcminputrc` by hand, KWin *ignores it on login* and leaves the touch panel
> unmapped; touches then span the whole desktop and land on your primary
> monitor (the classic "touch moves the cursor on the wrong screen"). Setting
> `outputName` via the GUI or the D-Bus method above makes KWin write **both**
> keys, so it sticks:
>
> ```ini
> [Libinput][10176][2137][wch.cn TouchScreen]
> Enabled=true
> OutputName=HDMI-A-1
> OutputUuid=2825c103-1a2c-4f11-a209-6c4c9120e578   # your Edge's UUID
> ```
>
> (`10176`/`2137` are the USB VID/PID `27c0`/`0859` in decimal. Get the UUID
> for your Edge from `kscreen-doctor -o`.)

Node numbers under `/dev/input` and KWin's `eventNN` reshuffle across reboots,
so always resolve the device by *name* (as above) or via
`/dev/input/by-id/usb-wch.cn_TouchScreen_*-event-if00`; never a hardcoded
`eventN`.

## Fix part 2: neutralize the mouse-emulation interface

The `if02` mouse interface is normally silent, but it remains an armed
footgun: if firmware ever routes reports through it, you get a *second*
pointer device with absolute coordinates and no output mapping. Since
libinput evaluates udev properties per event node, one rule hides it
permanently:

```udev
# /etc/udev/rules.d/99-xeneon-edge-touch.rules
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="27c0", ATTRS{idProduct}=="0859", \
  ENV{ID_INPUT_MOUSE}=="1", ENV{LIBINPUT_IGNORE_DEVICE}="1", ENV{ID_INPUT_MOUSE}=""
```

The match is scoped to this VID/PID *and* only the interface udev already
classified as a mouse, so the real digitizer is untouched. Apply with:

```bash
sudo cp udev/99-xeneon-edge-touch.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
# then unplug/replug the Edge's USB cable (libinput reads properties at device-add)
```

## Summary

1. Not a driver problem: the kernel supports the panel out of the box.
2. Not (primarily) the mouse-emulation HID: that interface is idle.
3. The real issue is an **unsolvable auto-association** between a generic
   USB touch controller and the monitor's EDID, which makes the compositor
   map touch coordinates to the wrong output.
4. One `gsettings` write with the exact EDID triple fixes it permanently and
   applies live; a udev rule defuses the redundant mouse interface as
   insurance.
