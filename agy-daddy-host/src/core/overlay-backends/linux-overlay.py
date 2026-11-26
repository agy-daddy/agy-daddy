#!/usr/bin/env python3
import argparse
import json
import math
import os
import re
import sys
import time

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    import cairo
except Exception as exc:
    sys.stderr.write(f"GTK3 overlay unavailable: {exc}\n")
    sys.exit(2)


def emit_event(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_hex_rgba(hex_str, default=(0.0, 0.0, 0.0, 0.0)):
    if not isinstance(hex_str, str):
        return default
    s = hex_str.strip()
    if not s.startswith("#"):
        return default
    h = s[1:]
    try:
        if len(h) == 6:
            return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0, 1.0)
        if len(h) == 8:
            return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0, int(h[6:8], 16) / 255.0)
    except ValueError:
        pass
    return default


def draw_svg_path(cr, d_str):
    tokens = re.findall(r"[MLHVCSQTAZmlhvcsqtaz]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", d_str or "")
    idx = 0
    cx = cy = sx = sy = 0.0
    last_cmd = ""

    def has_num():
        return idx < len(tokens) and not re.match(r"^[MLHVCSQTAZmlhvcsqtaz]$", tokens[idx])

    def next_num():
        nonlocal idx
        v = float(tokens[idx])
        idx += 1
        return v

    while idx < len(tokens):
        tok = tokens[idx]
        if re.match(r"^[MLHVCSQTAZmlhvcsqtaz]$", tok):
            last_cmd = tok
            idx += 1
        elif not last_cmd:
            idx += 1
            continue

        rel = last_cmd.islower()
        cmd = last_cmd.upper()
        if cmd == "M":
            first = True
            while has_num():
                x = next_num() + (cx if rel else 0.0)
                y = next_num() + (cy if rel else 0.0)
                if first:
                    cr.move_to(x, y)
                    sx, sy = x, y
                    first = False
                else:
                    cr.line_to(x, y)
                cx, cy = x, y
            last_cmd = "l" if rel else "L"
        elif cmd == "L":
            while has_num():
                x = next_num() + (cx if rel else 0.0)
                y = next_num() + (cy if rel else 0.0)
                cr.line_to(x, y)
                cx, cy = x, y
        elif cmd == "H":
            while has_num():
                x = next_num() + (cx if rel else 0.0)
                cr.line_to(x, cy)
                cx = x
        elif cmd == "V":
            while has_num():
                y = next_num() + (cy if rel else 0.0)
                cr.line_to(cx, y)
                cy = y
        elif cmd == "C":
            while has_num():
                x1 = next_num() + (cx if rel else 0.0)
                y1 = next_num() + (cy if rel else 0.0)
                x2 = next_num() + (cx if rel else 0.0)
                y2 = next_num() + (cy if rel else 0.0)
                x = next_num() + (cx if rel else 0.0)
                y = next_num() + (cy if rel else 0.0)
                cr.curve_to(x1, y1, x2, y2, x, y)
                cx, cy = x, y
        elif cmd == "Q":
            while has_num():
                x1 = next_num() + (cx if rel else 0.0)
                y1 = next_num() + (cy if rel else 0.0)
                x = next_num() + (cx if rel else 0.0)
                y = next_num() + (cy if rel else 0.0)
                cr.curve_to(
                    cx + (2.0 / 3.0) * (x1 - cx),
                    cy + (2.0 / 3.0) * (y1 - cy),
                    x + (2.0 / 3.0) * (x1 - x),
                    y + (2.0 / 3.0) * (y1 - y),
                    x,
                    y,
                )
                cx, cy = x, y
        elif cmd == "Z":
            cr.close_path()
            cx, cy = sx, sy
            last_cmd = ""
        else:
            if has_num():
                next_num()
            else:
                last_cmd = ""


