#!/usr/bin/env bash
# Dashpunk — installer & health check.
#
#   ./install.sh            install & configure (idempotent — safe to re-run)
#   ./install.sh --verify   read-only health check, changes nothing
#
# Supports GNOME and KDE Plasma 6 (Wayland), with the Edge connected over
# HDMI or USB-C (DisplayPort alt mode). niri is detected with manual
# guidance (automatic support planned). See docs/TOUCHSCREEN.md for the
# technical background on the touch mapping.
set -euo pipefail

# ── constants ────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dashpunk"
CONFIG_PATH="$CONFIG_DIR/config.toml"
# Pre-rename config location (the app used to be "xeneon-edge")
LEGACY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/xeneon-edge"
KCMINPUTRC="${XDG_CONFIG_HOME:-$HOME/.config}/kcminputrc"
UDEV_SRC="$REPO_DIR/udev/99-xeneon-edge-touch.rules"
UDEV_DST="/etc/udev/rules.d/99-xeneon-edge-touch.rules"
EXT_UUID="dashpunk-activator@karubits.com"
LEGACY_EXT_UUID="xeneon-edge-activator@karubits.com"

USB_ID="27c0:0859"              # wch.cn touch controller VID:PID
VID_DEC=10176 PID_DEC=2137      # same in decimal (KWin kcminputrc group keys)
TOUCH_NAME="wch.cn TouchScreen"

DESKTOP_CONTENT="[Desktop Entry]
Type=Application
Name=Dashpunk
Comment=A Linux cyberdeck for the Corsair Xeneon Edge
Exec=$REPO_DIR/dashpunk
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
X-GNOME-Autostart-enabled=true"

# ── colors & output helpers ──────────────────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    RED=$'\e[31m' GRN=$'\e[32m' YLW=$'\e[33m' CYN=$'\e[36m' MAG=$'\e[35m'
    BLD=$'\e[1m' DIM=$'\e[2m' RST=$'\e[0m'
else
    RED='' GRN='' YLW='' CYN='' MAG='' BLD='' DIM='' RST=''
fi
OKG="${GRN}✔${RST}" BADG="${RED}✗${RST}" WRNG="${YLW}⚠${RST}" ARR="${CYN}→${RST}"

header()  { printf '\n%s%s── %s ──%s\n' "$BLD" "$CYN" "$1" "$RST"; }
ok()      { printf ' %s %b\n' "$OKG" "$1"; }
already() { printf ' %s %b %s(already configured)%s\n' "$OKG" "$1" "$DIM" "$RST"; }
warn()    { printf ' %s %b\n' "$WRNG" "$1"; }
fail()    { printf ' %s %b\n' "$BADG" "$1"; }
info()    { printf ' %s %b\n' "$ARR" "$1"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# ── result tracking ──────────────────────────────────────────────────────────
R_NAME=() R_STATUS=() R_DETAIL=()
MANUAL_STEPS=()
NOTES=()
record()     { R_NAME+=("$1"); R_STATUS+=("$2"); R_DETAIL+=("$3"); }
add_manual() { MANUAL_STEPS+=("$1"); }
add_note()   { NOTES+=("$1"); }

# Isolate each check: a bug in one check records a FAIL instead of killing
# the whole run (the `if !` context also disables errexit inside the check).
run_check() {
    local fn="$1"
    if ! "$fn"; then
        record "$fn" FAIL "check errored unexpectedly (bug — please report)"
    fi
}

# ── flag parsing ─────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
${BLD}Dashpunk installer${RST}

Usage: ./install.sh [--verify]

  (no args)   Install & configure everything. Idempotent — safe to re-run;
              already-configured steps are detected and skipped.
                • dependency check (Arch/CachyOS package names)
                • Edge display detection (HDMI or USB-C/DisplayPort)
                • touch controller detection (USB $USB_ID)
                • config connector sync (~/.config/dashpunk/config.toml)
                • udev rule for the mouse-emulation interface (one sudo prompt)
                • touch→display mapping (GNOME and KDE Plasma 6; niri: guidance)
                • GNOME Shell window-activator extension (GNOME only)
                • app-menu entry + autostart on login

  --verify    Read-only health check of all of the above. Never writes,
              never asks for sudo. Exits 1 if any check fails.

  --help      This help.
EOF
}

MODE=install
case "${1:-}" in
    --verify|verify|--check|check) MODE=verify ;;
    --help|-h) usage; exit 0 ;;
    "") ;;
    *) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
esac

