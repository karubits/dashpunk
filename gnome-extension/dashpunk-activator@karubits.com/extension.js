// Dashpunk Window Activator
//
// Exposes a D-Bus method on the GNOME Shell bus that activates (focuses and
// raises) an existing window matched by WM_CLASS, sandboxed app id (Flatpak)
// or GTK application id. Compositor-side activation is exempt from focus-
// stealing prevention, which launcher-spawned processes cannot bypass —
// notably Electron single-instance apps that drop their activation token.

import Gio from 'gi://Gio';

const IFACE = `
<node>
  <interface name="io.github.karubits.Dashpunk.WindowActivator">
    <method name="Activate">
      <arg type="s" direction="in" name="query"/>
      <arg type="b" direction="out" name="found"/>
    </method>
  </interface>
</node>`;

export default class WindowActivatorExtension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(
            Gio.DBus.session,
            '/io/github/karubits/Dashpunk/WindowActivator'
        );
    }

    disable() {
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
    }

    Activate(query) {
        const wanted = query.toLowerCase();
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w)
                continue;
            const ids = [
                w.get_wm_class_instance(),
                w.get_wm_class(),
                w.get_sandboxed_app_id(),
                w.get_gtk_application_id(),
            ];
            if (ids.some(id => id && id.toLowerCase().includes(wanted))) {
                w.activate(global.get_current_time());
                return true;
            }
        }
        return false;
    }
}
