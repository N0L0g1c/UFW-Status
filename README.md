# UFW Status

GNOME Shell extension that shows UFW firewall status in the top panel.

![Screenshot](screenshots/screenshot.png)

## Features

- Panel badge: **ON** / **OFF**
- Incoming/outgoing defaults when `ufw status` is readable
- Truncated rules list in the menu
- Refresh on a timer and when the menu opens
- Open `gufw` or `firewall-config` if installed
- Copy `sudo ufw status verbose` for the terminal

## Requirements

- GNOME Shell **45–50**
- Optional: `ufw`, `gufw`

## Install

```bash
UUID=ufw-status@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

Log out/in on Wayland (or restart GNOME Shell) so the extension is picked up.

## How status is read

1. `ufw status` (read-only)
2. If that fails, `/etc/ufw/ufw.conf` for `ENABLED=`
3. Optional fallback: `nft list ruleset`

This extension does **not** enable/disable the firewall and does not use `pkexec`. Use gufw or `sudo ufw` for changes.

## Packaging

```bash
./pack.sh
# → ufw-status@n0l0g1c.github.io.shell-extension.zip
```

Zip contents: `metadata.json`, `extension.js`, `stylesheet.css`, `LICENSE`.

## License

[GPL-2.0-or-later](LICENSE)

## Author

[N0L0g1c](https://github.com/N0L0g1c)