if [[ $EUID -eq 0 ]]; then
    echo "Run this as your login user, not root — touch mapping and autostart are" >&2
    echo "per-user settings. The script asks for sudo itself when needed (udev rule)." >&2
    exit 1
fi

# ── detection library (pure, read-only) ──────────────────────────────────────
DESKTOP=UNKNOWN
SESSION_TYPE="${XDG_SESSION_TYPE:-unknown}"
case "${XDG_CURRENT_DESKTOP:-}" in
    *GNOME*)      DESKTOP=GNOME ;;
    *KDE*)        DESKTOP=KDE ;;
    *[Nn]iri*)    DESKTOP=NIRI ;;
esac

EDGE_CONNECTOR="" EDGE_TRANSPORT="" EDGE_EXTRA=()
detect_edge_connector() {
    local d name
    for d in /sys/class/drm/card*-*; do
        [[ -f "$d/status" ]] || continue
        [[ "$(cat "$d/status")" == connected ]] || continue
        # EDID product-name match first; 2560x720 native mode as fallback
        if grep -qa "XENEON EDGE" "$d/edid" 2>/dev/null \
           || grep -qs '^2560x720' "$d/modes"; then
            name="${d##*/}"; name="${name#card*-}"
            if [[ -z $EDGE_CONNECTOR ]]; then
                EDGE_CONNECTOR="$name"
            else
                EDGE_EXTRA+=("$name")
            fi
        fi
    done
    case "$EDGE_CONNECTOR" in
        HDMI*)    EDGE_TRANSPORT="HDMI" ;;
        DP*|eDP*) EDGE_TRANSPORT="DisplayPort / USB-C" ;;
    esac
    return 0
}

TOUCH_USB=false TOUCH_DIGITIZER="" TOUCH_MOUSE_EMU=""
detect_touch() {
    if have lsusb && lsusb -d "$USB_ID" >/dev/null 2>&1; then
        TOUCH_USB=true
    fi
    # Stable by-id paths — event node numbers reshuffle across reboots,
    # never hardcode eventN.
    local n
    n=$(readlink -f /dev/input/by-id/usb-wch.cn_TouchScreen_*-event-if00 2>/dev/null | head -1) || true
    [[ -e "${n:-/nonexistent}" ]] && TOUCH_DIGITIZER="$n"
    n=$(readlink -f /dev/input/by-id/usb-wch.cn_TouchScreen_*-if02-event-mouse 2>/dev/null | head -1) || true
    [[ -e "${n:-/nonexistent}" ]] && TOUCH_MOUSE_EMU="$n"
    [[ -n $TOUCH_DIGITIZER ]] && TOUCH_USB=true
    return 0
}

