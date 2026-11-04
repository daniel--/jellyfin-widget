# Jellyfin Widget

A tiny always-on-top, translucent remote control for a Jellyfin server.
It controls whatever Jellyfin client is currently playing, such as the web player, a TV app or Jellyfin Media Player.

It's a single Python file that uses GTK 3 and the standard library only, so there's nothing to `pip install`
(needs `python3-gi` and `python3-gi-cairo`, which most Linux desktops already have).

## Run

```sh
./jellyfin_widget.py
```

On first run a settings dialog asks for your server URL and either a username/password
or an API key (Dashboard → API Keys). Only the access token is saved, never the password.
It's stored in `~/.config/jellyfin-widget/config.json` (mode 600).

## Use

| Action | How |
| --- | --- |
| Move | Drag the dotted handle on the left |
| Play / pause, prev / next, ±10 s, stop | Buttons |
| Seek | Click on the progress bar |
| Volume | Scroll anywhere on the widget, or use the − / + / mute buttons |
| Pick which client to control | Right-click → choose a session (default: Auto, which follows whatever is playing) |
| Background opacity, settings, quit | Right-click menu (or the × to quit) |

The window position, opacity and chosen session are remembered.

## Autostart

From the repo folder (this fills in the path to the script):

```sh
sed "s|^Exec=.*|Exec=$PWD/jellyfin_widget.py|" jellyfin-widget.desktop > ~/.config/autostart/jellyfin-widget.desktop
```

Notes: transparency needs a compositing window manager (Cinnamon, GNOME, KDE and others).
On Wayland, "always on top" and dragging depend on the compositor; it works best on X11.

## Cinnamon panel applet

Prefer it in the panel instead of floating? `cinnamon-applet/jellyfin-remote@jellyfin-widget` is a
native Cinnamon applet with the same controls. It's separate from the Python widget: use either one, or both.

The panel shows ⏮ ⏯ ⏭ plus the title and position. When nothing is playing it shrinks to a single icon.

| Action | How |
| --- | --- |
| Play / pause, prev / next | Panel buttons (or middle-click the applet to play/pause) |
| Seek, ±10 s, stop, volume, mute | Click the applet to open its popup |
| Volume | Scroll over the applet |
| Pick which client to control | Popup → Session |
| Server, login, what's shown | Right-click → Configure… |

Install by linking it into Cinnamon's applet folder, then add it from *System Settings → Applets*
(or right-click the panel → *Applets*):

```sh
ln -s "$PWD/cinnamon-applet/jellyfin-remote@jellyfin-widget" ~/.local/share/cinnamon/applets/
```

In *Configure…*, enter the server URL. Then either type your username and password and press **Log in**,
or paste an API key. After logging in the password is cleared and only the access token is kept.
The settings live in `~/.config/cinnamon/spices/jellyfin-remote@jellyfin-widget/`, which the applet
makes private (mode 700). Note that Cinnamon's settings window shows the password field unmasked while you type.

After editing `applet.js`, reload every instance with Looking Glass (Alt+F2 → `lg` → Extensions →
right-click it → *Reload Code*) or restart Cinnamon (Ctrl+Alt+Esc). Errors go to `~/.xsession-errors` and Looking Glass.