class OverlayWindowItem:
    def __init__(self, window_id, bounds, visible):
        self.window_id = window_id
        self.scene = None
        self.state = {}
        self.hit_rect = (30, 30, 140, 120)
        self.bubble_rect = None
        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        screen = self.win.get_screen()
        visual = screen.get_rgba_visual() if screen else None
        if visual is None:
            raise RuntimeError("RGBA visual unsupported")
        self.win.set_visual(visual)
        self.win.set_app_paintable(True)
        self.win.set_decorated(False)
        self.win.set_keep_above(True)
        self.win.set_skip_taskbar_hint(True)
        self.win.set_accept_focus(False)
        self.win.set_default_size(int(bounds.get("width", 220)), int(bounds.get("height", 200)))
        self.win.move(int(bounds.get("x", 100)), int(bounds.get("y", 100)))

        self.area = Gtk.DrawingArea()
        self.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.area.connect("draw", self.on_draw)
        self.area.connect("button-press-event", self.on_button_press)
        self.win.add(self.area)
        if visible:
            self.win.show_all()
            self.update_input_shape()

    def update_input_shape(self):
        rects = [cairo.RectangleInt(*[int(v) for v in self.hit_rect])]
        if self.bubble_rect:
            rects.append(cairo.RectangleInt(*[int(v) for v in self.bubble_rect]))
        region = cairo.Region(rects)
        self.win.input_shape_combine_region(region)

    def on_button_press(self, _w, event):
        if self.bubble_rect:
            bx, by, bw, bh = self.bubble_rect
            if bx <= event.x <= bx + bw and by <= event.y <= by + bh:
                bid = (self.state.get("bubble") or {}).get("id", "")
                emit_event({"type": "interaction", "windowId": self.window_id, "eventType": "bubble-click", "bubbleId": bid})
                return True
        if event.button == 1:
            emit_event({"type": "interaction", "windowId": self.window_id, "eventType": "pet-click"})
        return True

    def on_draw(self, widget, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        alloc = widget.get_allocation()
        if not self.scene:
            return False

        vb = self.scene.get("viewBox", {})
        vb_w = max(1.0, float(vb.get("width", 160)))
        vb_h = max(1.0, float(vb.get("height", 160)))
        bubble = self.state.get("bubble")
        bubble_h = 52.0 if bubble else 0.0
        avail_w = float(alloc.width)
        avail_h = max(48.0, float(alloc.height) - bubble_h)
        scale = min(avail_w / vb_w, avail_h / vb_h)
        ox = (avail_w - vb_w * scale) / 2.0
        oy = bubble_h + (avail_h - vb_h * scale) / 2.0

        hb = self.scene.get("hitBox", {})
        self.hit_rect = (
            ox + float(hb.get("x", 20)) * scale,
            oy + float(hb.get("y", 20)) * scale,
            max(16.0, float(hb.get("width", 120)) * scale),
            max(16.0, float(hb.get("height", 120)) * scale),
        )

        cr.save()
        cr.translate(ox, oy)
        cr.scale(scale, scale)
        now = time.monotonic()
        sf = float(self.state.get("speedFactor", 1.0) or 1.0)
        for layer in self.scene.get("layers", []):
            cr.save()
            motion = layer.get("motion") or {}
            ty = float(motion.get("bobAmpY", 0) or 0) * math.sin(2 * math.pi * float(motion.get("bobFreqHz", 0) or 0) * sf * now)
            cr.translate(0, ty)
            kind = layer.get("kind")
            if kind == "path" and layer.get("d"):
                cr.new_path()
                draw_svg_path(cr, layer["d"])
            elif kind == "circle":
                cr.arc(float(layer.get("cx", 0)), float(layer.get("cy", 0)), float(layer.get("r", 10)), 0, 2 * math.pi)
            if layer.get("fill") and layer.get("fill") != "none":
                cr.set_source_rgba(*parse_hex_rgba(layer["fill"]))
                cr.fill_preserve()
            if layer.get("stroke") and layer.get("stroke") != "none":
                cr.set_source_rgba(*parse_hex_rgba(layer["stroke"]))
                cr.set_line_width(float(layer.get("strokeWidth", 1.5)))
                cr.stroke()
            cr.new_path()
            cr.restore()
        cr.restore()

        if bubble:
            bx, by, bw, bh = 8, 4, max(80, int(avail_w - 16)), 44
            self.bubble_rect = (bx, by, bw, bh)
            cr.set_source_rgba(0.08, 0.09, 0.13, 0.92)
            cr.rectangle(bx, by, bw, bh)
            cr.fill()
            cr.set_source_rgba(1, 1, 1, 1)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(11)
            cr.move_to(bx + 10, by + 18)
            cr.show_text(str(bubble.get("title", ""))[:48])
        else:
            self.bubble_rect = None
        self.update_input_shape()
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    screen = Gdk.Screen.get_default()
    if screen is None or screen.get_rgba_visual() is None:
        sys.exit(2)

    items = {}
    buf = ""

    def handle_cmd(cmd):
        ctype = cmd.get("type")
        if ctype == "quit":
            Gtk.main_quit()
            return
        wid = cmd.get("windowId")
        if not wid:
            return
        if ctype == "remove-window":
            it = items.pop(wid, None)
            if it:
                it.win.destroy()
        elif ctype == "upsert-window":
            bounds = cmd.get("bounds") or {}
            visible = cmd.get("visible", True) is not False
            if wid not in items:
                items[wid] = OverlayWindowItem(wid, bounds, visible)
            else:
                it = items[wid]
                it.win.resize(int(bounds.get("width", 220)), int(bounds.get("height", 200)))
                it.win.move(int(bounds.get("x", 100)), int(bounds.get("y", 100)))
                if visible:
                    it.win.show_all()
                else:
                    it.win.hide()
        elif ctype == "set-scene" and wid in items:
            items[wid].scene = cmd.get("scene")
            items[wid].area.queue_draw()
        elif ctype == "update-state" and wid in items:
            items[wid].state = cmd.get("state") or {}
            items[wid].area.queue_draw()

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
                handle_cmd(json.loads(line))
            except Exception:
                pass
        return True

    def on_tick():
        if args.parent_pid > 0:
            try:
                os.kill(args.parent_pid, 0)
            except ProcessLookupError:
                Gtk.main_quit()
                return False
            except Exception:
                pass
        for it in items.values():
            it.area.queue_draw()
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    GLib.timeout_add(33, on_tick)

    mon = Gdk.Display.get_default().get_primary_monitor()
    wa = mon.get_workarea() if mon else None
    emit_event({
        "type": "ready",
        "platform": "linux",
        "pid": os.getpid(),
        "workArea": {
            "x": wa.x if wa else 0,
            "y": wa.y if wa else 0,
            "width": wa.width if wa else 1280,
            "height": wa.height if wa else 800,
        },
    })
    Gtk.main()


if __name__ == "__main__":
    main()