# ── check: dependencies ──────────────────────────────────────────────────────
check_dependencies() {
    header "Dependencies"
    local missing=() p
    if have pacman; then
        for p in gtk4 webkitgtk-6.0 python-gobject python-psutil; do
            pacman -Q "$p" >/dev/null 2>&1 || missing+=("$p")
        done
        have pactl || missing+=(libpulse)
        if ((${#missing[@]})); then
            fail "missing packages: ${BLD}${missing[*]}${RST}"
            add_manual "sudo pacman -S ${missing[*]}"
            record "Dependencies" FAIL "missing: ${missing[*]}"
        else
            ok "gtk4, webkitgtk-6.0, python-gobject, python-psutil, libpulse"
            record "Dependencies" PASS "all present"
        fi
    else
        # Non-Arch: probe what we can and name the rest
        python3 -c 'import gi' 2>/dev/null || missing+=("python gobject (gi)")
        python3 -c 'import psutil' 2>/dev/null || missing+=("python psutil")
        have pactl || missing+=("pactl (libpulse)")
        if ((${#missing[@]})); then
            warn "non-Arch system — install equivalents of: ${missing[*]}, gtk4, webkitgtk-6.0"
            record "Dependencies" WARN "non-Arch; missing: ${missing[*]}"
        else
            warn "non-Arch system — python bindings + pactl OK (gtk4/webkitgtk not probed)"
            record "Dependencies" WARN "non-Arch; core probes passed"
        fi
    fi
    # Desktop tooling needed for the touch mapping (warn-level)
    if [[ $DESKTOP == GNOME ]] && ! have gsettings; then
        warn "gsettings not found — GNOME touch mapping unavailable"
    elif [[ $DESKTOP == KDE ]] && ! have qdbus6; then
        warn "qdbus6 not found (${DIM}sudo pacman -S qt6-tools${RST}) — KDE touch mapping unavailable"
    fi
    return 0
}

# ── check: Edge display ──────────────────────────────────────────────────────
check_display() {
    header "Xeneon Edge display"
    if [[ -n $EDGE_CONNECTOR ]]; then
        ok "found on ${BLD}${EDGE_CONNECTOR}${RST} (${EDGE_TRANSPORT:-unknown transport})"
        if ((${#EDGE_EXTRA[@]})); then
            warn "multiple Edge-like outputs (${EDGE_CONNECTOR} ${EDGE_EXTRA[*]}) — using ${EDGE_CONNECTOR}"
        fi
        record "Edge display" PASS "$EDGE_CONNECTOR (${EDGE_TRANSPORT:-?})"
    else
        fail "no connected output matches the Xeneon Edge (EDID \"XENEON EDGE\" / 2560x720)"
        info "connected outputs right now:"
        local d n
        for d in /sys/class/drm/card*-*; do
            [[ -f "$d/status" && "$(cat "$d/status")" == connected ]] || continue
            n="${d##*/}"
            printf '     %s%-12s%s %s\n' "$DIM" "${n#card*-}" "$RST" "$(head -1 "$d/modes" 2>/dev/null)"
        done
        info "check the video cable & monitor power; a USB-C port must support DP alt mode"
        record "Edge display" FAIL "not detected"
    fi
    return 0
}

# ── check: touch controller ──────────────────────────────────────────────────
check_touch() {
    header "Touch controller (USB $USB_ID)"
    if [[ -n $TOUCH_DIGITIZER ]]; then
        ok "digitizer present ${DIM}(${TOUCH_DIGITIZER})${RST}"
        record "Touch controller" PASS "digitizer at ${TOUCH_DIGITIZER##*/}"
    elif $TOUCH_USB; then
        warn "USB device present but its input node is missing — unplug/replug the Edge's USB cable"
        record "Touch controller" WARN "USB seen, no input node"
    else
        fail "touch controller not found on USB"
        info "touch uses the Edge's ${BLD}separate USB cable${RST} (independent of the video cable)"
        info "plug it in, then re-run ./install.sh"
        record "Touch controller" FAIL "not connected"
    fi
    return 0
}

# ── check: app config connector sync ─────────────────────────────────────────
get_config_connector() {
    sed -n '/^\[display\]/,/^\[/{s/^[[:space:]]*connector[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p}' \
        "$CONFIG_PATH" 2>/dev/null | head -1
}

set_config_connector() {
    # Rewrite the first connector= line inside [display] only.
    local tmp; tmp=$(mktemp)
    awk -v conn="$EDGE_CONNECTOR" '
        /^\[/ { indisp = ($0 == "[display]") }
        indisp && !done && $0 ~ /^[[:space:]]*connector[[:space:]]*=/ {
            print "connector = \"" conn "\""; done=1; next
        }
        { print }
    ' "$CONFIG_PATH" > "$tmp" && mv "$tmp" "$CONFIG_PATH"
}

backup_config() {
    local bak
    bak="$CONFIG_PATH.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CONFIG_PATH" "$bak"
    printf '%s' "${bak##*/}"
}

check_config() {
    header "App config ($CONFIG_PATH)"
    if [[ -z $EDGE_CONNECTOR ]]; then
        warn "skipped — Edge display not detected, nothing to sync the connector to"
        record "Config connector" SKIP "display not detected"
        return 0
    fi
    # Migrate a pre-rename config dir (~/.config/xeneon-edge) before anything
    # else — the app does the same at startup; doing it here too means a fresh
    # install.sh run never shadows an existing setup with example defaults.
    if [[ ! -d $CONFIG_DIR && -d $LEGACY_CONFIG_DIR ]]; then
        if [[ $MODE == install ]]; then
            mv "$LEGACY_CONFIG_DIR" "$CONFIG_DIR"
            ok "migrated legacy config ${DIM}$LEGACY_CONFIG_DIR${RST} $ARR ${DIM}$CONFIG_DIR${RST}"
        else
            warn "legacy config at $LEGACY_CONFIG_DIR — install mode (or the app) will migrate it"
        fi
    fi
    if [[ ! -f $CONFIG_PATH ]]; then
        if [[ $MODE == install ]]; then
            mkdir -p "$CONFIG_DIR"
            cp "$REPO_DIR/config.example.toml" "$CONFIG_PATH"
            set_config_connector
            ok "created from config.example.toml with connector = \"$EDGE_CONNECTOR\""
            record "Config connector" PASS "created; connector=$EDGE_CONNECTOR"
        else
            warn "config missing — the app would write defaults with connector \"DP-2\" (likely wrong here)"
            record "Config connector" WARN "config.toml missing"
        fi
        return 0
    fi
    local cur; cur=$(get_config_connector)
    if [[ $cur == "$EDGE_CONNECTOR" ]]; then
        already "connector = \"$cur\""
        record "Config connector" PASS "connector=$cur"
    elif [[ -z $cur ]]; then
        if grep -q '^\[display\]' "$CONFIG_PATH"; then
            if [[ $MODE == install ]]; then
                local bak; bak=$(backup_config)
                sed -i "/^\[display\]/a connector = \"$EDGE_CONNECTOR\"" "$CONFIG_PATH"
                ok "added connector = \"$EDGE_CONNECTOR\" under [display] ${DIM}(backup: $bak)${RST}"
                record "Config connector" PASS "added $EDGE_CONNECTOR"
            else
                fail "no connector line under [display] — should be \"$EDGE_CONNECTOR\""
                record "Config connector" FAIL "connector line missing"
            fi
        else
            warn "no [display] section in config.toml — add one with connector = \"$EDGE_CONNECTOR\""
            record "Config connector" WARN "no [display] section"
        fi
    else
        if [[ $MODE == install ]]; then
            local bak; bak=$(backup_config)
            set_config_connector
            ok "connector updated \"$cur\" $ARR \"$EDGE_CONNECTOR\" ${DIM}(backup: $bak)${RST}"
            record "Config connector" PASS "updated $cur → $EDGE_CONNECTOR"
        else
            fail "config says \"$cur\" but the Edge is on \"$EDGE_CONNECTOR\""
            record "Config connector" FAIL "$cur ≠ $EDGE_CONNECTOR"
        fi
    fi
    return 0
}

# ── sudo handling (lazy, asked at most once, never fatal) ────────────────────
SUDO_OK=""
need_sudo() {
    [[ $MODE == verify ]] && return 1
    [[ $SUDO_OK == yes ]] && return 0
    [[ $SUDO_OK == no  ]] && return 1
    if ! have sudo; then
        SUDO_OK=no
        warn "sudo not available — root steps will be listed for you to run manually"
        return 1
    fi
    info "root access is needed once, to install the udev rule (touch mouse-emulation fix)"
    if sudo -v; then
        SUDO_OK=yes
        return 0
    fi
    SUDO_OK=no
    warn "sudo declined — root steps will be listed for you to run manually"
    return 1
}

# ── check: udev rule ─────────────────────────────────────────────────────────
udev_active() {
    # True when libinput is ignoring the mouse-emulation interface.
    [[ -n $TOUCH_MOUSE_EMU ]] || return 1
    local props
    props=$(udevadm info "$TOUCH_MOUSE_EMU" 2>/dev/null) || return 1
    [[ $props == *"LIBINPUT_IGNORE_DEVICE=1"* ]]
}

check_udev() {
    header "udev rule (hide the mouse-emulation interface)"
    local was_installed=false
    if cmp -s "$UDEV_SRC" "$UDEV_DST" 2>/dev/null; then
        was_installed=true
    fi

    if ! $was_installed; then
        if [[ $MODE == install ]] && need_sudo; then
            if sudo install -m644 "$UDEV_SRC" "$UDEV_DST" && sudo udevadm control --reload-rules; then
                ok "rule installed to $UDEV_DST"
            else
                fail "failed to install the rule"
                record "udev rule" FAIL "install failed"
                return 0
            fi
        else
            if [[ -e $UDEV_DST ]]; then
                warn "rule at $UDEV_DST differs from the repo copy"
            else
                warn "rule not installed"
            fi
            add_manual "sudo install -m644 '$UDEV_SRC' '$UDEV_DST'"
            add_manual "sudo udevadm control --reload-rules   # then replug the Edge's USB cable"
            if [[ $MODE == verify ]]; then
                record "udev rule" FAIL "not installed"
            else
                record "udev rule" WARN "not installed (sudo unavailable)"
            fi
            return 0
        fi
    fi

    # Activity probe: rule on disk ≠ rule applied (libinput reads udev
    # properties at device-add time).
    if [[ -z $TOUCH_MOUSE_EMU ]]; then
        ok "rule installed ${DIM}(mouse-emu node absent right now — nothing to probe)${RST}"
        record "udev rule" PASS "installed; if02 node not present"
        return 0
    fi
    if udev_active; then
        if $was_installed; then
            already "active — mouse-emulation interface hidden from libinput"
        else
            ok "active — mouse-emulation interface hidden from libinput"
        fi
        record "udev rule" PASS "active on ${TOUCH_MOUSE_EMU##*/}"
    else
        if [[ $MODE == install && $SUDO_OK == yes ]]; then
            # Best-effort re-add so the new properties apply without a replug.
            sudo udevadm trigger --action=add "/sys/class/input/${TOUCH_MOUSE_EMU##*/}" 2>/dev/null || true
            sleep 0.5
        fi
        if udev_active; then
            ok "rule active ${DIM}(applied via udevadm trigger)${RST}"
            record "udev rule" PASS "active"
        else
            warn "rule installed but not active yet — unplug/replug the Edge's USB cable (or reboot)"
            add_note "Replug the Edge's USB cable so the udev rule takes effect."
            record "udev rule" WARN "installed, pending replug"
        fi
    fi
    return 0
}

# ── check: touch → display mapping ───────────────────────────────────────────
GS_SCHEMA="org.gnome.desktop.peripherals.touchscreen:/org/gnome/desktop/peripherals/touchscreens/$USB_ID/"

edge_edid_triple() {
    # Ask Mutter for the Edge's EDID identity: ['CRX', 'XENEON EDGE', '<serial>']
    python3 - <<'PYEOF' 2>/dev/null
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
res = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None,
    Gio.DBusCallFlags.NONE, 5000, None)
for (connector, vendor, product, serial), modes, props in res.unpack()[1]:
    if 'XENEON EDGE' in product.upper():
        print(f"['{vendor}', '{product}', '{serial}']")
        break
PYEOF
}

map_touch_gnome() {
    if ! have gsettings; then
        warn "gsettings not available — cannot manage the GNOME mapping"
        record "Touch mapping" WARN "gsettings missing"
        return 0
    fi
    local want cur
    want=$(edge_edid_triple)
    if [[ -z $want ]]; then
        warn "Mutter doesn't report a XENEON EDGE monitor — run this inside the GNOME session"
        record "Touch mapping" WARN "Mutter: Edge not reported"
        return 0
    fi
    cur=$(gsettings get "$GS_SCHEMA" output 2>/dev/null) || cur=""
    if [[ $cur == "$want" ]]; then
        already "touchscreen mapped to $want"
        record "Touch mapping" PASS "GNOME: mapped"
    elif [[ $MODE == install ]]; then
        gsettings set "$GS_SCHEMA" output "$want"
        cur=$(gsettings get "$GS_SCHEMA" output 2>/dev/null) || cur=""
        if [[ $cur == "$want" ]]; then
            ok "touchscreen mapped to $want ${DIM}(Mutter applies this live)${RST}"
            record "Touch mapping" PASS "GNOME: mapped"
        else
            fail "gsettings set did not stick (read back: ${cur:-nothing})"
            record "Touch mapping" FAIL "GNOME: set failed"
        fi
    else
        fail "not mapped (current: ${cur:-unset})"
        add_manual "gsettings set $GS_SCHEMA output \"$want\""
        record "Touch mapping" FAIL "GNOME: unmapped"
    fi
    return 0
}

kwin_prop() {  # kwin_prop <eventNN> <property>
    # NB: qdbus6 property shorthand fails on these objects — must go through
    # org.freedesktop.DBus.Properties.
    qdbus6 org.kde.KWin "/org/kde/KWin/InputDevice/$1" \
        org.freedesktop.DBus.Properties.Get org.kde.KWin.InputDevice "$2" 2>/dev/null
}

kwin_find_touch() {
    # The mouse-emulation interface shares the device name, so require
    # touch == true, not just the name match.
    local d
    for d in $(qdbus6 org.kde.KWin /org/kde/KWin/InputDevice \
                 org.kde.KWin.InputDeviceManager.devicesSysNames 2>/dev/null); do
        [[ "$(kwin_prop "$d" name)" == "$TOUCH_NAME" ]] || continue
        [[ "$(kwin_prop "$d" touch)" == "true" ]] || continue
        printf '%s' "$d"
        return 0
    done
    return 1
}

kcm_get() {  # kcm_get <key> → value from the touchscreen group in kcminputrc
    awk -v grp="[Libinput][$VID_DEC][$PID_DEC][$TOUCH_NAME]" -v key="$1" -F= '
        $0 == grp { g=1; next }
        /^\[/     { g=0 }
        g && $1 == key { print substr($0, index($0,"=")+1); exit }
    ' "$KCMINPUTRC" 2>/dev/null
}

map_touch_kde() {
    if ! have qdbus6; then
        warn "qdbus6 not found (${DIM}sudo pacman -S qt6-tools${RST}) — cannot manage the KWin mapping"
        record "Touch mapping" WARN "qdbus6 missing"
        return 0
    fi
    local node cur
    if ! node=$(kwin_find_touch); then
        warn "KWin D-Bus unreachable or touch device not listed — run this inside the Plasma session"
        record "Touch mapping" WARN "KWin: device not found"
        return 0
    fi
    cur=$(kwin_prop "$node" outputName)
    if [[ $cur == "$EDGE_CONNECTOR" ]]; then
        # KWin binds by display UUID; OutputName alone does not survive login.
        if [[ -n "$(kcm_get OutputUuid)" ]]; then
            already "KWin maps '$TOUCH_NAME' $ARR $EDGE_CONNECTOR ${DIM}(persisted with OutputUuid)${RST}"
            record "Touch mapping" PASS "KDE: mapped + persisted"
        else
            warn "mapped live, but kcminputrc lacks OutputUuid — may not survive logout; re-run after next login"
            record "Touch mapping" WARN "KDE: live only, persistence unconfirmed"
        fi
        return 0
    fi
    if [[ $MODE == install ]]; then
        # Set it live via D-Bus: KWin applies immediately AND persists both
        # OutputName and OutputUuid to kcminputrc itself. (Hand-writing
        # OutputName into kcminputrc is ignored by KWin — proven the hard way.)
        qdbus6 org.kde.KWin "/org/kde/KWin/InputDevice/$node" \
            org.freedesktop.DBus.Properties.Set org.kde.KWin.InputDevice \
            outputName "$EDGE_CONNECTOR" 2>/dev/null || true
        cur=$(kwin_prop "$node" outputName)
        if [[ $cur == "$EDGE_CONNECTOR" ]]; then
            if [[ -n "$(kcm_get OutputUuid)" ]]; then
                ok "mapped '$TOUCH_NAME' $ARR $EDGE_CONNECTOR ${DIM}(KWin persisted OutputName + OutputUuid)${RST}"
                record "Touch mapping" PASS "KDE: mapped + persisted"
            else
                warn "mapped live, but KWin didn't write OutputUuid — check System Settings → Mouse & Touchpad → Touchscreen"
                record "Touch mapping" WARN "KDE: mapped, persistence unconfirmed"
            fi
        else
            fail "D-Bus set didn't stick (outputName now: '${cur:-empty}')"
            record "Touch mapping" FAIL "KDE: set failed"
        fi
    else
        local pname puuid
        pname=$(kcm_get OutputName); puuid=$(kcm_get OutputUuid)
        if [[ -n $pname && -z $puuid ]]; then
            fail "kcminputrc has OutputName but no OutputUuid — KWin ignores hand-edited entries"
            info "run ./install.sh to set it via D-Bus (KWin then persists both keys)"
            record "Touch mapping" FAIL "KDE: hand-edit trap (OutputName without OutputUuid)"
        else
            fail "not mapped (live outputName: '${cur:-unset}', want $EDGE_CONNECTOR)"
            info "run ./install.sh, or: System Settings → Mouse & Touchpad → Touchscreen"
            record "Touch mapping" FAIL "KDE: unmapped"
        fi
    fi
    return 0
}

map_touch_niri() {
    local kdl="${XDG_CONFIG_HOME:-$HOME/.config}/niri/config.kdl"
    warn "niri detected — automatic touch mapping is not implemented yet (planned)"
    if grep -qs 'map-to-output' "$kdl"; then
        info "$kdl already has a map-to-output — verify it targets \"$EDGE_CONNECTOR\""
        record "Touch mapping" WARN "niri: map-to-output present, not verified"
    else
        info "add this to $kdl:"
        printf '     %sinput {\n         touch {\n             map-to-output "%s"\n         }\n     }%s\n' \
            "$DIM" "$EDGE_CONNECTOR" "$RST"
        record "Touch mapping" WARN "niri: manual config.kdl needed"
    fi
    return 0
}

check_mapping() {
    header "Touch → display mapping (${DESKTOP}, ${SESSION_TYPE})"
    if [[ -z $EDGE_CONNECTOR ]]; then
        warn "skipped — Edge display not detected"
        record "Touch mapping" SKIP "display not detected"
        return 0
    fi
    if [[ $SESSION_TYPE == x11 ]]; then
        warn "X11 session — compositor mapping doesn't apply; use xinput (session-scoped):"
        info "xinput map-to-output '$TOUCH_NAME' $EDGE_CONNECTOR"
        add_manual "xinput map-to-output '$TOUCH_NAME' $EDGE_CONNECTOR   # X11: add to an autostart script"
        record "Touch mapping" WARN "X11: xinput needed per session"
        return 0
    fi
    case "$DESKTOP" in
        GNOME) map_touch_gnome ;;
        KDE)   map_touch_kde ;;
        NIRI)  map_touch_niri ;;
        *)
            warn "unrecognized desktop '${XDG_CURRENT_DESKTOP:-?}' — see docs/TOUCHSCREEN.md for manual options"
            record "Touch mapping" WARN "unsupported desktop"
            ;;
    esac
    return 0
}

# ── check: GNOME Shell extension (GNOME only) ────────────────────────────────
check_gnome_extension() {
    [[ $DESKTOP == GNOME ]] || { record "GNOME extension" SKIP "not GNOME"; return 0; }
    header "GNOME Shell extension (window activator)"
    local src="$REPO_DIR/gnome-extension/$EXT_UUID"
    local dst="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
    local synced=false enabled=false lst
    diff -rq "$src" "$dst" >/dev/null 2>&1 && synced=true
    if have gnome-extensions; then
        lst=$(gnome-extensions list --enabled 2>/dev/null) || lst=""
    else
        lst=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null) || lst=""
    fi
    [[ $lst == *"$EXT_UUID"* ]] && enabled=true

    if $synced && $enabled; then
        already "installed and enabled"
        record "GNOME extension" PASS "installed + enabled"
        return 0
    fi
    if [[ $MODE == install ]]; then
        # Clean up the pre-rename extension if present
        local extdir="${dst%/*}"
        if [[ -d "$extdir/$LEGACY_EXT_UUID" ]]; then
            gnome-extensions disable "$LEGACY_EXT_UUID" 2>/dev/null || true
            rm -rf "${extdir:?}/$LEGACY_EXT_UUID"
            info "removed legacy extension $LEGACY_EXT_UUID"
        fi
        mkdir -p "${dst%/*}"
        cp -r "$src" "${dst%/*}/"
        gnome-extensions enable "$EXT_UUID" 2>/dev/null || python3 - <<'PYEOF'
import subprocess, ast
cur = subprocess.run(["gsettings","get","org.gnome.shell","enabled-extensions"],capture_output=True,text=True).stdout.strip()
lst = [] if cur in ("@as []","[]") else ast.literal_eval(cur)
uuid = "dashpunk-activator@karubits.com"
old = "xeneon-edge-activator@karubits.com"
if old in lst:
    lst.remove(old)
if uuid not in lst:
    lst.append(uuid)
subprocess.run(["gsettings","set","org.gnome.shell","enabled-extensions",str(lst)])
PYEOF
        ok "installed + enabled ${DIM}(log out/in once to load it)${RST}"
        add_note "Log out/in once so GNOME Shell loads the window-activator extension."
        record "GNOME extension" PASS "installed (loads after re-login)"
    else
        warn "not fully installed (files synced: $synced, enabled: $enabled)"
        record "GNOME extension" WARN "not fully installed"
    fi
    return 0
}

# ── check: app menu + autostart entries ──────────────────────────────────────
ensure_desktop_file() {  # $1 = path, $2 = label
    local path="$1" label="$2" cur_exec=""
    if [[ -f $path ]]; then
        cur_exec=$(grep -m1 '^Exec=' "$path") || cur_exec=""
        if [[ $cur_exec == "Exec=$REPO_DIR/dashpunk" ]]; then
            already "$label entry"
            record "$label entry" PASS "Exec path correct"
            return 0
        fi
        if [[ $MODE == install ]]; then
            printf '%s\n' "$DESKTOP_CONTENT" > "$path"
            ok "$label entry updated ${DIM}(stale Exec was: ${cur_exec#Exec=})${RST}"
            record "$label entry" PASS "Exec path refreshed"
        else
            fail "$label entry points at '${cur_exec#Exec=}' but the repo is at $REPO_DIR"
            record "$label entry" FAIL "stale Exec path"
        fi
    else
        if [[ $MODE == install ]]; then
            mkdir -p "${path%/*}"
            printf '%s\n' "$DESKTOP_CONTENT" > "$path"
            ok "$label entry installed ${DIM}($path)${RST}"
            record "$label entry" PASS "created"
        else
            fail "$label entry missing ($path)"
            record "$label entry" FAIL "missing"
        fi
    fi
    return 0
}

check_desktop_entries() {
    header "App menu & autostart"
    if [[ $MODE == install ]]; then
        chmod +x "$REPO_DIR/dashpunk" 2>/dev/null || true
    fi
    if [[ ! -x "$REPO_DIR/dashpunk" ]]; then
        warn "launcher $REPO_DIR/dashpunk is not executable"
    fi
    # Remove pre-rename entries so two dashboards don't autostart
    local legacy
    for legacy in "$HOME/.local/share/applications/xeneon-edge.desktop" \
                  "$HOME/.config/autostart/xeneon-edge.desktop"; do
        if [[ -f $legacy ]]; then
            if [[ $MODE == install ]]; then
                rm -f "$legacy"
                info "removed legacy entry ${DIM}$legacy${RST}"
            else
                warn "legacy entry $legacy still present — install mode removes it"
            fi
        fi
    done
    ensure_desktop_file "$HOME/.local/share/applications/dashpunk.desktop" "App menu"
    ensure_desktop_file "$HOME/.config/autostart/dashpunk.desktop" "Autostart"
    return 0
}

# ── summary ──────────────────────────────────────────────────────────────────
print_summary() {
    header "Summary"
    local i glyph npass=0 nwarn=0 nfail=0 nskip=0
    for i in "${!R_NAME[@]}"; do
        case "${R_STATUS[$i]}" in
            PASS) glyph="$OKG";          npass=$((npass+1)) ;;
            WARN) glyph="$WRNG";         nwarn=$((nwarn+1)) ;;
            FAIL) glyph="$BADG";         nfail=$((nfail+1)) ;;
            SKIP) glyph="${DIM}·${RST}"; nskip=$((nskip+1)) ;;
        esac
        printf ' %s %-20s %s%s%s\n' "$glyph" "${R_NAME[$i]}" "$DIM" "${R_DETAIL[$i]}" "$RST"
    done

    printf '\n %s%d passed%s' "$GRN" "$npass" "$RST"
    if (( nwarn > 0 )); then printf ', %s%d warning(s)%s' "$YLW" "$nwarn" "$RST"; fi
    if (( nfail > 0 )); then printf ', %s%d failed%s' "$RED" "$nfail" "$RST"; fi
    if (( nskip > 0 )); then printf ', %s%d skipped%s' "$DIM" "$nskip" "$RST"; fi
    printf '\n'

    if ((${#MANUAL_STEPS[@]})); then
        printf '\n %sRun these manually:%s\n' "$BLD" "$RST"
        local s
        for s in "${MANUAL_STEPS[@]}"; do
            printf '   %s\n' "$s"
        done
    fi
    if ((${#NOTES[@]})); then
        printf '\n'
        local n
        for n in "${NOTES[@]}"; do
            printf ' %s %s\n' "$WRNG" "$n"
        done
    fi

    printf '\n %sLaunch now:%s   %s/dashpunk\n' "$BLD" "$RST" "$REPO_DIR"
    printf ' %sConfig:%s       %s\n' "$BLD" "$RST" "$CONFIG_PATH"
    if [[ $MODE == install ]]; then
        printf ' %sHealth check:%s ./install.sh --verify\n' "$BLD" "$RST"
    fi
    printf '\n'
    return $(( nfail > 0 ? 1 : 0 ))
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
    printf '\n%s%s╔════════════════════════════════════════════╗%s\n' "$BLD" "$MAG" "$RST"
    printf '%s%s║          D A S H P U N K — INSTALLER       ║%s\n'   "$BLD" "$MAG" "$RST"
    printf '%s%s╚════════════════════════════════════════════╝%s\n'   "$BLD" "$MAG" "$RST"
    if [[ $MODE == verify ]]; then
        printf ' %sVERIFY MODE — read-only, no changes will be made%s\n' "$YLW" "$RST"
    fi
    printf ' %sdesktop:%s %s (%s)   %srepo:%s %s\n' \
        "$DIM" "$RST" "$DESKTOP" "$SESSION_TYPE" "$DIM" "$RST" "$REPO_DIR"

    detect_edge_connector
    detect_touch

    run_check check_dependencies
    run_check check_display
    run_check check_touch
    run_check check_config
    run_check check_udev
    run_check check_mapping
    run_check check_gnome_extension
    run_check check_desktop_entries

    local rc=0
    print_summary || rc=$?
    exit "$rc"
}

main
