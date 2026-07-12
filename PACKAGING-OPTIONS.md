# Packaging Options

Assessment of how (and whether) Dashpunk can be shipped as a
single file, written up for future reference.

## Why a true single binary is hard here

The app is Python on top of **GTK4 + WebKitGTK 6.0 via PyGObject** (plus
`psutil` and `python-dateutil`), and it loads its frontend from
`ui/index.html` on disk (see `UI_DIR` in `src/dashpunk/main.py`).

That splits the bundling question in two:

- **Bundles fine:** the `dashpunk` Python package, `psutil`, `dateutil`,
  and the `ui/` assets. Any Python bundler can carry these.
- **Doesn't bundle realistically: WebKitGTK.** It is not just a shared
  library; it spawns helper executables (`WebKitWebProcess`,
  `WebKitNetworkProcess`) and needs GSettings schemas, GIO modules, and
  injected-bundle libraries. Packing all of that into a portable executable
  is fragile and lands at several hundred MB. Every practical "single binary"
  approach still assumes `gtk4` and `webkitgtk-6.0` come from the distro,
  exactly what `install.sh` already checks for.

Also outside the scope of any binary, regardless of approach:

- External tools the app shells out to at runtime: `pactl`, `ping`.
- The udev rules (`udev/`) and the GNOME extension (`gnome-extension/`);
  these are system/desktop integration and must be installed separately.

## Options, ranked by effort

### 1. zipapp via `shiv` (lowest effort, recommended for Arch/CachyOS targets)

One `.pyz` file, executed by the system Python.

- Since PyGObject is essentially always installed as a distro package anyway
  (it does not pip-install cleanly without heavy build deps), this changes
  nothing about the dependency story; it just replaces the repo checkout
  with a single file.
- `ui/` assets can be bundled inside the zipapp; the loader would need to
  extract them (or `UI_DIR` adjusted to read from the archive/extract dir).
- Dependencies still required on the target: `python`, `python-gobject`,
  `python-psutil`, `python-dateutil`, `gtk4`, `webkitgtk-6.0`.

### 2. PyInstaller / Nuitka `--onefile` (moderate effort)

One true ELF executable; no Python interpreter needed on the target.

- Still requires system `gtk4` / `webkitgtk-6.0` packages; do **not** try to
  bundle WebKitGTK itself (see above).
- Needs PyInstaller's `gi` hooks so GObject typelibs are found, and
  `--add-data ui:ui` for the frontend.
- Code change required: `UI_DIR` in `src/dashpunk/main.py` currently resolves
  relative to the source tree; it must fall back to `sys._MEIPASS` (the
  PyInstaller extraction dir) when frozen.
- Worth it only if "no Python required on target" matters.

### 3. Flatpak (the real "one file, any distro" answer)

The only path to a genuinely self-contained distributable, because the GNOME
Flatpak runtime ships GTK4 + WebKitGTK inside.

- Standard route for GTK apps; the `org.gnome.Platform` runtime includes
  everything the app links against.
- Caveats: this app pokes at a lot of host state (hwmon/sysfs sensors, DRM
  connectors, `pactl`, D-Bus notification monitoring, spawning arbitrary
  launcher commands), so the manifest would need broad permissions
  (`--filesystem=host`, session bus talk permissions, `--device=all`) or
  `flatpak-spawn --host` for the shell-outs. Doable, but it is a packaging
  project, not an afternoon.

### 4. AppImage (possible, but rough)

Also a single portable file, but WebKitGTK inside AppImages has known rough
edges (helper process paths, schema lookup). Flatpak handles this stack much
better. Only consider if Flatpak is off the table.

## Recommendation

- Distributing to systems that already have the deps (Arch/CachyOS per the
  README): **shiv zipapp**, or **PyInstaller** if the target shouldn't need
  Python.
- Installable on any distro without touching the package manager:
  **Flatpak**. A single ELF binary cannot carry WebKitGTK reliably.
