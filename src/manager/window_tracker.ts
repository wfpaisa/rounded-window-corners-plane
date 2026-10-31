/**
 * @file Decides which windows get rounded corners and keeps their effects in
 * sync with the window's state, its focus and the GTK style.
 *
 * Adapted from lib/windowTracker.js of
 * https://github.com/ztrahmet/rounded-window-corners, with the blacklist,
 * the effects hidden while a window is dragged, and GTK's maximized, tiled and
 * fullscreen styles.
 */

import type {LookFor} from '../style/style_resolver.js';
import type {WindowLook} from '../style/vendor/css_parse.js';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {
    type Decoration,
    RoundedCornersEffect,
    ShadowRoomEffect,
} from '../effect/rounded_corners_effect.js';
import {compileShadow, shadowExtent} from '../effect/shadow.js';
import {StyleResolver} from '../style/style_resolver.js';
import {readFile} from '../utils/file.js';
import {logDebug} from '../utils/log.js';
import {getPref, prefs} from '../utils/settings.js';

const EFFECT_NAME = 'Rounded Corners Plane Effect';
const ROOM_NAME = 'Rounded Corners Plane Shadow Room';

// Desktop Icons NG draws the desktop in a window of its own.
const DESKTOP_APP_IDS = new Set(['com.rastersoft.ding']);

const ROUNDABLE_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

// Mutter handles both mouse and pen window moves through grab operations.
const POINTER_GRABS = new Set([
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
    Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_N,
    Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E,
    Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.RESIZING_W,
]);

// Fade in of the decoration after a drag ends.
const RESTORE_MS = 180;

// How long a new state may wait for the app to draw at a new size, since
// some changes, like going fullscreen on a window that already fills the
// monitor, keep the size.
const STATE_FALLBACK_MS = 300;

// After a window changes monitor, the app's next frame at the new scale.
const APP_SCALE_DELAY_MS = 500;

/** Whether the window's process has libadwaita loaded. */
async function usesLibadwaita(win: Meta.Window) {
    try {
        const maps = await readFile(`/proc/${win.get_pid()}/maps`);
        return maps.includes('libadwaita-1.so');
    } catch {
        // The process is unknown, gone, or not ours to read.
        return false;
    }
}

function frameOf(win: Meta.Window) {
    const {x, y, width, height} = win.get_frame_rect();
    return {x, y, width, height};
}

export class WindowTracker {
    // A window maps to null while its toolkit is being probed.
    readonly #windows = new Map<Meta.WindowActor, RoundedWindow | null>();
    readonly #styles: StyleResolver;

    /** @param probeScript - Path of adw_probe.js. */
    constructor(probeScript: string) {
        this.#styles = new StyleResolver(probeScript, () => this.#syncAll());

        for (const actor of global.get_window_actors()) this.#track(actor);

        global.display.connectObject(
            'window-created',
            (_: Meta.Display, win: Meta.Window) => {
                const actor = win.get_compositor_private();
                if (actor instanceof Meta.WindowActor) this.#track(actor);
            },
            'grab-op-begin',
            (_: Meta.Display, win: Meta.Window, op: Meta.GrabOp) => {
                if (POINTER_GRABS.has(op)) this.#windowOf(win)?.beginGrab();
            },
            'grab-op-end',
            (_: Meta.Display, win: Meta.Window) =>
                this.#windowOf(win)?.endGrab(),
            this,
        );

        prefs.connectObject(
            'changed::blacklist',
            () => this.#syncAll(),
            'changed::whitelist',
            () => this.#syncAll(),
            'changed::suspend-during-interaction',
            () => this.#syncAll(),
            this,
        );
    }

    destroy() {
        global.display.disconnectObject(this);
        prefs.disconnectObject(this);

        for (const actor of this.#windows.keys()) this.#untrack(actor);

        this.#styles.destroy();
    }

    #windowOf(win: Meta.Window | null) {
        const actor = win?.get_compositor_private();
        return actor instanceof Meta.WindowActor
            ? this.#windows.get(actor)
            : null;
    }

    #syncAll() {
        for (const window of this.#windows.values()) window?.sync();
    }

