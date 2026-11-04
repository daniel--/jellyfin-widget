#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Daniel Lister
"""Jellyfin mini remote: a tiny always-on-top, transparent remote control widget.

Controls whatever Jellyfin client session is currently playing (or one you pick
from the right-click menu) via the Jellyfin server's remote-control API.
"""

import json
import os
import signal
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402

APP_NAME = "Jellyfin Widget"
VERSION = "0.1.0"
CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "jellyfin-widget"
)
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

TICKS_PER_SEC = 10_000_000
POLL_MS = 1000
SEEK_STEP_SEC = 10
DEFAULT_OPACITY = 0.75

CSS = """
window.jf-widget { background-color: transparent; }
.jf-panel {
    background-color: rgba(16, 16, 22, %(alpha).2f);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.10);
    padding: 6px 8px 6px 2px;
}
.jf-panel label { color: #f0f0f0; text-shadow: none; }
.jf-title { font-weight: bold; }
.jf-dim { color: rgba(255, 255, 255, 0.55); font-size: 0.85em; }
.jf-panel button {
    background: none; background-image: none; border: none; box-shadow: none;
    text-shadow: none; -gtk-icon-shadow: none; outline: none;
    color: #f0f0f0; padding: 3px; min-width: 0; min-height: 0; border-radius: 6px;
}
.jf-panel button:hover { background-color: rgba(255, 255, 255, 0.14); }
.jf-panel button:active { background-color: rgba(255, 255, 255, 0.24); }
.jf-panel button.jf-play { background-color: rgba(0, 164, 220, 0.90); border-radius: 999px; padding: 5px; }
.jf-panel button.jf-play:hover { background-color: rgba(30, 184, 240, 1.0); }
.jf-panel button.jf-close { padding: 0; color: rgba(255, 255, 255, 0.45); }
.jf-panel button.jf-close:hover { color: #fff; }
.jf-panel progressbar trough {
    min-height: 4px; border: none; border-radius: 2px; background-color: rgba(255, 255, 255, 0.18);
}
.jf-panel progressbar progress {
    min-height: 4px; border: none; border-radius: 2px; background-color: #00a4dc;
}
"""


# --------------------------------------------------------------------------- config

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    cfg.setdefault("device_id", uuid.uuid4().hex)
    cfg.setdefault("opacity", DEFAULT_OPACITY)
    return cfg


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    # Holds an access token, so keep it private.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


# --------------------------------------------------------------------------- API

REDIRECT_CODES = (301, 302, 303, 307, 308)
MAX_REDIRECTS = 5


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None  # surface redirects as HTTPError; JellyfinClient follows them


_OPENER = urllib.request.build_opener(_NoRedirect)


def _check_redirect(old_url, new_url):
    """Refuse redirects that would leak the access token somewhere unexpected."""
    old, new = urllib.parse.urlsplit(old_url), urllib.parse.urlsplit(new_url)
    if new.hostname != old.hostname:
        raise urllib.error.URLError(
            f"Server redirected to another host ({new.hostname}); "
            "enter that address in Settings instead")
    if old.scheme == "https" and new.scheme != "https":
        raise urllib.error.URLError("Refusing to follow a redirect from https to http")


