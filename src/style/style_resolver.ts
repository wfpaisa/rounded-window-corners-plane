/**
 * @file Reads the window style the way GTK does for a libadwaita window:
 * libadwaita's stylesheet, the accent color and ~/.config/gtk-4.0/gtk.css,
 * following light, dark, high contrast and changes to gtk.css live.
 *
 * Adapted from lib/styleResolver.js of
 * https://github.com/ztrahmet/rounded-window-corners.
 */

import type {WindowLook} from './vendor/css_parse.js';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {logDebug} from '../utils/log.js';
import {
    FALLBACK_CSS,
    readWindowStyle,
    stripComments,
} from './vendor/css_parse.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*;/g;
const URI_SCHEME = /^[a-z][\w+.-]*:/i;

// From adw_accent_color_to_rgba().
const ACCENT_COLORS = new Map([
    [St.SystemAccentColor.BLUE, '#3584e4'],
    [St.SystemAccentColor.TEAL, '#2190a4'],
    [St.SystemAccentColor.GREEN, '#3a944a'],
    [St.SystemAccentColor.YELLOW, '#c88800'],
    [St.SystemAccentColor.ORANGE, '#ed5b00'],
    [St.SystemAccentColor.RED, '#e62d42'],
    [St.SystemAccentColor.PINK, '#d56199'],
    [St.SystemAccentColor.PURPLE, '#9141ac'],
    [St.SystemAccentColor.SLATE, '#6f8396'],
]);

type Rgba = [number, number, number, number];

/** GTK looks color names up with Pango. */
function colorName(name: string): Rgba | null {
    const color = new Pango.Color();
    const [found, alpha] = color.parse_with_alpha(name);
    return found
        ? [
              color.red / 65_535,
              color.green / 65_535,
              color.blue / 65_535,
              alpha / 65_535,
          ]
        : null;
}

export type LookFor = (classes: string[], backdrop: boolean) => WindowLook;

export class StyleResolver {
    /** The window's look for its state classes and focus. */
    lookFor: LookFor;

    readonly #probeScript: string;
    readonly #onChanged: () => void;
    readonly #cancellable = new Gio.Cancellable();
    readonly #userCss = Gio.File.new_for_path(
        GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'gtk-4.0',
            'gtk.css',
        ]),
    );
    readonly #settings = St.Settings.get();
    #sheets: [string, string] = ['', ''];
    #libadwaita: Promise<string> | null = null;
    #serial = 0;
    #key = '';
    #monitors: [Gio.FileMonitor, number][] = [];

    /**
     * @param probeScript - Path of adw_probe.js.
     * @param onChanged - Called when the style changes.
     */
    constructor(probeScript: string, onChanged: () => void) {
        this.#probeScript = probeScript;
        this.#onChanged = onChanged;

        this.#settings.connectObject(
            'notify::color-scheme',
            () => this.#update(),
            'notify::high-contrast',
            () => this.#update(),
            'notify::accent-color',
            () => this.#update(),
            this,
        );

        this.lookFor = this.#compute();
        this.#watch([this.#userCss]);
        this.#reload();
    }

    destroy() {
        this.#cancellable.cancel();
        this.#settings.disconnectObject(this);
        this.#unwatch();
    }

    /**
     * libadwaita adds the accent color in a stylesheet of its own, and GTK
     * names the desktop's accent_color.
     */
    #compute() {
        const [libadwaita, user] = this.#sheets;
        const accentColor = ACCENT_COLORS.get(this.#settings.accentColor);
        const accent = `@define-color accent_bg_color ${accentColor};
            @define-color accent_fg_color white;
            @define-color accent_color ${accentColor};`;
        const env = {
            dark:
                this.#settings.colorScheme === St.SystemColorScheme.PREFER_DARK,
            highContrast: this.#settings.highContrast,
            rtl:
                Clutter.get_default_text_direction() ===
                Clutter.TextDirection.RTL,
            colorName,
        };
        this.#key = JSON.stringify([libadwaita, user, accent, env]);
        return readWindowStyle([libadwaita || FALLBACK_CSS, accent, user], env);
    }

    #update() {
        const previous = this.#key;
        const lookFor = this.#compute();
        if (this.#key === previous) return;
        this.lookFor = lookFor;
        this.#onChanged();
    }

    async #reload() {
        const serial = ++this.#serial;
        this.#libadwaita ??= this.#readLibadwaita();
        const files: Gio.File[] = [];
        const [libadwaita, user] = await Promise.all([
            this.#libadwaita,
            this.#readCss(this.#userCss, files, []),
        ]);
        if (serial !== this.#serial || this.#cancellable.is_cancelled()) return;

        this.#sheets = [libadwaita, user];
        this.#watch(files);
        this.#update();
    }

    /** Only loading libadwaita registers its stylesheet, which the Shell must not do. */
    async #readLibadwaita() {
        try {
            const subprocess = Gio.Subprocess.new(
                ['gjs', '-m', this.#probeScript],
                // biome-ignore lint/suspicious/noBitwiseOperators: Bit flags.
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE,
            );
            const [stdout] = await subprocess.communicate_utf8_async(
                null,
                this.#cancellable,
            );
            if (subprocess.get_successful() && stdout) return stdout;
        } catch (e) {
            logDebug(`Could not read libadwaita's stylesheet: ${e}`);
        }
        logDebug("Using the built-in copy of libadwaita's window style");
        return '';
    }

    /** The stylesheet with its imports inlined; files collects every file read. */
    async #readCss(
        file: Gio.File,
        files: Gio.File[],
        importers: Gio.File[],
    ): Promise<string> {
        if (importers.some(f => f.equal(file))) return '';
        if (!files.some(f => f.equal(file))) files.push(file);

        let text: string;
        try {
            const [bytes] = await file.load_contents_async(this.#cancellable);
            text = stripComments(new TextDecoder().decode(bytes));
        } catch {
            return '';
        }

        const imports = await Promise.all(
            [...text.matchAll(IMPORT)].map(([, reference]) => {
                const child = URI_SCHEME.test(reference)
                    ? Gio.File.new_for_uri(reference)
                    : (file.get_parent() as Gio.File).resolve_relative_path(
                          reference,
                      );
                return this.#readCss(child, files, [...importers, file]);
            }),
        );
        return text.replace(IMPORT, () => imports.shift() ?? '');
    }

    #watch(files: Gio.File[]) {
        this.#unwatch();
        for (const file of files) {
            const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this.#monitors.push([
                monitor,
                monitor.connect('changed', () => this.#reload()),
            ]);
        }
    }

    #unwatch() {
        for (const [monitor, id] of this.#monitors) {
            monitor.disconnect(id);
            monitor.cancel();
        }
        this.#monitors = [];
    }
}