    /** libadwaita apps round their windows themselves. */
    async #track(actor: Meta.WindowActor) {
        const win = actor.metaWindow;
        if (!win || this.#windows.has(actor)) return;
        this.#windows.set(actor, null);
        actor.connectObject('destroy', () => this.#untrack(actor), this);

        const adwaita = await usesLibadwaita(win);
        if (this.#windows.get(actor) !== null) return;

        if (adwaita) {
            logDebug(`Skipping libadwaita window ${win.wmClass}`);
            this.#untrack(actor);
        } else {
            this.#windows.set(
                actor,
                new RoundedWindow(actor, win, () => this.#styles.lookFor),
            );
        }
    }

    #untrack(actor: Meta.WindowActor) {
        actor.disconnectObject(this);
        this.#windows.get(actor)?.destroy();
        this.#windows.delete(actor);
    }
}

class RoundedWindow {
    readonly #actor: Meta.WindowActor;
    readonly #metaWindow: Meta.Window;
    readonly #styles: () => LookFor;
    #effect: InstanceType<typeof RoundedCornersEffect> | null = null;
    #room: InstanceType<typeof ShadowRoomEffect> | null = null;
    #texture: Meta.ShapedTexture | null = null;
    #width = 0;
    #height = 0;
    // GTK's state classes the window is drawn with, and since when.
    #classes: string[] = [];
    #stateFallback = 0;
    #lastDecoration = '';
    // Scale the app draws at, and the monitor it was measured on.
    #appScale = 1;
    #monitor = -1;
    #appScaleCheck = 0;

    // Frame when a pointer grab began; it is only a drag once it changes.
    #grabFrame: ReturnType<typeof frameOf> | null = null;
    #dragging = false;
    #restore: Clutter.Timeline | null = null;

    constructor(
        actor: Meta.WindowActor,
        win: Meta.Window,
        styles: () => LookFor,
    ) {
        this.#actor = actor;
        this.#metaWindow = win;
        this.#styles = styles;

        // biome-ignore lint/correctness/useQwikValidLexicalScope: This is a GJS signal callback, not a Qwik component.
        const sync = () => this.sync();
        // An X11 window gets its surface, or a new one, after it is created.
        actor.connectObject('notify::size', sync, 'child-added', sync, this);
        this.#metaWindow.connectObject(
            'notify::appears-focused',
            sync,
            'notify::wm-class',
            sync,
            'notify::fullscreen',
            sync,
            'notify::maximized-horizontally',
            sync,
            'notify::maximized-vertically',
            sync,
            'size-changed',
            () => this.#geometryChanged(),
            // The tiled edges depend on where the window is.
            'position-changed',
            () => {
                this.#geometryChanged();
                this.#checkMonitor();
                if (this.#isTiled()) sync();
            },
            this,
        );
        this.sync();
    }

    destroy() {
        this.#actor.disconnectObject(this);
        this.#metaWindow.disconnectObject(this);
        this.#texture?.disconnectObject(this);
        this.#stopRestore();
        this.#clearStateFallback();
        this.#cancelAppScaleCheck();
        if (this.#effect && this.#room) {
            this.#actor.remove_effect(this.#effect);
            this.#actor.remove_effect(this.#room);
        }
    }

