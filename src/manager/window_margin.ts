/** Reserve real work-area space while keeping native maximize/tile states. */
import type Gio from 'gi://Gio';

import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layoutManager} from 'resource:///org/gnome/shell/ui/main.js';

export class WindowMargin {
    readonly #injections = new InjectionManager();
    readonly #settings: Gio.Settings;
    #connections: number[] = [];

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
        this.#injections.overrideMethod(
            Meta.Workspace.prototype,
            'set_builtin_struts',
            original => {
                const settings = this.#settings;
                return function (struts) {
                    // First restore GNOME's baseline so margins never accumulate.
                    original.call(this, struts);
                    if (!settings.get_boolean('window-margin-enabled')) return;
                    const margin = settings.get_int('window-margin');
                    if (margin === 0) return;

                    const extra = marginStruts(this, margin);
                    original.call(this, [...struts, ...extra]);
                };
            },
        );
        for (const key of ['window-margin-enabled', 'window-margin']) {
            this.#connections.push(
                settings.connect(`changed::${key}`, () => {
                    layoutManager._queueUpdateRegions();
                }),
            );
        }
        layoutManager._queueUpdateRegions();
    }

    destroy() {
        for (const id of this.#connections) this.#settings.disconnect(id);
        this.#connections = [];
        this.#injections.clear();
        // Recompute the original struts when disabling or unloading the extension.
        layoutManager._queueUpdateRegions();
    }
}

function marginStruts(workspace: Meta.Workspace, margin: number) {
    const extra: Meta.Strut[] = [];
    for (const monitor of layoutManager.monitors) {
        const area = workspace.get_work_area_for_monitor(monitor.index);
        // Keep a usable area even on unusually small displays.
        const gap = Math.min(
            margin,
            Math.floor((Math.min(area.width, area.height) - 1) / 2),
        );
        if (gap <= 0) continue;
        const edges = [
            [
                Meta.Side.TOP,
                monitor.x,
                monitor.y,
                monitor.width,
                area.y - monitor.y + gap,
            ],
            [
                Meta.Side.BOTTOM,
                monitor.x,
                area.y + area.height - gap,
                monitor.width,
                monitor.y + monitor.height - area.y - area.height + gap,
            ],
            [
                Meta.Side.LEFT,
                monitor.x,
                monitor.y,
                area.x - monitor.x + gap,
                monitor.height,
            ],
            [
                Meta.Side.RIGHT,
                area.x + area.width - gap,
                monitor.y,
                monitor.x + monitor.width - area.x - area.width + gap,
                monitor.height,
            ],
        ];
        for (const [side, x, y, width, height] of edges) {
            const strut = new Meta.Strut();
            strut.side = side;
            strut.rect = new Mtk.Rectangle({x, y, width, height});
            extra.push(strut);
        }
    }
    return extra;
}
