// SPDX-License-Identifier: GPL-2.0-or-later
/* ufw status in the panel */

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

function run(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    code: p.get_exit_status(),
                    stdout: stdout || '',
                    stderr: stderr || '',
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'UFW Status');

        this._icon = new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'system-status-icon',
        });
        this._text = new St.Label({
            text: 'UFW',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout();
        box.add_child(this._icon);
        box.add_child(this._text);
        this.add_child(box);

        this._state = new PopupMenu.PopupMenuItem('…', {reactive: false});
        this._in = new PopupMenu.PopupMenuItem('Incoming: …', {reactive: false});
        this._out = new PopupMenu.PopupMenuItem('Outgoing: …', {reactive: false});
        this.menu.addMenuItem(this._state);
        this.menu.addMenuItem(this._in);
        this.menu.addMenuItem(this._out);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rules = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rules);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let item = new PopupMenu.PopupMenuItem('Refresh');
        item.connect('activate', () => {
            this._update();
        });
        this.menu.addMenuItem(item);

        item = new PopupMenu.PopupMenuItem('Open gufw');
        item.connect('activate', () => {
            const p = GLib.find_program_in_path('gufw') ||
                GLib.find_program_in_path('firewall-config');
            if (p)
                Gio.Subprocess.new([p], Gio.SubprocessFlags.NONE);
            else
                Main.notify('UFW Status', 'gufw is not installed');
        });
        this.menu.addMenuItem(item);

        item = new PopupMenu.PopupMenuItem('Copy: sudo ufw status verbose');
        item.connect('activate', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                'sudo ufw status verbose');
        });
        this.menu.addMenuItem(item);

        this._footer = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._footer);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._update();
        });

        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this._update();
    }

    destroy() {
        if (this._timeout) {
            GLib.Source.remove(this._timeout);
            this._timeout = 0;
        }
        super.destroy();
    }

    async _readConf() {
        const file = Gio.File.new_for_path('/etc/ufw/ufw.conf');
        if (!file.query_exists(null))
            return null;
        const [, contents] = await file.load_contents_async(null);
        const m = new TextDecoder().decode(contents).match(/ENABLED=(yes|no)/i);
        return m ? m[1].toLowerCase() === 'yes' : null;
    }

    async _update() {
        let active = null;
        let incoming = '?';
        let outgoing = '?';
        let rules = [];
        let note = '';

        try {
            const bin = GLib.find_program_in_path('ufw');
            if (bin) {
                const r = await run([bin, 'status']);
                const out = r.stdout;
                if (out.toLowerCase().includes('status: active'))
                    active = true;
                else if (out.toLowerCase().includes('status: inactive'))
                    active = false;

                const def = out.match(/Default:\s*(.+)/i);
                if (def) {
                    const a = def[1].match(/(\w+)\s*\(incoming\)/i);
                    const b = def[1].match(/(\w+)\s*\(outgoing\)/i);
                    if (a)
                        incoming = a[1];
                    if (b)
                        outgoing = b[1];
                }

                for (const line of out.split('\n')) {
                    const t = line.trim();
                    if (!t || /^(Status|Default|To\s+Action|Logging|--)/i.test(t))
                        continue;
                    if (t.length > 4)
                        rules.push(t);
                }

                if (active === null) {
                    const conf = await this._readConf();
                    if (conf !== null) {
                        active = conf;
                        note = 'limited (no permission for full status)';
                    }
                }
            } else {
                const conf = await this._readConf();
                if (conf !== null)
                    active = conf;
                else
                    note = 'ufw not found';
            }
        } catch (e) {
            note = String(e.message || e).slice(0, 40);
            logError(e);
        }

        if (active === true) {
            this._state.label.text = 'Firewall: ACTIVE';
            this._text.text = 'ON';
            this._icon.icon_name = 'security-high-symbolic';
        } else if (active === false) {
            this._state.label.text = 'Firewall: INACTIVE';
            this._text.text = 'OFF';
            this._icon.icon_name = 'security-low-symbolic';
        } else {
            this._state.label.text = 'Firewall: ?';
            this._text.text = 'UFW';
            this._icon.icon_name = 'security-medium-symbolic';
        }
        this._in.label.text = `Incoming: ${incoming}`;
        this._out.label.text = `Outgoing: ${outgoing}`;

        this._rules.removeAll();
        if (!rules.length) {
            this._rules.addMenuItem(new PopupMenu.PopupMenuItem(
                active === false ? '(firewall off)' : '(no rules listed)',
                {reactive: false}));
        } else {
            for (const rule of rules.slice(0, 25)) {
                const mi = new PopupMenu.PopupMenuItem(rule, {reactive: false});
                mi.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                this._rules.addMenuItem(mi);
            }
        }

        this._footer.label.text = note ||
            GLib.DateTime.new_now_local().format('updated %H:%M:%S');
    }
});

export default class extends Extension {
    enable() {
        this._btn = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._btn);
    }

    disable() {
        this._btn.destroy();
        this._btn = null;
    }
}