    sync() {
        this.#watchTexture();

        // As in libadwaita, the look changes once the app has drawn its new size.
        const classes = this.#stateClasses();
        const [, width, height] = this.#texture
            ? this.#texture.get_preferred_size()
            : [false, 0, 0];
        if (width !== this.#width || height !== this.#height) {
            this.#width = width;
            this.#height = height;
            this.#measureAppScale();
            this.#adoptState(classes);
        } else if (classes.join() !== this.#classes.join()) {
            this.#waitForState(classes);
            return;
        }

        const look = this.#look(this.#metaWindow.appearsFocused);
        const round = this.#shouldRound(look);
        if (round !== this.#isRounded()) this.#apply(round);
        else if (round) this.#update();
    }

    beginGrab() {
        this.#grabFrame = frameOf(this.#metaWindow);
    }

    endGrab() {
        this.#grabFrame = null;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Set by #geometryChanged().
        if (!this.#dragging) return;
        this.#dragging = false;
        const fade = getPref('suspend-during-interaction');
        this.sync();
        if (fade && this.#isRounded()) this.#fadeIn();
    }

    /** A title-bar press alone is not a drag: wait for a real frame change. */
    #geometryChanged() {
        if (!this.#grabFrame || this.#dragging) return;
        const frame = frameOf(this.#metaWindow);
        const start = this.#grabFrame;
        if (
            frame.x === start.x &&
            frame.y === start.y &&
            frame.width === start.width &&
            frame.height === start.height
        )
            return;
        this.#dragging = true;
        if (getPref('suspend-during-interaction')) this.sync();
    }

    /**
     * Read the scale the app draws at from its picture. Only on changes:
     * each read keeps that frame's buffer alive until the JS wrapper is
     * collected, and an app like Chrome sends a new buffer every frame.
     */
    #measureAppScale() {
        this.#monitor = this.#metaWindow.get_monitor();
        const content = this.#texture;
        const texture = content?.get_texture();
        if (!(content && texture && this.#width && this.#height)) return;
        this.#appScale = Math.sqrt(
            (texture.get_width() * texture.get_height()) /
                (this.#width * this.#height),
        );
    }

    /** On another monitor the app draws at its scale, a frame later. */
    #checkMonitor() {
        if (this.#metaWindow.get_monitor() === this.#monitor) return;
        this.#monitor = this.#metaWindow.get_monitor();
        this.#cancelAppScaleCheck();
        this.#appScaleCheck = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            APP_SCALE_DELAY_MS,
            () => {
                this.#appScaleCheck = 0;
                this.#measureAppScale();
                this.sync();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    #cancelAppScaleCheck() {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Set by #checkMonitor().
        if (this.#appScaleCheck) GLib.source_remove(this.#appScaleCheck);
        this.#appScaleCheck = 0;
    }

    /**
     * How deep the app's own border reaches: it is at the frame, cut away
     * with the margin, and an app drawing at a fractional scale blurs its
     * 1 px border over one more of its pixels.
     */
    #appBorderWidth(look: WindowLook) {
        if (!look.margins.every(margin => margin === 0)) return 0;
        return this.#appScale % 1 === 0 ? 1 : 1 + 1 / this.#appScale;
    }

    /** Follow the app's picture, which an X11 window can swap for a new one. */
    #watchTexture() {
        const texture = this.#actor.get_texture();
        if (texture === this.#texture) return;
        this.#texture?.disconnectObject(this);
        this.#texture = texture;
        this.#texture?.connectObject('size-changed', () => this.sync(), this);
    }

    #isTiled() {
        const win = this.#metaWindow;
        return win.maximizedHorizontally !== win.maximizedVertically;
    }

    /** The classes GTK gives a window in this state, with tiled edges as on Wayland. */
    #stateClasses() {
        const win = this.#metaWindow;
        // Mutter tells such windows they are tiled on every edge too, so GTK
        // matches its tiled rules on them as well.
        const allEdges = [
            'tiled-bottom',
            'tiled-left',
            'tiled-right',
            'tiled-top',
        ];
        if (win.fullscreen) return ['fullscreen', ...allEdges];
        const horizontal = win.maximizedHorizontally;
        const vertical = win.maximizedVertically;
        if (horizontal && vertical) return ['maximized', ...allEdges];
        if (!(horizontal || vertical)) return [];

        const frame = win.get_frame_rect();
        const area = win.get_work_area_current_monitor();
        const edges = new Set<string>();
        if (vertical) edges.add('tiled-top').add('tiled-bottom');
        if (horizontal) edges.add('tiled-left').add('tiled-right');
        if (frame.x <= area.x) edges.add('tiled-left');
        if (frame.x + frame.width >= area.x + area.width)
            edges.add('tiled-right');
        if (frame.y <= area.y) edges.add('tiled-top');
        if (frame.y + frame.height >= area.y + area.height)
            edges.add('tiled-bottom');
        // The side shared with the window tiled next to it.
        const match = win.get_tile_match()?.get_frame_rect();
        if (match) edges.add(match.x > frame.x ? 'tiled-right' : 'tiled-left');
        return [...edges].sort();
    }

    #adoptState(classes: string[]) {
        this.#clearStateFallback();
        this.#classes = classes;
    }

    #waitForState(classes: string[]) {
        this.#clearStateFallback();
        this.#stateFallback = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            STATE_FALLBACK_MS,
            () => {
                this.#stateFallback = 0;
                this.#adoptState(classes);
                this.sync();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    #clearStateFallback() {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Set by #waitForState().
        if (this.#stateFallback) GLib.source_remove(this.#stateFallback);
        this.#stateFallback = 0;
    }

    #look(focused: boolean) {
        return this.#styles()(this.#classes, !focused);
    }

    #shouldRound(look: WindowLook) {
        const win = this.#metaWindow;
        return (
            this.#width > 0 &&
            hasDecoration(look, isFilled(this.#classes)) &&
            ROUNDABLE_TYPES.has(win.windowType) &&
            !DESKTOP_APP_IDS.has(win.gtkApplicationId ?? '') &&
            isListed(win) &&
            // biome-ignore lint/suspicious/noUnnecessaryConditions: Set by #geometryChanged().
            !(this.#dragging && getPref('suspend-during-interaction'))
        );
    }

    #isRounded() {
        return this.#effect?.enabled ?? false;
    }

    /**
     * Once added, the effects are only turned off, to stay before later
     * offscreen effects like the Shell's dimmer.
     */
    #apply(round: boolean) {
        if (!(this.#effect && this.#room)) {
            this.#room = new ShadowRoomEffect();
            this.#effect = new RoundedCornersEffect(this.#room);
            this.#update();
            this.#actor.add_effect_with_name(ROOM_NAME, this.#room);
            this.#actor.add_effect_with_name(EFFECT_NAME, this.#effect);
            return;
        }

        this.#stopRestore();
        if (round) this.#update();
        this.#room.enabled = round;
        this.#effect.enabled = round;
        this.#actor.invalidate_paint_volume();
    }

    /**
     * The frame keeps its margins inside the app's picture, which on X11 can
     * lag behind the buffer while resizing.
     */
    #update() {
        const effect = this.#effect;
        const room = this.#room;
        if (!(effect && room)) return;

        const win = this.#metaWindow;
        const buffer = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        const look = this.#look(win.appearsFocused);
        // GTK draws the window inside its CSS margin, clockwise from the top.
        const [top, right, bottom, left] = look.margins;
        const bounds = [
            frame.x - buffer.x + left,
            frame.y - buffer.y + top,
            this.#width -
                (buffer.x + buffer.width - frame.x - frame.width) -
                right,
            this.#height -
                (buffer.y + buffer.height - frame.y - frame.height) -
                bottom,
        ];

        // GTK leaves no room around a maximized or fullscreen window: what it
        // draws past the margin, like libadwaita's ring when unfocused, is cut.
        const filled = isFilled(this.#classes);
        const frameBox = [
            frame.x - buffer.x,
            frame.y - buffer.y,
            bounds[2] + right,
            bounds[3] + bottom,
        ];

        // Room for both looks, so it doesn't change when focus does.
        const reach =
            Math.max(
                ...[this.#look(true), this.#look(false)].map(each =>
                    Math.max(
                        shadowExtent(each.shadow),
                        each.outlineOffset + each.outlineWidth,
                    ),
                ),
            ) + 1;

        const decoration: Decoration = {
            bounds,
            clip: filled ? frameBox : null,
            radii: look.radii,
            borderWidths: look.borderWidths,
            borderColor: look.borderColor,
            outlineWidth: look.outlineWidth,
            outlineOffset: look.outlineOffset,
            outlineColor: look.outlineColor,
            shadow: compileShadow(look.shadow),
            appBorderWidth: this.#appBorderWidth(look),
        };
        const key = JSON.stringify([decoration, reach]);
        if (key === this.#lastDecoration) return;
        this.#lastDecoration = key;
        logDebug(
            `Look of "${win.title}": classes=[${this.#classes}] margins=${look.margins} bounds=${bounds}`,
        );

        const [x1, y1, x2, y2] = bounds;
        const box = filled
            ? frameBox
            : [x1 - reach, y1 - reach, x2 + reach, y2 + reach];
        if (room.setBox(box)) this.#actor.invalidate_paint_volume();
        effect.update(decoration);
    }

    #fadeIn() {
        const effect = this.#effect;
        if (!effect) return;
        this.#stopRestore();
        // Respect GNOME's accessibility preference for animations.
        if (!St.Settings.get().enableAnimations) return;
        effect.setStrength(0);
        const timeline = new Clutter.Timeline({
            duration: RESTORE_MS,
            actor: this.#actor,
        });
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        timeline.connect('new-frame', () =>
            effect.setStrength(timeline.get_progress()),
        );
        timeline.connect('completed', () => this.#stopRestore());
        this.#restore = timeline;
        timeline.start();
    }

    #stopRestore() {
        if (!this.#restore) return;
        this.#restore.stop();
        this.#restore = null;
        this.#effect?.setStrength(1);
    }
}

/** Whether GTK draws the window over the whole of its frame. */
function isFilled(classes: string[]) {
    return classes.includes('maximized') || classes.includes('fullscreen');
}

/**
 * Whether the look draws anything. A filled window shows nothing past its
 * frame, so without a margin its shadow and outer outline do not count.
 */
function hasDecoration(look: WindowLook, filled: boolean) {
    const outside = !filled || look.margins.some(m => m > 0);
    return (
        look.radii.some(r => r > 0) ||
        look.margins.some(m => m > 0) ||
        look.borderWidths.some(w => w > 0) ||
        (look.outlineWidth > 0 &&
            look.outlineColor[3] > 0 &&
            (outside || look.outlineOffset < 0)) ||
        (outside && look.shadow.length > 0)
    );
}

/** The blacklist, or the whitelist when it is used as one. */
function isListed(win: Meta.Window) {
    if (win.wmClass === null) return false;
    return getPref('blacklist').includes(win.wmClass) === getPref('whitelist');
}
