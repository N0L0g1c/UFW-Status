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

const POLL_MS = 15000;

class Row extends PopupMenu.PopupBaseMenuItem {
    static { GObject.registerClass(this); }

    constructor(label) {
        super({reactive: false, can_focus: false, style_class: 'ufw-row'});
        this.add_child(new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ufw-key',
        }));
        this._val = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ufw-val',
            x_expand: true,
        });
        this.add_child(this._val);
    }

    set(text, extra = '') {
        this._val.text = text;
        this._val.style_class = extra ? `ufw-val ${extra}` : 'ufw-val';
    }
}

function spawn(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            resolve({ok: false, out: '', err: String(e)});
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                resolve({ok: p.get_exit_status() === 0, out: out || '', err: err || ''});
            } catch (e) {
                resolve({ok: false, out: '', err: String(e)});
            }
        });
    });
}

function parseStatus(text) {
    const info = {active: null, incoming: '—', outgoing: '—', rules: []};
    const low = text.toLowerCase();
    if (low.includes('status: active'))
        info.active = true;
    else if (low.includes('status: inactive'))
        info.active = false;

    const def = text.match(/Default:\s*(.+)/i);
    if (def) {
        const inc = def[1].match(/([a-z]+)\s*\(incoming\)/i);
        const out = def[1].match(/([a-z]+)\s*\(outgoing\)/i);
        if (inc)
            info.incoming = inc[1];
        if (out)
            info.outgoing = out[1];
    }

    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.length < 5)
            continue;
        if (/^(Status:|Default:|To\s+Action|Logging:|--)/i.test(t))
            continue;
        info.rules.push(t);
    }
    return info;
}

class Indicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.5, 'UFW Status', false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'UFW',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ufw-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._busy = false;
        this._timer = 0;
        this._openId = 0;

        this._fw = new Row('Firewall');
        this._in = new Row('Incoming');
        this._out = new Row('Outgoing');
        this._src = new Row('Source');
        this.menu.addMenuItem(this._fw);
        this.menu.addMenuItem(this._in);
        this.menu.addMenuItem(this._out);
        this.menu.addMenuItem(this._src);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rules = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'vfade ufw-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            child: this._rules.box,
        });
        scroll._delegate = this._rules;
        this._rules.actor = scroll;
        this.menu.addMenuItem(this._rules);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this._poll().catch(e => logError(e)));
        this.menu.addMenuItem(refresh);

        const gufw = new PopupMenu.PopupMenuItem('Open gufw');
        gufw.connect('activate', () => this._launchUi());
        this.menu.addMenuItem(gufw);

        const copy = new PopupMenu.PopupMenuItem('Copy status command');
        copy.connect('activate', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, 'sudo ufw status verbose');
            Main.notify('UFW Status', 'Copied: sudo ufw status verbose');
        });
        this.menu.addMenuItem(copy);

        this._note = new PopupMenu.PopupMenuItem('…', {reactive: false, can_focus: false});
        this._note.label.add_style_class_name('ufw-status');
        this.menu.addMenuItem(this._note);

        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._poll().catch(e => logError(e));
        });
    }

    start() {
        this._poll().catch(e => logError(e));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll().catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = 0;
        }
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        super.destroy();
    }

    _launchUi() {
        for (const name of ['gufw', 'firewall-config']) {
            const bin = GLib.find_program_in_path(name);
            if (bin) {
                Gio.Subprocess.new([bin], Gio.SubprocessFlags.NONE);
                return;
            }
        }
        Main.notify('UFW Status', 'Install gufw, or run: sudo ufw status verbose');
    }

    async _readConf() {
        try {
            const file = Gio.File.new_for_path('/etc/ufw/ufw.conf');
            if (!file.query_exists(null))
                return null;
            const [, bytes] = await file.load_contents_async(null);
            const m = new TextDecoder().decode(bytes).match(/^\s*ENABLED\s*=\s*(yes|no)/mi);
            return m ? m[1].toLowerCase() === 'yes' : null;
        } catch {
            return null;
        }
    }

    async _poll() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const ufw = GLib.find_program_in_path('ufw');
            if (ufw) {
                const res = await spawn([ufw, 'status']);
                if (res.ok || res.out.includes('Status:')) {
                    this._show(parseStatus(res.out), 'ufw status');
                    return;
                }
            }

            const on = await this._readConf();
            if (on !== null) {
                this._show({
                    active: on,
                    incoming: '—',
                    outgoing: '—',
                    rules: [],
                }, '/etc/ufw/ufw.conf');
                if (ufw)
                    this._note.label.text = 'Limited view (need permission for full status)';
                return;
            }

            this._show({active: null, incoming: '—', outgoing: '—', rules: []}, 'not found');
            this._note.label.text = 'UFW not found';
        } catch (e) {
            logError(e, 'UFW Status refresh failed');
            this._note.label.text = String(e.message || e).slice(0, 48);
        } finally {
            this._busy = false;
        }
    }

    _show(info, source) {
        if (info.active === true) {
            this._fw.set('ACTIVE', 'ufw-ok');
            this._label.text = 'ON';
            this._label.style_class = 'ufw-panel-label ufw-ok';
            this._icon.icon_name = 'security-high-symbolic';
        } else if (info.active === false) {
            this._fw.set('INACTIVE', 'ufw-danger');
            this._label.text = 'OFF';
            this._label.style_class = 'ufw-panel-label ufw-danger';
            this._icon.icon_name = 'security-low-symbolic';
        } else {
            this._fw.set('unknown', 'ufw-warn');
            this._label.text = 'UFW';
            this._label.style_class = 'ufw-panel-label ufw-warn';
            this._icon.icon_name = 'security-medium-symbolic';
        }

        this._in.set(info.incoming, info.incoming === 'deny' ? 'ufw-ok' : 'ufw-warn');
        this._out.set(info.outgoing);
        this._src.set(source);

        this._rules.removeAll();
        const rules = info.rules.slice(0, 30);
        if (!rules.length) {
            const empty = new PopupMenu.PopupMenuItem(
                info.active === false ? 'No rules (firewall off)' : 'No rules to show',
                {reactive: false, can_focus: false}
            );
            empty.label.add_style_class_name('ufw-hint');
            this._rules.addMenuItem(empty);
        } else {
            for (const rule of rules) {
                const item = new PopupMenu.PopupMenuItem(rule, {
                    reactive: false, can_focus: false,
                });
                item.label.add_style_class_name('ufw-rule');
                item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                this._rules.addMenuItem(item);
            }
        }

        const note = this._note.label.text || '';
        if (!note.startsWith('Limited') && !note.startsWith('UFW not') && !note.startsWith('Error'))
            this._note.label.text = `Updated ${GLib.DateTime.new_now_local().format('%H:%M:%S')}`;
    }
}

export default class UfwStatusExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.start();
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
