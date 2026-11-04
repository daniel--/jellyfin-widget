// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Lister
//
// Jellyfin Remote: a Cinnamon panel applet that remote-controls a Jellyfin client
// session (whatever is playing, or one picked from the popup) via the server API.

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Slider = imports.ui.slider;
const Tooltips = imports.ui.tooltips;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Soup = imports.gi.Soup;
const St = imports.gi.St;

const APP_NAME = "Jellyfin Panel Remote";
const VERSION = "0.1.0";
const TICKS_PER_SEC = 10000000;
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;
const DIM_OPACITY = 170;

// --------------------------------------------------------------------------- helpers

function fmtTime(ticks) {
    let secs = Math.max(0, Math.floor(ticks / TICKS_PER_SEC));
    let h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    let pad = n => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Returns [title, subtitle] for a NowPlayingItem. */
function describeItem(item) {
    let name = item.Name || "Unknown";
    if (item.Type === "Episode") {
        let s = item.ParentIndexNumber, e = item.IndexNumber;
        let code = (s != null && e != null)
            ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")} · ` : "";
        return [code + name, item.SeriesName || ""];
    }
    if (item.Type === "Audio") {
        let artists = (item.Artists || []).join(", ") || item.AlbumArtist || "";
        return [name, [artists, item.Album || ""].filter(Boolean).join(" · ")];
    }
    return [name, item.ProductionYear ? String(item.ProductionYear) : ""];
}

function sessionLabel(s) {
    let label = `${s.Client || "?"} · ${s.DeviceName || "?"}`;
    return s.UserName ? `${label} (${s.UserName})` : label;
}

function truncate(text, max) {
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
}

function normalizeServer(url) {
    url = (url || "").trim().replace(/\/+$/, "");
    if (url && !url.includes("://"))
        url = "http://" + url;
    return url;
}

class HttpError extends Error {
    constructor(code) {
        super(`HTTP ${code}`);
        this.code = code;
    }
}

function errorText(e) {
    if (e instanceof HttpError && e.code === 401)
        return "Unauthorized: log in again or check the API key";
    return (e && e.message) || String(e);
}

/** Refuse redirects that would leak the access token somewhere unexpected. */
function checkRedirect(oldUrl, newUrl) {
    let o = GLib.Uri.parse(oldUrl, GLib.UriFlags.NONE);
    let n = GLib.Uri.parse(newUrl, GLib.UriFlags.NONE);
    if (n.get_host() !== o.get_host())
        throw new Error(`Server redirected to another host (${n.get_host()}); ` +
                        "enter that address in the applet settings instead");
    if (o.get_scheme() === "https" && n.get_scheme() !== "https")
        throw new Error("Refusing to follow a redirect from https to http");
}

// --------------------------------------------------------------------------- API

class JellyfinClient {
    constructor(server, deviceId, token = "", userId = "") {
        this.server = normalizeServer(server);
        this.deviceId = deviceId;
        this.token = token;
        this.userId = userId;
        this._http = new Soup.Session({ timeout: 5, user_agent: `${APP_NAME}/${VERSION}` });
    }

    destroy() {
        this._http.abort();
    }

    _authHeader() {
        let header = `MediaBrowser Client="${APP_NAME}", Device="${GLib.get_host_name()}", ` +
                     `DeviceId="${this.deviceId}", Version="${VERSION}"`;
        return this.token ? `${header}, Token="${this.token}"` : header;
    }

    _send(msg) {
        return new Promise((resolve, reject) => {
            this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    resolve(session.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async request(method, path, params = null, body = null) {
        let target = path;
        if (params)
            target += "?" + Object.entries(params)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        let url = this.server + target;
        let data = body !== null ? new TextEncoder().encode(JSON.stringify(body)) : null;

        // Redirects are followed by hand so that POSTs keep their method and
        // body, and so a moved server (http -> https, new base path) is remembered.
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            let msg;
            try {
                msg = Soup.Message.new(method, url);
            } catch (e) {
                msg = null;
            }
            if (!msg)
                throw new Error(`Invalid server URL: ${this.server}`);
            msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
            msg.get_request_headers().append("Authorization", this._authHeader());
            if (data)
                msg.set_request_body_from_bytes("application/json", new GLib.Bytes(data));

            let bytes = await this._send(msg);
            let status = msg.get_status();

            if (REDIRECT_CODES.includes(status)) {
                let location = msg.get_response_headers().get_one("Location");
                if (!location)
                    throw new HttpError(status);
                let newUrl = GLib.Uri.resolve_relative(url, location, GLib.UriFlags.NONE);
                checkRedirect(url, newUrl);
                if (url === this.server + target && newUrl.endsWith(target))
                    this.server = newUrl.slice(0, newUrl.length - target.length).replace(/\/+$/, "");
                if (status === 303) {
                    method = "GET";
                    data = null;
                }
                url = newUrl;
                continue;
            }
            if (status < 200 || status >= 300)
                throw new HttpError(status);

            let raw = bytes && bytes.get_size() ? new TextDecoder().decode(bytes.get_data()) : "";
            return raw ? JSON.parse(raw) : null;
        }
        throw new Error("Too many redirects");
    }

    async authenticate(username, password) {
        let res = await this.request("POST", "/Users/AuthenticateByName", null,
                                     { Username: username, Pw: password });
        this.token = res.AccessToken;
        this.userId = res.User.Id;
    }

    async sessions() {
        let params = this.userId ? { ControllableByUserId: this.userId } : null;
        return (await this.request("GET", "/Sessions", params)) || [];
    }

    playstate(sessionId, command, params = null) {
        return this.request("POST", `/Sessions/${sessionId}/Playing/${command}`, params);
    }

    command(sessionId, name, args = {}) {
        let strArgs = {};
        for (let [k, v] of Object.entries(args))
            strArgs[k] = String(v);
        return this.request("POST", `/Sessions/${sessionId}/Command`, null,
                            { Name: name, Arguments: strArgs });
    }
}

// --------------------------------------------------------------------------- applet

class JellyfinRemoteApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.client = null;
        this.sessions = [];
        this.session = null;
        this.polling = false;
        this.posTicks = 0;
        this.posStamp = Date.now();
        this.runTicks = 0;
        this.paused = true;
        this.volume = null;
        this.muted = false;
        this._volumeTouched = 0;     // ms timestamp of the last user volume change
        this._volumeSendId = 0;
        this._sessionMenuKey = "";
        this._pollId = 0;
        this._tickId = 0;
        this._destroyed = false;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        let onConnection = () => this._onConnectionSettingsChanged();
        let onPanel = () => this._updateUi();
        this.settings.bind("server-url", "serverUrl", onConnection);
        this.settings.bind("api-key", "apiKey", onConnection);
        this.settings.bind("username", "username");
        this.settings.bind("password", "password");
        this.settings.bind("token", "token");
        this.settings.bind("user-id", "userId");
        this.settings.bind("device-id", "deviceId");
        this.settings.bind("pinned-session", "pinnedSession");
        this.settings.bind("show-title", "showTitle", onPanel);
        this.settings.bind("title-max-chars", "titleMaxChars", onPanel);
        this.settings.bind("show-time", "showTime", onPanel);
        this.settings.bind("show-prev-next", "showPrevNext", onPanel);
        this.settings.bind("hide-when-idle", "hideWhenIdle", onPanel);
        this.settings.bind("poll-interval", "pollInterval", () => this._startTimers());
        this.settings.bind("seek-step", "seekStep", () => this._updateTooltips());

        if (!this.deviceId)
            this.deviceId = GLib.uuid_string_random().replace(/-/g, "");
        this._protectSettingsDir(metadata.uuid);

        this._buildPanel();
        this._buildMenu(orientation);
        this._buildContextMenu();
        this.actor.connect("scroll-event", (actor, event) => this._onScroll(event));

        this._connectClient();
        this._startTimers();
        this._updateUi();
    }

    // The settings file holds an access token; keep it out of other users' reach.
    _protectSettingsDir(uuid) {
        let dir = GLib.build_filenamev([GLib.get_user_config_dir(), "cinnamon", "spices", uuid]);
        try {
            Gio.File.new_for_path(dir).set_attribute_uint32(
                "unix::mode", 0o700, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            global.logWarning(`[${uuid}] could not restrict settings dir: ${e.message}`);
        }
    }

    // ----- panel

    _buildPanel() {
        this._icon = new St.Icon({ icon_name: "xsi-tv-symbolic", icon_type: St.IconType.SYMBOLIC,
                                   style_class: "applet-icon", y_align: Clutter.ActorAlign.CENTER });
        this.actor.add_child(this._icon);

        this._panelButtons = [];
        this._prevBtn = this._panelButton("xsi-media-skip-backward-symbolic", "Previous",
                                          () => this._play("PreviousTrack"));
        this._playBtn = this._panelButton("xsi-media-playback-start-symbolic", "Play / pause",
                                          () => this._playPause());
        this._nextBtn = this._panelButton("xsi-media-skip-forward-symbolic", "Next",
                                          () => this._play("NextTrack"));

        this._label = new St.Label({ style_class: "applet-label jellyfin-remote-label",
                                     y_align: Clutter.ActorAlign.CENTER });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(this._label);
        this._resizeIcons();
    }

    _panelButton(icon, tooltip, callback) {
        let btn = new St.Button({ style_class: "jellyfin-remote-panel-button", can_focus: true });
        btn.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC,
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.CENTER }));
        btn.connect("clicked", callback);
        new Tooltips.Tooltip(btn, tooltip);
        this.actor.add_child(btn);
        this._panelButtons.push(btn);
        return btn;
    }

    _resizeIcons() {
        // Undefined until the applet is attached to a panel.
        let size = this.getPanelIconSize(St.IconType.SYMBOLIC);
        if (!size)
            return;
        this._icon.set_icon_size(size);
        for (let btn of this._panelButtons)
            btn.get_child().set_icon_size(size);
    }

    _isVertical() {
        return this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
    }

    on_panel_height_changed() {
        this._resizeIcons();
    }

    // Panel icon-size setting changed, or the applet moved to another panel/zone.
    on_panel_icon_size_changed() {
        this._resizeIcons();
    }

    on_applet_added_to_panel() {
        this._resizeIcons();
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this._updateUi();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        this._playPause();
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        this._stopTimers();
        if (this._volumeSendId)
            GLib.source_remove(this._volumeSendId);
        if (this.client)
            this.client.destroy();
        this.settings.finalize();
    }

    _onScroll(event) {
        let dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            let [, dy] = event.get_scroll_delta();
            if (dy === 0)
                return Clutter.EVENT_STOP;
            dir = dy < 0 ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN;
        }
        if (dir === Clutter.ScrollDirection.UP)
            this._cmd("VolumeUp");
        else if (dir === Clutter.ScrollDirection.DOWN)
            this._cmd("VolumeDown");
        return Clutter.EVENT_STOP;
    }

    // ----- popup menu

    _buildMenu(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open)
                this._poll();
        });

        let box = new St.BoxLayout({ vertical: true, style_class: "jellyfin-remote-popup",
                                     x_expand: true });
        this._addStaticItem(box);

        // Now playing
        this._mTitle = new St.Label({ style_class: "jellyfin-remote-title" });
        this._mSubtitle = new St.Label({ opacity: DIM_OPACITY });
        this._mDevice = new St.Label({ opacity: DIM_OPACITY });
        for (let l of [this._mTitle, this._mSubtitle, this._mDevice]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(l);
        }

        // Seek bar
        let seekRow = new St.BoxLayout({ style_class: "jellyfin-remote-row", x_expand: true });
        this._seeker = new Slider.Slider(0, true);
        this._seeker.actor.x_expand = true;
        this._seeker.actor.y_align = Clutter.ActorAlign.CENTER;
        this._seeker.connect("drag-end", () => this._seekToSlider());
        this._seeker.connect("value-changed", () => {
            if (!this._seeker._dragging)   // keyboard / scroll changes
                this._seekToSlider();
        });
        seekRow.add_child(this._seeker.actor);
        this._mTime = new St.Label({ text: "0:00 / 0:00", opacity: DIM_OPACITY,
                                     y_align: Clutter.ActorAlign.CENTER });
        seekRow.add_child(this._mTime);
        box.add_child(seekRow);

        // Transport controls
        let controls = new St.BoxLayout({ style_class: "jellyfin-remote-controls",
                                          x_align: Clutter.ActorAlign.CENTER, x_expand: true });
        let add = (icon, tip, cb, extra = "") => {
            let btn = new St.Button({ style_class: `jellyfin-remote-button ${extra}`, can_focus: true });
            btn.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC,
                                        icon_size: extra ? 24 : 16,
                                        x_align: Clutter.ActorAlign.CENTER,
                                        y_align: Clutter.ActorAlign.CENTER }));
            btn.connect("clicked", cb);
            btn._tooltip = new Tooltips.Tooltip(btn, tip);
            controls.add_child(btn);
            return btn;
        };
        add("xsi-media-skip-backward-symbolic", "Previous", () => this._play("PreviousTrack"));
        this._rewBtn = add("xsi-media-seek-backward-symbolic", "", () => this._seekRel(-this.seekStep));
        this._mPlayBtn = add("xsi-media-playback-start-symbolic", "Play / pause",
                             () => this._playPause(), "jellyfin-remote-play");
        this._ffBtn = add("xsi-media-seek-forward-symbolic", "", () => this._seekRel(this.seekStep));
        add("xsi-media-skip-forward-symbolic", "Next", () => this._play("NextTrack"));
        add("xsi-media-playback-stop-symbolic", "Stop", () => this._play("Stop"));
        box.add_child(controls);

        // Volume
        let volRow = new St.BoxLayout({ style_class: "jellyfin-remote-row", x_expand: true });
        this._muteBtn = new St.Button({ style_class: "jellyfin-remote-button", can_focus: true });
        this._muteIcon = new St.Icon({ icon_name: "xsi-audio-volume-high-symbolic",
                                       icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        this._muteBtn.set_child(this._muteIcon);
        this._muteBtn.connect("clicked", () => this._cmd("ToggleMute"));
        new Tooltips.Tooltip(this._muteBtn, "Mute");
        volRow.add_child(this._muteBtn);
        this._volSlider = new Slider.Slider(0, true);
        this._volSlider.actor.x_expand = true;
        this._volSlider.actor.y_align = Clutter.ActorAlign.CENTER;
        this._volSlider.connect("value-changed", (s, value) => this._onVolumeSlider(value));
        volRow.add_child(this._volSlider.actor);
        this._mVol = new St.Label({ text: "–", opacity: DIM_OPACITY, y_align: Clutter.ActorAlign.CENTER });
        volRow.add_child(this._mVol);
        box.add_child(volRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sessionMenu = new PopupMenu.PopupSubMenuMenuItem("Session: Auto");
        this.menu.addMenuItem(this._sessionMenu);
        this._rebuildSessionMenu();
        this._updateTooltips();
    }

    _addStaticItem(child) {
        let item = new PopupMenu.PopupBaseMenuItem({ activate: false, hover: false, focusOnHover: false });
        item.addActor(child, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _buildContextMenu() {
        let refresh = new PopupMenu.PopupIconMenuItem("Refresh", "xsi-view-refresh-symbolic",
                                                      St.IconType.SYMBOLIC);
        refresh.connect("activate", () => this._poll());
        this._applet_context_menu.addMenuItem(refresh);
    }

    _updateTooltips() {
        if (!this._rewBtn)
            return;
        this._rewBtn._tooltip.set_text(`Back ${this.seekStep}s`);
        this._ffBtn._tooltip.set_text(`Forward ${this.seekStep}s`);
    }

    _rebuildSessionMenu() {
        let key = JSON.stringify([this.pinnedSession,
                                  this.sessions.map(s => [s.Id, sessionLabel(s), !!s.NowPlayingItem])]);
        if (key === this._sessionMenuKey)
            return;   // avoid flicker while the submenu is open
        this._sessionMenuKey = key;

        let menu = this._sessionMenu.menu;
        menu.removeAll();
        let addItem = (label, id) => {
            let item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(PopupMenu.OrnamentType.DOT, (this.pinnedSession || "") === id);
            item.connect("activate", () => this._pinSession(id));
            menu.addMenuItem(item);
        };
        addItem("Auto (whatever is playing)", "");
        for (let s of this.sessions)
            addItem((s.NowPlayingItem ? "▶ " : "") + sessionLabel(s), s.Id);

        let pinned = this.sessions.find(s => s.Id === this.pinnedSession);
        this._sessionMenu.label.set_text(
            "Session: " + (this.pinnedSession ? (pinned ? sessionLabel(pinned) : "not found") : "Auto"));
    }

    _pinSession(id) {
        this.pinnedSession = id;
        this._rebuildSessionMenu();
        this._poll();
    }

    // ----- connection

    _onConnectionSettingsChanged() {
        // Ignore our own write-back after following a permanent redirect.
        if (this.client && normalizeServer(this.serverUrl) === this.client.server &&
            (this.apiKey || "").trim() === (this._clientApiKey || ""))
            return;
        this._connectClient();
        this._poll();
    }

    _connectClient() {
        if (this.client)
            this.client.destroy();
        this.client = null;
        this._clientApiKey = (this.apiKey || "").trim();
        let server = normalizeServer(this.serverUrl);
        let token = this._clientApiKey || this.token;
        if (!server || !token) {
            this.session = null;
            this._status = server ? "Not logged in" : "Not configured";
            this._statusDetail = "Right-click → Configure…";
            this._updateUi();
            return;
        }
        this.client = new JellyfinClient(server, this.deviceId, token,
                                         this._clientApiKey ? "" : this.userId);
        this._status = "Connecting…";
        this._statusDetail = server;
    }

    async onLoginClicked() {
        let server = normalizeServer(this.serverUrl);
        let username = (this.username || "").trim();
        if (!server || !username) {
            Main.notify("Jellyfin Remote", "Enter the server URL and your username first.");
            return;
        }
        let client = new JellyfinClient(server, this.deviceId);
        try {
            await client.authenticate(username, this.password || "");
        } catch (e) {
            Main.notify("Jellyfin Remote: login failed", errorText(e));
            return;
        } finally {
            client.destroy();
        }
        this.token = client.token;
        this.userId = client.userId;
        this.password = "";
        if (client.server !== server)
            this.serverUrl = client.server;
        if (this._clientApiKey)
            Main.notify("Jellyfin Remote", `Logged in as ${username}. Clear the API key to use this login.`);
        else
            Main.notify("Jellyfin Remote", `Logged in as ${username}.`);
        this._connectClient();
        this._poll();
    }

    // ----- polling

    _startTimers() {
        this._stopTimers();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, this.pollInterval), () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._updateProgress();
            return GLib.SOURCE_CONTINUE;
        });
        this._poll();
    }

    _stopTimers() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._pollId = this._tickId = 0;
    }

    async _poll() {
        if (this.polling || !this.client || this._destroyed)
            return;
        this.polling = true;
        let client = this.client;
        try {
            let sessions = await client.sessions();
            if (client !== this.client || this._destroyed)
                return;
            if (client.server !== normalizeServer(this.serverUrl))
                this.serverUrl = client.server;   // server moved permanently; remember it
            this._status = null;
            let own = this.deviceId;
            this.sessions = sessions.filter(s => s.SupportsRemoteControl && s.DeviceId !== own);
            this.session = this._pickSession();
        } catch (e) {
            if (client !== this.client || this._destroyed)
                return;
            this.session = null;
            this._status = "Server unreachable";
            this._statusDetail = errorText(e);
        } finally {
            this.polling = false;
        }
        this._rebuildSessionMenu();
        this._updateUi();
    }

    _pickSession() {
        if (this.pinnedSession)
            return this.sessions.find(s => s.Id === this.pinnedSession) || null;
        let playing = this.sessions.filter(s => s.NowPlayingItem);
        if (this.session) {   // stick with the current one while it keeps playing
            let same = playing.find(s => s.Id === this.session.Id);
            if (same)
                return same;
        }
        playing.sort((a, b) => (b.LastActivityDate || "").localeCompare(a.LastActivityDate || ""));
        return playing[0] || null;
    }

    // ----- UI updates

    _updateUi() {
        if (!this._label)
            return;
        let s = this.session;
        let item = s && s.NowPlayingItem;
        let state = (s && s.PlayState) || {};

        let title, subtitle, device;
        if (this._status) {
            [title, subtitle, device] = [this._status, this._statusDetail || "", ""];
        } else if (item) {
            [title, subtitle] = describeItem(item);
            device = sessionLabel(s);
        } else if (s) {
            [title, subtitle, device] = ["Idle", "", sessionLabel(s)];
        } else if (this.pinnedSession) {
            [title, subtitle, device] = ["Pinned session not found", "Pick another under Session", ""];
        } else {
            let n = this.sessions.length;
            [title, subtitle, device] = ["Nothing playing",
                                         `${n} controllable session${n === 1 ? "" : "s"}`, ""];
        }
        this._title = title;
        this._mTitle.set_text(title);
        this._mSubtitle.set_text(subtitle);
        this._mSubtitle.visible = !!subtitle;
        this._mDevice.set_text(device);
        this._mDevice.visible = !!device;

        this.runTicks = (item && item.RunTimeTicks) || 0;
        this.posTicks = state.PositionTicks || 0;
        this.posStamp = Date.now();
        this.paused = !!state.IsPaused || !item;
        this._setPlayIcons();

        this.volume = state.VolumeLevel != null ? state.VolumeLevel : null;
        this.muted = !!state.IsMuted;
        let icon = this.muted ? "muted"
            : this.volume == null || this.volume > 66 ? "high" : this.volume > 33 ? "medium" : "low";
        this._muteIcon.icon_name = `xsi-audio-volume-${icon}-symbolic`;
        if (Date.now() - this._volumeTouched > 2000 && !this._volSlider._dragging) {
            this._volSlider.setValue((this.volume || 0) / 100);
            this._mVol.set_text(this.volume != null ? `${this.volume}%` : "–");
        }

        // Panel: icon only when idle (if configured), otherwise controls + title.
        let active = !!item;
        let showControls = active || (!this.hideWhenIdle && !!this.client && !this._status);
        let vertical = this._isVertical();
        this._icon.visible = !showControls;
        this._playBtn.visible = showControls;
        this._prevBtn.visible = this._nextBtn.visible = showControls && this.showPrevNext && !vertical;
        this._label.visible = showControls && !vertical && (this.showTitle || this.showTime);
        this.set_applet_tooltip(device ? `${title}\n${device}` : `Jellyfin: ${title}`);

        this._updateProgress();
    }

    _setPlayIcons() {
        let icon = this.paused ? "xsi-media-playback-start-symbolic" : "xsi-media-playback-pause-symbolic";
        this._playBtn.get_child().icon_name = icon;
        this._mPlayBtn.get_child().icon_name = icon;
    }

    _currentTicks() {
        let ticks = this.posTicks;
        if (!this.paused)
            ticks += (Date.now() - this.posStamp) / 1000 * TICKS_PER_SEC;
        return this.runTicks ? Math.min(ticks, this.runTicks) : ticks;
    }

    _updateProgress() {
        let pos = this._currentTicks();
        let time = `${fmtTime(pos)} / ${fmtTime(this.runTicks)}`;
        this._mTime.set_text(time);
        if (!this._seeker._dragging)
            this._seeker.setValue(this.runTicks ? pos / this.runTicks : 0);

        let parts = [];
        if (this.showTitle && this._title)
            parts.push(truncate(this._title, this.titleMaxChars));
        if (this.showTime && this.runTicks)
            parts.push(fmtTime(pos));
        this._label.set_text(parts.join(" · "));
    }

    // ----- commands

    async _send(fn) {
        if (!this.client || !this.session)
            return;
        try {
            await fn(this.client, this.session.Id);
        } catch (e) {
            this._mDevice.set_text(`Command failed: ${errorText(e)}`);
            this._mDevice.visible = true;
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _play(command, params = null) {
        this._send((c, sid) => c.playstate(sid, command, params));
    }

    _cmd(name, args = {}) {
        this._send((c, sid) => c.command(sid, name, args));
    }

    _playPause() {
        if (!this.session)
            return;
        // Optimistic update; the next poll corrects it.
        this.posTicks = this._currentTicks();
        this.posStamp = Date.now();
        this.paused = !this.paused;
        this._setPlayIcons();
        this._play("PlayPause");
    }

    _seekAbs(ticks) {
        if (!this.session)
            return;
        ticks = Math.round(Math.max(0, this.runTicks ? Math.min(ticks, this.runTicks) : ticks));
        this.posTicks = ticks;
        this.posStamp = Date.now();
        this._updateProgress();
        this._play("Seek", { seekPositionTicks: ticks });
    }

    _seekRel(seconds) {
        this._seekAbs(this._currentTicks() + seconds * TICKS_PER_SEC);
    }

    _seekToSlider() {
        if (this.runTicks)
            this._seekAbs(this._seeker._value * this.runTicks);
    }

    _onVolumeSlider(value) {
        let volume = Math.round(value * 100);
        this._volumeTouched = Date.now();
        this._mVol.set_text(`${volume}%`);
        // Debounce while dragging so the client isn't flooded.
        if (this._volumeSendId)
            GLib.source_remove(this._volumeSendId);
        this._volumeSendId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._volumeSendId = 0;
            this._cmd("SetVolume", { Volume: volume });
            return GLib.SOURCE_REMOVE;
        });
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new JellyfinRemoteApplet(metadata, orientation, panelHeight, instanceId);
}