class JellyfinClient:
    def __init__(self, server, device_id, token="", user_id=""):
        self.server = server.rstrip("/")
        self.device_id = device_id
        self.token = token
        self.user_id = user_id

    def _auth_header(self):
        header = (
            f'MediaBrowser Client="{APP_NAME}", Device="{socket.gethostname()}", '
            f'DeviceId="{self.device_id}", Version="{VERSION}"'
        )
        if self.token:
            header += f', Token="{self.token}"'
        return header

    def request(self, method, path, params=None, body=None):
        target = path + ("?" + urllib.parse.urlencode(params) if params else "")
        url = self.server + target
        data = json.dumps(body).encode() if body is not None else None
        # Redirects are followed here rather than by urllib, which refuses to
        # follow 307/308 for POST (i.e. every remote-control command).
        for _ in range(MAX_REDIRECTS + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", self._auth_header())
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with _OPENER.open(req, timeout=5) as resp:
                    raw = resp.read()
                return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                location = e.headers.get("Location")
                if e.code not in REDIRECT_CODES or not location:
                    raise
                e.close()
                new_url = urllib.parse.urljoin(url, location)
                _check_redirect(url, new_url)
                # If the server simply lives somewhere else (http -> https, a
                # different base path), remember that so later calls go direct.
                if url == self.server + target and new_url.endswith(target):
                    self.server = new_url[: len(new_url) - len(target)].rstrip("/")
                if e.code == 303:
                    method, data = "GET", None
                url = new_url
        raise urllib.error.URLError("Too many redirects")

    def authenticate(self, username, password):
        res = self.request(
            "POST", "/Users/AuthenticateByName", body={"Username": username, "Pw": password}
        )
        self.token = res["AccessToken"]
        self.user_id = res["User"]["Id"]

    def sessions(self):
        params = {"ControllableByUserId": self.user_id} if self.user_id else None
        return self.request("GET", "/Sessions", params) or []

    def playstate(self, session_id, command, **params):
        self.request("POST", f"/Sessions/{session_id}/Playing/{command}", params or None)

    def command(self, session_id, name, **args):
        body = {"Name": name, "Arguments": {k: str(v) for k, v in args.items()}}
        self.request("POST", f"/Sessions/{session_id}/Command", body=body)


# --------------------------------------------------------------------------- helpers

def fmt_time(ticks):
    secs = max(0, int(ticks // TICKS_PER_SEC))
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def describe_item(item):
    """Return (title, subtitle) for a NowPlayingItem."""
    name = item.get("Name") or "Unknown"
    kind = item.get("Type")
    if kind == "Episode":
        s, e = item.get("ParentIndexNumber"), item.get("IndexNumber")
        code = f"S{s:02d}E{e:02d} · " if s is not None and e is not None else ""
        return f"{code}{name}", item.get("SeriesName") or ""
    if kind == "Audio":
        artists = ", ".join(item.get("Artists") or []) or item.get("AlbumArtist") or ""
        album = item.get("Album") or ""
        return name, " · ".join(x for x in (artists, album) if x)
    year = item.get("ProductionYear")
    return name, str(year) if year else ""


def session_label(s):
    label = f"{s.get('Client', '?')} · {s.get('DeviceName', '?')}"
    if s.get("UserName"):
        label += f" ({s['UserName']})"
    return label


def icon_button(icon, tooltip, callback, size=Gtk.IconSize.BUTTON, css_class=None):
    btn = Gtk.Button()
    btn.set_relief(Gtk.ReliefStyle.NONE)
    btn.set_focus_on_click(False)
    btn.set_can_focus(False)
    btn.set_tooltip_text(tooltip)
    btn.add(Gtk.Image.new_from_icon_name(icon, size))
    btn.connect("clicked", lambda *_: callback())
    if css_class:
        btn.get_style_context().add_class(css_class)
    return btn


# --------------------------------------------------------------------------- settings dialog

class SettingsDialog(Gtk.Dialog):
    def __init__(self, parent, cfg):
        super().__init__(title=f"{APP_NAME} settings", transient_for=parent, modal=True)
        self.set_keep_above(True)
        self.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Connect", Gtk.ResponseType.OK)
        self.set_default_response(Gtk.ResponseType.OK)

        grid = Gtk.Grid(column_spacing=10, row_spacing=8, margin=14)
        self.get_content_area().add(grid)

        def row(i, text, widget):
            lbl = Gtk.Label(label=text, xalign=1)
            grid.attach(lbl, 0, i, 1, 1)
            widget.set_hexpand(True)
            widget.set_activates_default(True)
            grid.attach(widget, 1, i, 1, 1)
            return widget

        self.server = row(0, "Server URL", Gtk.Entry(text=cfg.get("server", "")))
        self.server.set_placeholder_text("http://192.168.1.10:8096")
        self.username = row(1, "Username", Gtk.Entry(text=cfg.get("username", "")))
        self.password = row(2, "Password", Gtk.Entry(visibility=False))
        if cfg.get("token") and not cfg.get("api_key"):
            self.password.set_placeholder_text("(saved login, leave blank to keep)")
        or_lbl = Gtk.Label(xalign=0)
        or_lbl.set_markup("<small>— or use an API key (Dashboard → API Keys) —</small>")
        grid.attach(or_lbl, 0, 3, 2, 1)
        self.api_key = row(4, "API key", Gtk.Entry(text=cfg.get("api_key", "")))
        self.show_all()


# --------------------------------------------------------------------------- main window

class Widget(Gtk.Window):
    def __init__(self):
        super().__init__(title=APP_NAME)
        self.cfg = load_config()
        self.client = None
        self.sessions = []
        self.session = None          # currently controlled session dict
        self.pinned_session_id = self.cfg.get("pinned_session")  # None = auto
        self.polling = False
        self.pos_ticks = 0
        self.pos_stamp = time.monotonic()
        self.run_ticks = 0
        self.paused = True
        self.css = Gtk.CssProvider()
        self._save_pos_source = None

        self._setup_window()
        self._build_ui()
        self._apply_css()
        self._connect_client()

        GLib.timeout_add(POLL_MS, self._poll)
        GLib.timeout_add(250, self._tick_progress)
        GLib.idle_add(lambda: self._poll() and False)

    # ----- window chrome

    def _setup_window(self):
        self.get_style_context().add_class("jf-widget")
        self.set_decorated(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_resizable(False)
        self.stick()

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None and screen.is_composited():
            self.set_visual(visual)
        self.set_app_paintable(True)
        self.connect("draw", self._on_draw)

        if "x" in self.cfg and "y" in self.cfg:
            self.move(self.cfg["x"], self.cfg["y"])
        self.connect("configure-event", self._on_configure)
        self.connect("destroy", Gtk.main_quit)
        self.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("scroll-event", self._on_scroll)
        self.connect("button-press-event", self._on_button_press)

    def _on_draw(self, _widget, cr):
        # Clear to fully transparent; the rounded panel is drawn by CSS on top.
        cr.save()
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.paint()
        cr.restore()
        return False

    def _apply_css(self):
        self.css.load_from_data((CSS % {"alpha": self.cfg["opacity"]}).encode())
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

    def _on_configure(self, _w, event):
        self.cfg["x"], self.cfg["y"] = self.get_position()
        if self._save_pos_source:
            GLib.source_remove(self._save_pos_source)
        self._save_pos_source = GLib.timeout_add(800, self._save_pos)
        return False

    def _save_pos(self):
        self._save_pos_source = None
        save_config(self.cfg)
        return False

    # ----- layout

    def _build_ui(self):
        panel = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        panel.get_style_context().add_class("jf-panel")
        self.add(panel)

        # Drag handle
        handle = Gtk.EventBox()
        handle.set_tooltip_text("Drag to move · right-click for menu")
        grip = Gtk.DrawingArea()
        grip.set_size_request(14, -1)
        grip.connect("draw", self._draw_grip)
        handle.add(grip)
        handle.connect("button-press-event", self._on_handle_press)
        handle.connect("realize", lambda w: w.get_window().set_cursor(
            Gdk.Cursor.new_from_name(w.get_display(), "grab")))
        panel.pack_start(handle, False, False, 0)

        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        panel.pack_start(body, True, True, 0)

        # Row 1: title + close
        top = Gtk.Box(spacing=4)
        self.title = Gtk.Label(label="Connecting…", xalign=0)
        self.title.set_ellipsize(Pango.EllipsizeMode.END)
        self.title.set_max_width_chars(34)
        self.title.get_style_context().add_class("jf-title")
        top.pack_start(self.title, True, True, 0)
        top.pack_end(icon_button("window-close-symbolic", "Quit", Gtk.main_quit,
                                 Gtk.IconSize.MENU, "jf-close"), False, False, 0)
        body.pack_start(top, False, False, 0)

        # Row 2: subtitle / device
        self.subtitle = Gtk.Label(label="", xalign=0)
        self.subtitle.set_ellipsize(Pango.EllipsizeMode.END)
        self.subtitle.set_max_width_chars(40)
        self.subtitle.get_style_context().add_class("jf-dim")
        body.pack_start(self.subtitle, False, False, 0)

        # Row 3: progress (click to seek) + time
        prog_row = Gtk.Box(spacing=8)
        self.progress = Gtk.ProgressBar()
        self.progress.set_valign(Gtk.Align.CENTER)
        prog_box = Gtk.EventBox()
        prog_box.set_tooltip_text("Click to seek")
        prog_box.add(self.progress)
        prog_box.connect("button-press-event", self._on_progress_click)
        prog_row.pack_start(prog_box, True, True, 0)
        self.time_lbl = Gtk.Label(label="0:00 / 0:00")
        self.time_lbl.get_style_context().add_class("jf-dim")
        prog_row.pack_end(self.time_lbl, False, False, 0)
        body.pack_start(prog_row, False, False, 2)

        # Row 4: transport controls + volume
        ctl = Gtk.Box(spacing=2)
        ctl.pack_start(icon_button("media-skip-backward-symbolic", "Previous",
                                   lambda: self._play("PreviousTrack")), False, False, 0)
        ctl.pack_start(icon_button("media-seek-backward-symbolic", f"Back {SEEK_STEP_SEC}s",
                                   lambda: self._seek_rel(-SEEK_STEP_SEC)), False, False, 0)
        self.play_btn = icon_button("media-playback-start-symbolic", "Play / Pause",
                                    lambda: self._play_pause(), Gtk.IconSize.LARGE_TOOLBAR,
                                    "jf-play")
        ctl.pack_start(self.play_btn, False, False, 2)
        ctl.pack_start(icon_button("media-seek-forward-symbolic", f"Forward {SEEK_STEP_SEC}s",
                                   lambda: self._seek_rel(SEEK_STEP_SEC)), False, False, 0)
        ctl.pack_start(icon_button("media-skip-forward-symbolic", "Next",
                                   lambda: self._play("NextTrack")), False, False, 0)
        ctl.pack_start(icon_button("media-playback-stop-symbolic", "Stop",
                                   lambda: self._play("Stop")), False, False, 0)

        ctl.pack_end(icon_button("list-add-symbolic", "Volume up",
                                 lambda: self._cmd("VolumeUp")), False, False, 0)
        ctl.pack_end(icon_button("list-remove-symbolic", "Volume down",
                                 lambda: self._cmd("VolumeDown")), False, False, 0)
        self.mute_btn = icon_button("audio-volume-high-symbolic", "Mute",
                                    lambda: self._cmd("ToggleMute"))
        ctl.pack_end(self.mute_btn, False, False, 0)
        body.pack_start(ctl, False, False, 0)

        self.set_size_request(340, -1)

    def _draw_grip(self, widget, cr):
        w, h = widget.get_allocated_width(), widget.get_allocated_height()
        cr.set_source_rgba(1, 1, 1, 0.35)
        rows = 4
        for i in range(rows):
            y = h / 2 + (i - (rows - 1) / 2) * 6
            for x in (w / 2 - 2.5, w / 2 + 2.5):
                cr.arc(x, y, 1.4, 0, 6.2832)
                cr.fill()
        return False

    # ----- mouse handling

    def _on_handle_press(self, _w, event):
        if event.button == 1:
            self.begin_move_drag(event.button, int(event.x_root), int(event.y_root), event.time)
            return True
        return False

    def _on_button_press(self, _w, event):
        if event.button == 3:
            self._build_menu().popup_at_pointer(event)
            return True
        return False

    def _on_scroll(self, _w, event):
        direction = event.direction
        if direction == Gdk.ScrollDirection.SMOOTH:
            _, _dx, dy = event.get_scroll_deltas()
            if dy == 0:
                return True
            direction = Gdk.ScrollDirection.UP if dy < 0 else Gdk.ScrollDirection.DOWN
        if direction == Gdk.ScrollDirection.UP:
            self._cmd("VolumeUp")
        elif direction == Gdk.ScrollDirection.DOWN:
            self._cmd("VolumeDown")
        return True

    def _on_progress_click(self, widget, event):
        if event.button != 1 or not self.run_ticks:
            return False
        frac = min(1.0, max(0.0, event.x / max(1, widget.get_allocated_width())))
        self._seek_abs(int(frac * self.run_ticks))
        return True

    # ----- context menu

    def _build_menu(self):
        menu = Gtk.Menu()

        header = Gtk.MenuItem(label="Control session")
        header.set_sensitive(False)
        menu.append(header)

        auto = Gtk.RadioMenuItem(label="Auto (whatever is playing)")
        auto.set_active(self.pinned_session_id is None)
        auto.connect("activate", lambda i: i.get_active() and self._pin_session(None))
        menu.append(auto)
        for s in self.sessions:
            label = session_label(s)
            if s.get("NowPlayingItem"):
                label = "▶ " + label
            item = Gtk.RadioMenuItem.new_with_label_from_widget(auto, label)
            item.set_active(s["Id"] == self.pinned_session_id)
            item.connect("activate",
                         lambda i, sid=s["Id"]: i.get_active() and self._pin_session(sid))
            menu.append(item)

        menu.append(Gtk.SeparatorMenuItem())
        opacity = Gtk.MenuItem(label="Background opacity")
        sub = Gtk.Menu()
        first = None
        for pct in (25, 50, 75, 90, 100):
            item = Gtk.RadioMenuItem.new_with_label_from_widget(first, f"{pct}%")
            first = first or item
            item.set_active(abs(self.cfg["opacity"] * 100 - pct) < 1)
            item.connect("activate",
                         lambda i, p=pct: i.get_active() and self._set_opacity(p / 100))
            sub.append(item)
        opacity.set_submenu(sub)
        menu.append(opacity)

        settings = Gtk.MenuItem(label="Settings…")
        settings.connect("activate", lambda *_: self._open_settings())
        menu.append(settings)
        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda *_: Gtk.main_quit())
        menu.append(quit_item)

        menu.show_all()
        menu.attach_to_widget(self, None)
        return menu

    def _pin_session(self, session_id):
        self.pinned_session_id = session_id
        self.cfg["pinned_session"] = session_id
        save_config(self.cfg)
        self._poll()

    def _set_opacity(self, value):
        self.cfg["opacity"] = value
        save_config(self.cfg)
        self._apply_css()

    # ----- settings / connection

    def _connect_client(self):
        server = self.cfg.get("server")
        token = self.cfg.get("api_key") or self.cfg.get("token")
        if not server or not token:
            self.client = None
            self._show_message("Not configured", "Right-click → Settings…")
            GLib.idle_add(self._open_settings)
            return
        user_id = "" if self.cfg.get("api_key") else self.cfg.get("user_id", "")
        self.client = JellyfinClient(server, self.cfg["device_id"], token, user_id)

    def _open_settings(self):
        dlg = SettingsDialog(self, self.cfg)
        while dlg.run() == Gtk.ResponseType.OK:
            server = dlg.server.get_text().strip()
            username = dlg.username.get_text().strip()
            password = dlg.password.get_text()
            api_key = dlg.api_key.get_text().strip()
            if server and "://" not in server:
                server = "http://" + server
            try:
                if not server:
                    raise ValueError("Server URL is required.")
                client = JellyfinClient(server, self.cfg["device_id"])
                if api_key:
                    client.token = api_key
                    client.request("GET", "/System/Info")  # validates key
                elif username and (password or not self.cfg.get("token")):
                    client.authenticate(username, password)
                elif username and self.cfg.get("token"):
                    # Keep the saved login; just make sure it still works.
                    client.token, client.user_id = self.cfg["token"], self.cfg.get("user_id", "")
                    client.sessions()
                else:
                    raise ValueError("Enter a username/password or an API key.")
            except Exception as e:  # noqa: BLE001 - show anything to the user
                err = Gtk.MessageDialog(transient_for=dlg, modal=True,
                                        message_type=Gtk.MessageType.ERROR,
                                        buttons=Gtk.ButtonsType.OK,
                                        text="Could not connect")
                err.format_secondary_text(_error_text(e))
                err.run()
                err.destroy()
                continue

            self.cfg.update(server=client.server, username=username)
            if api_key:
                self.cfg["api_key"] = api_key
                self.cfg.pop("token", None)
                self.cfg.pop("user_id", None)
            else:
                self.cfg.pop("api_key", None)
                self.cfg.update(token=client.token, user_id=client.user_id)
            save_config(self.cfg)
            self.client = client
            self._show_message("Connected", "Looking for sessions…")
            self._poll()
            break
        dlg.destroy()
        return False

    # ----- polling

    def _poll(self):
        if self.polling or self.client is None:
            return True
        self.polling = True
        client = self.client

        def work():
            try:
                result, err = client.sessions(), None
            except Exception as e:  # noqa: BLE001
                result, err = None, e
            GLib.idle_add(self._on_sessions, result, err)

        threading.Thread(target=work, daemon=True).start()
        return True

    def _on_sessions(self, sessions, err):
        self.polling = False
        if err is not None:
            self.session = None
            self._show_message("Server unreachable", _error_text(err))
            return False

        if self.client.server != self.cfg.get("server"):  # followed a permanent move
            self.cfg["server"] = self.client.server
            save_config(self.cfg)

        own = self.cfg["device_id"]
        self.sessions = [s for s in sessions
                         if s.get("SupportsRemoteControl") and s.get("DeviceId") != own]
        self.session = self._pick_session()
        self._update_ui()
        return False

    def _pick_session(self):
        if self.pinned_session_id:
            for s in self.sessions:
                if s["Id"] == self.pinned_session_id:
                    return s
        playing = [s for s in self.sessions if s.get("NowPlayingItem")]
        if self.session:  # stick with the current one while it is still playing
            for s in playing:
                if s["Id"] == self.session["Id"]:
                    return s
        pool = playing or []
        pool.sort(key=lambda s: s.get("LastActivityDate", ""), reverse=True)
        return pool[0] if pool else None

    # ----- UI updates

    def _show_message(self, title, subtitle=""):
        self.title.set_text(title)
        self.subtitle.set_text(subtitle)
        self.run_ticks = self.pos_ticks = 0
        self.paused = True
        self._set_play_icon(False)
        self._tick_progress()

    def _update_ui(self):
        s = self.session
        if not s:
            if self.pinned_session_id:
                self._show_message("Pinned session not found", "Right-click to pick another")
            else:
                n = len(self.sessions)
                self._show_message("Nothing playing",
                                   f"{n} controllable session{'s' if n != 1 else ''}")
            return

        item = s.get("NowPlayingItem")
        state = s.get("PlayState") or {}
        device = session_label(s)
        if item:
            title, sub = describe_item(item)
            self.title.set_text(title)
            self.subtitle.set_text(" · ".join(x for x in (sub, device) if x))
            self.title.set_tooltip_text(title)
        else:
            self.title.set_text("Idle")
            self.subtitle.set_text(device)

        self.run_ticks = (item or {}).get("RunTimeTicks") or 0
        self.pos_ticks = state.get("PositionTicks") or 0
        self.pos_stamp = time.monotonic()
        self.paused = bool(state.get("IsPaused")) or not item
        self._set_play_icon(not self.paused)

        vol, muted = state.get("VolumeLevel"), state.get("IsMuted")
        if muted:
            icon = "audio-volume-muted-symbolic"
        elif vol is None or vol > 66:
            icon = "audio-volume-high-symbolic"
        elif vol > 33:
            icon = "audio-volume-medium-symbolic"
        else:
            icon = "audio-volume-low-symbolic"
        self.mute_btn.get_child().set_from_icon_name(icon, Gtk.IconSize.BUTTON)
        vol_txt = f"Volume {vol}%" if vol is not None else "Volume"
        self.mute_btn.set_tooltip_text(f"{vol_txt}{' (muted)' if muted else ''} · click to mute, "
                                       "scroll widget to change")
        self._tick_progress()

    def _set_play_icon(self, playing):
        icon = "media-playback-pause-symbolic" if playing else "media-playback-start-symbolic"
        self.play_btn.get_child().set_from_icon_name(icon, Gtk.IconSize.LARGE_TOOLBAR)

    def _current_ticks(self):
        ticks = self.pos_ticks
        if not self.paused:
            ticks += int((time.monotonic() - self.pos_stamp) * TICKS_PER_SEC)
        return min(ticks, self.run_ticks) if self.run_ticks else ticks

    def _tick_progress(self):
        pos = self._current_ticks()
        self.progress.set_fraction(pos / self.run_ticks if self.run_ticks else 0)
        self.time_lbl.set_text(f"{fmt_time(pos)} / {fmt_time(self.run_ticks)}")
        return True

    # ----- commands

    def _send(self, fn, *args, **kwargs):
        if not self.client or not self.session:
            return
        sid = self.session["Id"]

        def work():
            try:
                fn(sid, *args, **kwargs)
            except Exception as e:  # noqa: BLE001
                GLib.idle_add(self.subtitle.set_text, f"Command failed: {_error_text(e)}")
            GLib.timeout_add(300, lambda: self._poll() and False)

        threading.Thread(target=work, daemon=True).start()

    def _play(self, command, **params):
        if self.client:
            self._send(self.client.playstate, command, **params)

    def _cmd(self, name, **args):
        if self.client:
            self._send(self.client.command, name, **args)

    def _play_pause(self):
        if not self.session:
            return
        # Optimistic UI update; next poll corrects it.
        self.pos_ticks, self.pos_stamp = self._current_ticks(), time.monotonic()
        self.paused = not self.paused
        self._set_play_icon(not self.paused)
        self._play("PlayPause")

    def _seek_abs(self, ticks):
        if not self.session:
            return
        ticks = max(0, min(ticks, self.run_ticks or ticks))
        self.pos_ticks, self.pos_stamp = ticks, time.monotonic()
        self._tick_progress()
        self._play("Seek", seekPositionTicks=ticks)

    def _seek_rel(self, seconds):
        self._seek_abs(self._current_ticks() + seconds * TICKS_PER_SEC)


def _error_text(e):
    if isinstance(e, urllib.error.HTTPError):
        return {401: "Unauthorized: check credentials / API key"}.get(e.code, f"HTTP {e.code}")
    if isinstance(e, urllib.error.URLError):
        return str(e.reason)
    return str(e) or e.__class__.__name__


def main():
    win = Widget()
    win.show_all()
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
