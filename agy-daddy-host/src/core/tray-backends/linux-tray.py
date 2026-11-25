#!/usr/bin/env python3
import argparse
import json
import os
import sys

try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, GLib
except Exception as exc:
    sys.stderr.write(f"GTK3 unavailable: {exc}\n")
    sys.exit(2)

HAS_INDICATOR = False
AppIndicator3 = None
for ns in ("AyatanaAppIndicator3", "AppIndicator3"):
    try:
        gi.require_version(ns, "0.1")
        AppIndicator3 = __import__(f"gi.repository.{ns}", fromlist=[ns])
        HAS_INDICATOR = True
        break
    except Exception:
        continue


def emit_event(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class LinuxTrayApp:
    def __init__(self, icon_path, tooltip):
        self.icon_path = icon_path
        self.tooltip = tooltip or "Agy-Daddy Launcher"
        self.indicator = None
        self.status_icon = None
        self.menu = self.build_menu([])

        if HAS_INDICATOR and AppIndicator3 is not None:
            icon_name = icon_path if (icon_path and os.path.exists(icon_path)) else "application-x-executable"
            self.indicator = AppIndicator3.Indicator.new(
                "agy-daddy-launcher",
                icon_name,
                AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
            )
            self.indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
            self.indicator.set_title(self.tooltip)
            self.indicator.set_menu(self.menu)
        else:
            if icon_path and os.path.exists(icon_path):
                self.status_icon = Gtk.StatusIcon.new_from_file(icon_path)
            else:
                self.status_icon = Gtk.StatusIcon.new_from_icon_name("application-x-executable")
            self.status_icon.set_tooltip_text(self.tooltip)
            self.status_icon.connect("popup-menu", self.on_popup_menu)

    def on_popup_menu(self, icon, button, activate_time):
        self.menu.popup(None, None, Gtk.StatusIcon.position_menu, icon, button, activate_time)

    def build_menu(self, items):
        menu = Gtk.Menu()
        for spec in items or []:
            item_type = spec.get("type") or "normal"
            if item_type == "separator":
                sep = Gtk.SeparatorMenuItem()
                sep.show()
                menu.append(sep)
                continue

            label = spec.get("label") or spec.get("id") or ""
            icon = spec.get("icon") or ""
            if icon and len(icon) <= 4 and not os.path.exists(icon):
                label = f"{icon} {label}"

            if item_type == "checkbox":
                mi = Gtk.CheckMenuItem(label=label)
                mi.set_active(bool(spec.get("checked")))
            else:
                mi = Gtk.MenuItem(label=label)

            mi.set_sensitive(spec.get("enabled", True) is not False)
            if spec.get("tooltip"):
                mi.set_tooltip_text(str(spec["tooltip"]))

            submenu = spec.get("submenu")
            if item_type == "submenu" and isinstance(submenu, list) and submenu:
                mi.set_submenu(self.build_menu(submenu))
            else:
                item_id = spec.get("id")
                mi.connect("activate", lambda _w, iid=item_id: emit_event({"type": "click", "itemId": iid}))

            mi.show()
            menu.append(mi)
        return menu

    def handle_command(self, cmd):
        ctype = cmd.get("type")
        if ctype == "update-menu":
            self.menu = self.build_menu(cmd.get("items") or [])
            title = str(cmd.get("title") or "").strip()
            tooltip = str(cmd.get("tooltip") or self.tooltip)
            if self.indicator is not None:
                self.indicator.set_menu(self.menu)
                self.indicator.set_title(title or tooltip)
                try:
                    self.indicator.set_label(title, "")
                except Exception:
                    pass
            elif self.status_icon is not None:
                self.status_icon.set_tooltip_text(f"{title} - {tooltip}" if title else tooltip)
        elif ctype == "quit":
            Gtk.main_quit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--icon", default="")
    parser.add_argument("--tooltip", default="Agy-Daddy Launcher")
    args = parser.parse_args()

    app = LinuxTrayApp(args.icon, args.tooltip)
    buf = ""

    def on_stdin(source, condition):
        nonlocal buf
        if condition & GLib.IO_HUP:
            Gtk.main_quit()
            return False
        chunk = os.read(source.fileno(), 65536)
        if not chunk:
            Gtk.main_quit()
            return False
        buf += chunk.decode("utf-8", errors="replace")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                app.handle_command(cmd)
            except Exception:
                pass
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    emit_event({"type": "ready", "platform": "linux"})
    Gtk.main()


if __name__ == "__main__":
    main()
