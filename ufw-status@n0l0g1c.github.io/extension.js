// UFW Status — firewall panel indicator
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const POLL_MS = 15 * 1000;

class StatusRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(key, value, style = '') {
        super({
            reactive: false,
            can_focus: false,
            style_class: 'ufw-row',
        });
        this.add_child(new St.Label({
            text: key,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ufw-key',
        }));
        this._val = new St.Label({
            text: value,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `ufw-val ${style}`.trim(),
            x_expand: true,
        });
        this.add_child(this._val);
    }

    setValue(text, style = '') {
        this._val.text = text;
        this._val.style_class = `ufw-val ${style}`.trim();
    }
}

function runCommand(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    const status = p.get_exit_status();
                    resolve({
                        ok: status === 0,
                        stdout: stdout || '',
                        stderr: stderr || '',
                        status,
                    });
                } catch (e) {
                    resolve({
                        ok: false,
                        stdout: '',
                        stderr: String(e.message || e),
                        status: -1,
                    });
                }
            });
        } catch (e) {
            resolve({
                ok: false,
                stdout: '',
                stderr: String(e.message || e),
                status: -1,
            });
        }
    });
}

function parseUfwConfEnabled(confText) {
    const m = confText.match(/^\s*ENABLED\s*=\s*(yes|no)/mi);
    if (!m)
        return null;
    return m[1].toLowerCase() === 'yes';
}

function parseUfwStatus(text) {
    const result = {
        active: null,
        defaultIncoming: '—',
        defaultOutgoing: '—',
        rules: [],
        raw: text,
    };
    const lower = text.toLowerCase();
    if (lower.includes('status: active'))
        result.active = true;
    else if (lower.includes('status: inactive'))
        result.active = false;

    // e.g. Default: deny (incoming), allow (outgoing), disabled (routed)
    const defLine = text.match(/Default:\s*(.+)/i);
    if (defLine) {
        const inc = defLine[1].match(/([a-z]+)\s*\(incoming\)/i);
        const out = defLine[1].match(/([a-z]+)\s*\(outgoing\)/i);
        if (inc)
            result.defaultIncoming = inc[1];
        if (out)
            result.defaultOutgoing = out[1];
    } else {
        const defIn = text.match(/Default:\s*([a-z]+)\s*\(incoming\)/i);
        const defOut = text.match(/Default:\s*[a-z]+\s*\(incoming\),\s*([a-z]+)\s*\(outgoing\)/i);
        if (defIn)
            result.defaultIncoming = defIn[1];
        if (defOut)
            result.defaultOutgoing = defOut[1];
    }

    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        if (/^Status:/i.test(t) || /^Default:/i.test(t) || /^To\s+Action/i.test(t) ||
            /^--/.test(t) || /^Logging:/i.test(t))
            continue;
        if (t.length > 4)
            result.rules.push(t);
    }
    return result;
}

class UfwStatusIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'UFW Status', false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._panelIcon = new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            text: 'UFW',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ufw-panel-label',
        });
        box.add_child(this._panelLabel);

        this.add_child(box);

        this._pollSource = 0;
        this._menuOpenId = 0;
        this._refreshing = false;
        this._state = {
            active: null,
            defaultIncoming: '—',
            defaultOutgoing: '—',
            rules: [],
            source: '—',
        };

        this._stateRow = new StatusRow('Firewall', '…');
        this._inRow = new StatusRow('Incoming', '…');
        this._outRow = new StatusRow('Outgoing', '…');
        this._srcRow = new StatusRow('Source', '…');

        this.menu.addMenuItem(this._stateRow);
        this.menu.addMenuItem(this._inRow);
        this.menu.addMenuItem(this._outRow);
        this.menu.addMenuItem(this._srcRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rulesSection = new PopupMenu.PopupMenuSection();
        const scrollView = new St.ScrollView({
            style_class: 'vfade ufw-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            child: this._rulesSection.box,
        });
        scrollView._delegate = this._rulesSection;
        this._rulesSection.actor = scrollView;
        this.menu.addMenuItem(this._rulesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshItem.connect('activate', () => {
            this._refresh().catch(e => logError(e));
        });
        this.menu.addMenuItem(this._refreshItem);

        this._gufwItem = new PopupMenu.PopupMenuItem('Open firewall UI (gufw)');
        this._gufwItem.connect('activate', () => this._openGufw());
        this.menu.addMenuItem(this._gufwItem);

        this._termItem = new PopupMenu.PopupMenuItem('Copy status command');
        this._termItem.connect('activate', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                'sudo ufw status verbose'
            );
            Main.notify('UFW Status', 'Copied: sudo ufw status verbose');
        });
        this.menu.addMenuItem(this._termItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('Starting…', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('ufw-status');
        this.menu.addMenuItem(this._statusItem);

        const hint = new PopupMenu.PopupMenuItem(
            'Enable/disable needs root (gufw or sudo ufw).',
            {reactive: false, can_focus: false}
        );
        hint.label.add_style_class_name('ufw-hint');
        this.menu.addMenuItem(hint);

        this._menuOpenId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh().catch(e => logError(e));
        });
    }

    start() {
        this._refresh().catch(e => logError(e));
        this._pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._refresh().catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        if (this._pollSource) {
            try {
                GLib.Source.remove(this._pollSource);
            } catch {
                // already gone
            }
            this._pollSource = 0;
        }
        super.destroy();
    }

    _openGufw() {
        for (const cmd of ['gufw', 'firewall-config']) {
            const path = GLib.find_program_in_path(cmd);
            if (!path)
                continue;
            try {
                Gio.Subprocess.new([path], Gio.SubprocessFlags.NONE);
                return;
            } catch (e) {
                logError(e, `UFW Status: failed to launch ${cmd}`);
            }
        }
        Main.notify(
            'UFW Status',
            'gufw not found. Install gufw or run: sudo ufw status verbose'
        );
    }

    async _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;

        try {
            const ufwPath = GLib.find_program_in_path('ufw');
            if (ufwPath) {
                const res = await runCommand([ufwPath, 'status']);
                if (res.ok || res.stdout.includes('Status:')) {
                    const parsed = parseUfwStatus(res.stdout);
                    this._state = {
                        active: parsed.active,
                        defaultIncoming: parsed.defaultIncoming,
                        defaultOutgoing: parsed.defaultOutgoing,
                        rules: parsed.rules.slice(0, 30),
                        source: 'ufw status',
                    };
                    this._applyState();
                    return;
                }

                if (res.stderr.toLowerCase().includes('permission') ||
                    res.status !== 0) {
                    const conf = await this._readUfwConf();
                    if (conf !== null) {
                        this._state = {
                            active: conf,
                            defaultIncoming: '—',
                            defaultOutgoing: '—',
                            rules: [],
                            source: '/etc/ufw/ufw.conf',
                        };
                        this._statusItem.label.text =
                            'Limited view (no permission for full status)';
                        this._applyState();
                        return;
                    }
                }
            }

            const conf = await this._readUfwConf();
            if (conf !== null) {
                this._state = {
                    active: conf,
                    defaultIncoming: '—',
                    defaultOutgoing: '—',
                    rules: [],
                    source: '/etc/ufw/ufw.conf',
                };
                this._applyState();
                return;
            }

            const nft = GLib.find_program_in_path('nft');
            if (nft) {
                const res = await runCommand([nft, 'list', 'ruleset']);
                if (res.ok && res.stdout.trim()) {
                    this._state = {
                        active: true,
                        defaultIncoming: '—',
                        defaultOutgoing: '—',
                        rules: res.stdout.split('\n').filter(l => l.trim()).slice(0, 20),
                        source: 'nft ruleset (fallback)',
                    };
                    this._applyState();
                    return;
                }
            }

            this._state = {
                active: null,
                defaultIncoming: '—',
                defaultOutgoing: '—',
                rules: [],
                source: 'not detected',
            };
            this._statusItem.label.text = 'UFW not found or unreadable';
            this._applyState();
        } catch (e) {
            logError(e, 'UFW Status refresh failed');
            this._statusItem.label.text = `Error: ${String(e.message || e).slice(0, 48)}`;
        } finally {
            this._refreshing = false;
        }
    }

    async _readUfwConf() {
        try {
            const file = Gio.File.new_for_path('/etc/ufw/ufw.conf');
            if (!file.query_exists(null))
                return null;
            const [, bytes] = await file.load_contents_async(null);
            return parseUfwConfEnabled(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    _applyState() {
        const {active, defaultIncoming, defaultOutgoing, rules, source} = this._state;

        if (active === true) {
            this._stateRow.setValue('ACTIVE', 'ufw-ok');
            this._panelLabel.text = 'ON';
            this._panelLabel.style_class = 'ufw-panel-label ufw-ok';
            this._panelIcon.icon_name = 'security-high-symbolic';
        } else if (active === false) {
            this._stateRow.setValue('INACTIVE', 'ufw-danger');
            this._panelLabel.text = 'OFF';
            this._panelLabel.style_class = 'ufw-panel-label ufw-danger';
            this._panelIcon.icon_name = 'security-low-symbolic';
        } else {
            this._stateRow.setValue('unknown', 'ufw-warn');
            this._panelLabel.text = 'UFW';
            this._panelLabel.style_class = 'ufw-panel-label ufw-warn';
            this._panelIcon.icon_name = 'security-medium-symbolic';
        }

        this._inRow.setValue(defaultIncoming, defaultIncoming === 'deny' ? 'ufw-ok' : 'ufw-warn');
        this._outRow.setValue(defaultOutgoing, '');
        this._srcRow.setValue(source, '');

        this._rulesSection.removeAll();
        if (rules.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                active === false ? 'No rules (firewall off)' : 'No rule lines to show',
                {reactive: false, can_focus: false}
            );
            empty.label.add_style_class_name('ufw-hint');
            this._rulesSection.addMenuItem(empty);
        } else {
            const header = new PopupMenu.PopupMenuItem('Rules (truncated)', {
                reactive: false,
                can_focus: false,
            });
            header.label.add_style_class_name('ufw-hint');
            this._rulesSection.addMenuItem(header);
            for (const rule of rules) {
                const item = new PopupMenu.PopupMenuItem(rule, {
                    reactive: false,
                    can_focus: false,
                });
                item.label.add_style_class_name('ufw-rule');
                item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                this._rulesSection.addMenuItem(item);
            }
        }

        const now = GLib.DateTime.new_now_local();
        const prev = this._statusItem.label.text || '';
        if (!prev.startsWith('Limited') &&
            !prev.startsWith('UFW not') &&
            !prev.startsWith('Error')) {
            this._statusItem.label.text = `Updated ${now.format('%H:%M:%S')}`;
        }
    }
}

export default class UfwStatusExtension extends Extension {
    _addToPanel(role, indicator) {
        const existing = Main.panel.statusArea[role];
        if (existing) {
            try {
                existing.destroy();
            } catch {
                // ignore
            }
            if (Main.panel.statusArea[role])
                delete Main.panel.statusArea[role];
        }
        Main.panel.addToStatusArea(role, indicator);
    }

    enable() {
        this._indicator = new UfwStatusIndicator();
        this._addToPanel(this.uuid, this._indicator);
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
