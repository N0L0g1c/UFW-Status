# UFW Status

GNOME Shell extension: top-panel **UFW firewall status** (active/inactive, defaults, rules snapshot).

## Features

- Panel badge: **ON** (active) / **OFF** (inactive)
- Default incoming / outgoing policies when `ufw status` is readable
- Truncated rules list in the menu
- Refresh on a timer and when the menu opens
- Open `gufw` or `firewall-config` if installed
- Copy `sudo ufw status verbose` for terminal use

## Requirements

- GNOME Shell **45–50**
- Optional: `ufw`, `gufw`

## Install (local)

```bash
UUID=ufw-status@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

On Wayland, log out and back in so the shell discovers a newly copied UUID, then enable it.

## How status is read

1. Prefer `ufw status` (system binary, non-interactive, read-only)
2. If that fails (permissions / missing), read `/etc/ufw/ufw.conf` for `ENABLED=`
3. Optional fallback: `nft list ruleset` presence hint

The extension **does not** enable or disable the firewall and **does not** run `pkexec` or other privileged helpers. Use gufw or `sudo ufw` for policy changes.

## Publish to extensions.gnome.org

Follows the [EGO review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html):

| Requirement | How this extension complies |
|---|---|
| GPL-compatible license | GPL-2.0-or-later (`LICENSE`) |
| External binaries | Only calls the system `ufw` / `nft` / GUI tools already on PATH; no bundled binaries |
| Processes exit cleanly | `Gio.Subprocess` with stdout/stderr pipes; no interactive prompts |
| Privileged subprocesses | None (status is best-effort unprivileged) |
| Lifecycle | Poll timer removed in `disable()` |
| No telemetry | No network access |
| Zip contents | Runtime files only (`./pack.sh`) |

### Package for upload

```bash
./pack.sh
# produces: ufw-status@n0l0g1c.github.io.shell-extension.zip
```

Upload at [extensions.gnome.org](https://extensions.gnome.org/).

## Development

```bash
cp -a ufw-status@n0l0g1c.github.io \
  ~/.local/share/gnome-shell/extensions/
journalctl -f /usr/bin/gnome-shell
```

## License

[GPL-2.0-or-later](LICENSE)

## Author

[N0L0g1c](https://github.com/N0L0g1c)
