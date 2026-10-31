/** @file Binds the actual corner rounding shader to the windows. */

import type {Bounds, BoxShadow, RoundedCornerSettings} from '../utils/types.js';

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

// biome-ignore lint/correctness/noUndeclaredDependencies: GJS built-in module.
import System from 'system';
import {readShader} from '../utils/file.js';
import {logDebug} from '../utils/log.js';
import {getPref} from '../utils/settings.js';

const [declarations, code] = await readShader(
    import.meta.url,
    'shader/rounded_corners.frag',
);

// Shared by every window: Cogl caches the compiled program per snippet.
const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, '');
// Post, not replace: the generated code that samples the window texture
// into cogl_color_out must run first.
snippet.set_post(code);

const UNIFORMS = [
    'bounds',
    'effectStrength',
    'clipRadius',
    'borderWidth',
    'borderColor',
    'borderedAreaBounds',
    'borderedAreaClipRadius',
    'exponent',
    'pixelStep',
    'textureOrigin',
    'textureLimit',
    'shadowBounds',
    'shadowRadius',
    'shadowSigma',
    'shadowAlpha',
] as const;

type Uniform = (typeof UNIFORMS)[number];

/**
 * Offscreen buffer that holds one window at one monitor scale.
 *
 * Each window keeps its own buffer, so it is only rendered again when its
 * contents change. A single buffer shared by every window had to be refilled
 * for each window on every frame, which stalls the overview, where every
 * window and its workspace thumbnail clone are painted on each frame.
 *
 * One buffer per window without a limit used gigabytes of VRAM, though, so
 * buffers share a budget: past it, the window painted least recently hands
 * its buffer over and renders again when it is painted next. With more
 * windows on screen than fit in the budget, this falls back to refilling
 * shared buffers, which is slower but never grows the memory.
 */
type Buffer = {
    width: number;
    height: number;
    texture: Cogl.Texture2D;
    framebuffer: Cogl.Offscreen;
    // Framebuffer the buffer was last drawn onto.
    drawnTo: Cogl.Framebuffer | null;
    // Monotonic time of the last paint, in microseconds.
    lastUsed: number;
};

/** Pipeline of a window painted at one monitor scale. */
type Target = {
    scale: number;
    // Size of the window in the buffer, in physical pixels, from its top-left
    // corner.
    width: number;
    height: number;
    // Actor-local logical coordinates of the buffer's top-left pixel.
    originX: number;
    originY: number;
    // Fractional screen position, in physical pixels, of the actor origin.
    phaseX: number;
    phaseY: number;
    pipeline: Cogl.Pipeline;
    locations: Map<Uniform, number>;
    buffer: Buffer | null;
    // Whether the buffer holds the current window.
    rendered: boolean;
};

type Shadow = BoxShadow & {radius: number};

const NO_SHADOW: Shadow = {
    opacity: 0,
    spreadRadius: 0,
    blurOffset: 0,
    verticalOffset: 0,
    horizontalOffset: 0,
    radius: 0,
};

// Same as the transition of the shadow actor it replaced.
const SHADOW_TRANSITION_MS = 300;

// Fade in of the shadow after a deformation ends.
const SHADOW_RETURN_MS = 150;

// Buffers grow in steps of this many physical pixels, with one extra step of
// slack, so resizing a window does not allocate a new one on every frame.
const BUFFER_STEP = 64;

/** Size to allocate for a buffer that needs at least `size` pixels. */
function bufferSize(size: number) {
    return (Math.ceil(size / BUFFER_STEP) + 1) * BUFFER_STEP;
}

// Buffers that nothing was painted from for this long are dropped, for
// example those of windows on other workspaces after the overview closes, or
// of a scale after a screencast at that scale ends. A timer checks for them,
// since a static desktop paints nothing that would.
const BUFFER_IDLE_US = 10_000_000;
const IDLE_CHECK_SECONDS = 2;
let idleSourceId = 0;

// Every live target, to drop their idle buffers.
const targets = new Set<Target>();

// VRAM that all buffers together may use. A maximized window takes about
// 20 MiB on a 1080p monitor and 72 MiB on a 4K one.
const BUFFER_BUDGET_BYTES = 512 * 1024 * 1024;
let usedBytes = 0;

// Cogl gives each offscreen framebuffer a packed depth and stencil buffer
// next to its color texture, and GJS cannot ask it not to, so every pixel
// costs 4 bytes of color plus 4 of depth and stencil.
const BYTES_PER_PIXEL = 8;

function bufferBytes(buffer: Buffer) {
    return buffer.width * buffer.height * BYTES_PER_PIXEL;
}

// GJS frees a dropped texture only when its wrapper is garbage collected, and
// the collector only tracks JS memory, not the VRAM behind it. Collect once
// enough buffers were dropped, or they pile up by gigabytes.
const RELEASED_BYTES_BEFORE_GC = 64 * 1024 * 1024;
let releasedBytes = 0;
let gcSourceId = 0;

/** Collect dropped buffers soon, when the shell is idle. */
function scheduleGc() {
    if (gcSourceId !== 0) return;
    gcSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        gcSourceId = 0;
        releasedBytes = 0;
        System.gc();
        return GLib.SOURCE_REMOVE;
    });
}

/** Log what the buffers take, to compare with the VRAM of the shell. */
function logBuffers(reason: string) {
    let count = 0;
    for (const target of targets) if (target.buffer) count++;
    const mib = (usedBytes / 1024 / 1024).toFixed(0);
    logDebug(
        `Buffers after ${reason}: ${count} of ${targets.size}, ${mib} MiB`,
    );
}

function releaseBuffer(target: Target) {
    const buffer = target.buffer;
    if (!buffer) return;
    target.pipeline.remove_layer(0);
    target.buffer = null;
    target.rendered = false;
    usedBytes -= bufferBytes(buffer);
    releasedBytes += bufferBytes(buffer);
    if (releasedBytes >= RELEASED_BYTES_BEFORE_GC) scheduleGc();
}

/** Drop and collect every buffer, e.g. when the extension is disabled. */
export function releaseBuffers() {
    for (const target of targets) releaseBuffer(target);
    targets.clear();
    usedBytes = 0;
    if (idleSourceId !== 0) {
        GLib.source_remove(idleSourceId);
        idleSourceId = 0;
    }
    if (gcSourceId !== 0) {
        GLib.source_remove(gcSourceId);
        gcSourceId = 0;
    }
    if (releasedBytes === 0) return;
    releasedBytes = 0;
    System.gc();
}

function createBuffer(
    context: Cogl.Context,
    width: number,
    height: number,
): Buffer | null {
    const texture = Cogl.Texture2D.new_with_size(context, width, height);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    try {
        framebuffer.allocate();
    } catch (e) {
        logError(e as object, 'Failed to allocate rounded corners buffer');
        return null;
    }
    return {
        width,
        height,
        texture,
        framebuffer,
        drawnTo: null,
        lastUsed: 0,
    };
}

/**
 * Drop the buffers of targets that were not painted for a while, and collect
 * them right away instead of waiting for more to pile up.
 *
 * @returns Whether to keep checking, that is, whether buffers are left.
 */
function releaseIdleBuffers() {
    const now = GLib.get_monotonic_time();
    let released = false;
    let left = false;
    for (const target of targets) {
        if (!target.buffer) continue;
        if (now - target.buffer.lastUsed > BUFFER_IDLE_US) {
            releaseBuffer(target);
            released = true;
        } else {
            left = true;
        }
    }
    if (released) {
        scheduleGc();
        logBuffers('idle release');
    }
    return left;
}

function startIdleCheck() {
    if (idleSourceId !== 0) return;
    idleSourceId = GLib.timeout_add_seconds(
        GLib.PRIORITY_LOW,
        IDLE_CHECK_SECONDS,
        () => {
            if (releaseIdleBuffers()) return GLib.SOURCE_CONTINUE;
            idleSourceId = 0;
            return GLib.SOURCE_REMOVE;
        },
    );
}

/** The target, other than `except`, whose buffer was painted least recently. */
function leastRecentlyUsed(except: Target) {
    let oldest: Target | null = null;
    for (const target of targets) {
        if (target === except || !target.buffer) continue;
        // biome-ignore lint/style/noNonNullAssertion: Only targets with a buffer are kept.
        if (!oldest || target.buffer.lastUsed < oldest.buffer!.lastUsed)
            oldest = target;
    }
    return oldest;
}

/**
 * A buffer of at least `width` x `height` for the target, within the budget:
 * its own, a new one, or one taken from the least recently painted window.
 */
function acquireBuffer(
    context: Cogl.Context,
    target: Target,
    width: number,
    height: number,
) {
    // Never shrink, so a window that resizes back and forth keeps its buffer.
    let allocWidth = bufferSize(width);
    let allocHeight = bufferSize(height);
    const old = target.buffer;
    if (old) {
        allocWidth = Math.max(old.width, allocWidth);
        allocHeight = Math.max(old.height, allocHeight);
    }
    releaseBuffer(target);

    while (
        usedBytes + allocWidth * allocHeight * BYTES_PER_PIXEL >
        BUFFER_BUDGET_BYTES
    ) {
        const victim = leastRecentlyUsed(target);
        if (!victim) break;
        // biome-ignore lint/style/noNonNullAssertion: leastRecentlyUsed only returns targets with a buffer.
        const stolen = victim.buffer!;
        if (stolen.width >= width && stolen.height >= height) {
            // Hand it over instead of allocating: the budget is full.
            victim.pipeline.remove_layer(0);
            victim.buffer = null;
            victim.rendered = false;
            bindBuffer(target, stolen);
            return stolen;
        }
        releaseBuffer(victim);
    }

    const buffer = createBuffer(context, allocWidth, allocHeight);
    if (!buffer) return null;
    usedBytes += bufferBytes(buffer);
    startIdleCheck();
    bindBuffer(target, buffer);
    logBuffers('allocation');
    return buffer;
}

/** The target's buffer, grown to hold at least `width` x `height`. */
function ensureBuffer(
    context: Cogl.Context,
    target: Target,
    width: number,
    height: number,
) {
    const now = GLib.get_monotonic_time();
    let buffer = target.buffer;
    if (!buffer || buffer.width < width || buffer.height < height) {
        buffer = acquireBuffer(context, target, width, height);
        if (!buffer) return null;
    }
    buffer.lastUsed = now;
    return buffer;
}

function bindBuffer(target: Target, buffer: Buffer) {
    const {pipeline} = target;
    pipeline.set_layer_texture(0, buffer.texture);
    // Texels line up with screen pixels, so linear filtering samples texel
    // centers exactly. It only blends when the window itself is scaled, as
    // in the overview or in animations.
    pipeline.set_layer_filters(
        0,
        Cogl.PipelineFilter.LINEAR,
        Cogl.PipelineFilter.LINEAR,
    );
    pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    target.buffer = buffer;
    target.rendered = false;
}

/** Interpolate every value of a shadow. */
function mixShadows(from: Shadow, to: Shadow, progress: number): Shadow {
    const mixed = {...to};
    for (const key of Object.keys(to) as (keyof Shadow)[])
        mixed[key] = from[key] + (to[key] - from[key]) * progress;
    return mixed;
}

/** Logical pixels a shadow reaches past the box that casts it. */
function shadowExtent(shadow: Shadow) {
    if (shadow.opacity <= 0) return 0;
    // The Gaussian fades out within 3 sigma, that is 1.5 times the blur.
    return (
        Math.max(shadow.spreadRadius, 0) +
        1.5 * shadow.blurOffset +
        Math.max(
            Math.abs(shadow.horizontalOffset),
            Math.abs(shadow.verticalOffset),
        ) +
        1
    );
}

/**
 * Scale of the monitor being painted.
 *
 * ClutterPaintContext.get_stage_view() is not introspectable, but Clutter
 * sizes each view's viewport as the stage size times the view scale. Match
 * that ratio against the monitor scales to drop the viewport rounding.
 */
function paintScale(
    actor: Clutter.Actor,
    stage: Clutter.Stage,
    ctx: Clutter.PaintContext,
    deformed: boolean,
) {
    const scale = viewScale(stage, ctx);
    if (scale !== null) return scale;
    // A deforming effect paints the window into its own buffer at
    // ceil(scale), 2 at 150%. Rendering at that scale too took another
    // buffer per window, of about 113 MiB for a maximized one on a 4K
    // monitor, for each maximize or wobble. At the monitor's scale it shares
    // the buffer the window already has, and the animation is barely softer.
    if (deformed) {
        const own =
            actor instanceof Meta.WindowActor ? actor : actor.get_parent();
        const window = own instanceof Meta.WindowActor ? own.metaWindow : null;
        const monitor = window?.get_monitor() ?? -1;
        if (monitor >= 0) return global.display.get_monitor_scale(monitor);
    }
    // Other nested offscreen paints: same choice as ClutterOffscreenEffect.
    return actor.get_resource_scale();
}

/** Scale of the monitor being painted, or null in an offscreen paint. */
function viewScale(stage: Clutter.Stage, ctx: Clutter.PaintContext) {
    const framebuffer = ctx.get_framebuffer();
    const [stageWidth, stageHeight] = stage.get_size();
    const scaleX = framebuffer.get_viewport_width() / stageWidth;
    const scaleY = framebuffer.get_viewport_height() / stageHeight;
    if (Math.abs(scaleX - scaleY) >= 0.01) return null;
    const display = global.display;
    for (let i = 0; i < display.get_n_monitors(); i++) {
        const scale = display.get_monitor_scale(i);
        if (Math.abs(scale - scaleX) < 0.01) return scale;
    }
    return null;
}

/**
 * Screen position, in physical pixels, of the painted actor's local origin.
 *
 * Clutter has already pushed the actor's transform when effects paint, so
 * the framebuffer matrices map local coordinates to the screen, like in
 * Mutter's meta_actor_painting_untransformed(). Returns null when the actor
 * is scaled or rotated on screen.
 */
function screenOrigin(
    framebuffer: Cogl.Framebuffer,
    scale: number,
): [number, number] | null {
    const mvp = framebuffer
        .get_modelview_matrix()
        .multiply(framebuffer.get_projection_matrix());
    const viewportX = framebuffer.get_viewport_x();
    const viewportY = framebuffer.get_viewport_y();
    const viewportWidth = framebuffer.get_viewport_width();
    const viewportHeight = framebuffer.get_viewport_height();
    // biome-ignore lint/correctness/useQwikValidLexicalScope: This is GJS, not a Qwik component.
    const project = (x: number, y: number) => {
        const point = mvp.transform_vec4(new Graphene.Vec4().init(x, y, 0, 1));
        const w = point.get_w();
        return [
            ((point.get_x() / w + 1) / 2) * viewportWidth + viewportX,
            viewportHeight -
                ((point.get_y() / w + 1) / 2) * viewportHeight +
                viewportY,
        ];
    };
    // A 100px probe makes scale errors visible above float noise.
    const [x0, y0] = project(0, 0);
    const [x1, y1] = project(100, 0);
    const [x2, y2] = project(0, 100);
    const tolerance = 0.01;
    if (
        Math.abs(x1 - x0 - 100 * scale) > tolerance ||
        Math.abs(y2 - y0 - 100 * scale) > tolerance ||
        Math.abs(y1 - y0) > tolerance ||
        Math.abs(x2 - x0) > tolerance
    )
        return null;
    return [x0, y0];
}

/**
 * Whether the actor, shadow included, lies outside the view being painted.
 *
 * Windows with this effect are painted on every monitor, also on those that
 * do not show them, and each paint needs a buffer at that monitor's scale.
 * The effect only paints inside the paint volume, so skip the rest.
 */
function offView(actor: Clutter.Actor, ctx: Clutter.PaintContext) {
    const stage = actor.get_stage();
    const volume = actor.get_paint_volume();
    if (!(stage && volume)) return false;
    const framebuffer = ctx.get_framebuffer();
    // Only monitors: a screenshot of the window paints it offscreen.
    const scale = viewScale(stage as Clutter.Stage, ctx);
    if (scale === null) return false;
    const screen = screenOrigin(framebuffer, scale);
    if (!screen) return false;
    const origin = volume.get_origin();
    const left = screen[0] + origin.x * scale;
    const top = screen[1] + origin.y * scale;
    const right = left + volume.get_width() * scale;
    const bottom = top + volume.get_height() * scale;
    return (
        right <= 0 ||
        bottom <= 0 ||
        left >= framebuffer.get_width() ||
        top >= framebuffer.get_height()
    );
}

/** Whether an effect is currently deforming its actor. */
function isDeforming(effect: Clutter.Effect) {
    return effect instanceof Clutter.DeformEffect && effect.enabled;
}

/**
 * Fractional part of a screen position, quantized so float noise does not
 * invalidate the buffer on every frame.
 */
function phase(position: number) {
    const fraction = Math.round((position - Math.floor(position)) * 256) / 256;
    return fraction >= 1 ? 0 : fraction;
}

/**
 * Clutter.OffscreenEffect renders at ceil(scale), so at 150% a window is
 * drawn into a 2x buffer and shrunk back to 1.5x, which blurs or jags text.
 * This effect renders at the monitor's real scale and places the buffer on
 * whole physical pixels, so every window texel maps to one screen pixel.
 */
export const RoundedCornersEffect = GObject.registerClass(
    {},
    class Effect extends Clutter.Effect {
        // One target per scale, so a window spanning two monitors keeps its
        // uniforms for each of them.
        readonly #targets = new Map<number, Target>();
        readonly #uniforms = new Map<Uniform, number[]>();
        // Window frame and clip insets in logical pixels, snapped per scale
        // when painting.
        #edges: {
            frame: number[];
            padding: number[];
            borderWidth: number;
        } | null = null;
        // Last logged state per scale, in debug mode.
        readonly #lastState = new Map<number, string>();

        // Whether another effect deforms the window, as reported last.
        #deformed = false;
        #reorderPending = false;
        // Opacity of the shadow as it fades back in after a deformation.
        #shadowReturn = 1;
        #shadowReturnTimeline: Clutter.Timeline | null = null;

        // Box that casts the shadow: the window bounds with their padding.
        #shadowBox: number[] | null = null;
        // The shadow eases from one to the other when it changes.
        #shadowFrom = NO_SHADOW;
        #shadowTo = NO_SHADOW;
        #shadowProgress = 1;
        #shadowTimeline: Clutter.Timeline | null = null;

        constructor() {
            super();
            this.setStrength(1);
        }

        setStrength(strength: number) {
            this.#setUniform('effectStrength', [strength]);
            this.queue_repaint();
        }

        vfunc_set_actor(actor: Clutter.Actor | null) {
            this.#clearTargets();
            this.#finishShadowTransition();
            this.#stopShadowReturn();
            this.#shadowReturn = 1;
            super.vfunc_set_actor(actor);
        }

        /** The shadow reaches past the window. */
        vfunc_modify_paint_volume(volume: Clutter.PaintVolume) {
            const extent = this.#shadowReach();
            if (extent > 0) {
                const origin = volume.get_origin();
                volume.union_box(
                    new Clutter.ActorBox({
                        x1: origin.x - extent,
                        y1: origin.y - extent,
                        x2: origin.x + volume.get_width() + extent,
                        y2: origin.y + volume.get_height() + extent,
                    }),
                );
            }
            return true;
        }

        vfunc_set_enabled(enabled: boolean) {
            this.#clearTargets();
            super.vfunc_set_enabled(enabled);
        }

        vfunc_paint(
            node: Clutter.PaintNode,
            ctx: Clutter.PaintContext,
            flags: Clutter.EffectPaintFlags,
        ) {
            const actor = this.actor;
            // biome-ignore lint/suspicious/noBitwiseOperators: Bit flags.
            const bypass = flags & Clutter.EffectPaintFlags.BYPASS_EFFECT;
            // biome-ignore lint/suspicious/noBitwiseOperators: Bit flags.
            const dirty = flags & Clutter.EffectPaintFlags.ACTOR_DIRTY;
            // Clutter clears the dirty state after the first monitor paints
            // the window, so new contents invalidate every scale at once.
            if (dirty) this.#invalidate();
            const deform = actor ? this.#deformState(actor) : 'none';
            // Nothing to paint, and above all no buffer to allocate.
            if (actor && !bypass && deform === 'none' && offView(actor, ctx))
                return;
            // A deformation inside this effect would be cut by the mask:
            // paint the window plainly until the effects are reordered.
            const target =
                actor && !bypass && deform !== 'inner'
                    ? this.#ensureTarget(actor, ctx, deform === 'outer')
                    : null;
            if (!(actor && target)) {
                if (actor) node.add_child(Clutter.ActorNode.new(actor, -1));
                this.#invalidate();
                return;
            }

            // biome-ignore lint/style/noNonNullAssertion: #ensureTarget binds a buffer.
            const buffer = target.buffer!;
            if (!target.rendered) {
                // Send the queued draw of the old contents before they are
                // overwritten, in case they were drawn this frame.
                buffer.drawnTo?.flush();
                this.#renderActor(node, actor, target, buffer);
                target.rendered = true;
            }
            this.#paintTarget(node, actor, target, buffer);
            buffer.drawnTo = ctx.get_framebuffer();
        }

        /**
         * Find effects that deform the window, like the wobbly windows of
         * "Compiz windows effect" or the magic lamp.
         *
         * Clutter runs effects in the order they were added, and each one
         * wraps the ones added after it. Those effects are added after this
         * one, so this mask would cut the deformed window at its frame. Move
         * this effect after them instead, so they deform the rounded window.
         */
        #deformState(actor: Clutter.Actor): 'none' | 'outer' | 'inner' {
            let state: 'none' | 'outer' | 'inner' = 'none';
            // On X11 this effect is on the window's surface, while those
            // effects are on the window actor, so they always wrap this one.
            const parent = actor.get_parent();
            if (
                parent instanceof Meta.WindowActor &&
                parent.get_effects().some(isDeforming)
            )
                state = 'outer';
            let inside = false;
            for (const effect of actor.get_effects()) {
                if (effect === this) {
                    inside = true;
                } else if (isDeforming(effect)) {
                    state = inside ? 'inner' : 'outer';
                    if (inside) break;
                }
            }

            this.#updateDeformed(actor, state);
            return state;
        }

        #updateDeformed(
            actor: Clutter.Actor,
            state: 'none' | 'outer' | 'inner',
        ) {
            const deformed = state !== 'none';
            if (state !== 'inner' && deformed === this.#deformed) return;
            // The shadow is cut by the deformation, so it disappears at once,
            // but fades back in when the deformation ends.
            if (deformed !== this.#deformed) this.#shadowReturn = 0;
            this.#deformed = deformed;
            // The effect list and actors cannot change while painting.
            this.#scheduleUpdate(actor, state === 'inner');
        }

        #scheduleUpdate(actor: Clutter.Actor, reorder: boolean) {
            if (reorder) {
                if (this.#reorderPending) return;
                this.#reorderPending = true;
            }
            global.compositor
                .get_laters()
                .add(Meta.LaterType.BEFORE_REDRAW, () => {
                    if (reorder) {
                        this.#reorderPending = false;
                        if (this.actor === actor) {
                            const name = this.get_name();
                            actor.remove_effect(this);
                            actor.add_effect_with_name(name, this);
                        }
                    }
                    if (this.actor !== actor) return GLib.SOURCE_REMOVE;
                    this.#stopShadowReturn();
                    if (!this.#deformed) this.#startShadowReturn(actor);
                    // The shadow is hidden while deformed, so the paint
                    // volume changes.
                    actor.queue_redraw();
                    return GLib.SOURCE_REMOVE;
                });
        }

        /** Allocate or reuse the buffer for the monitor being painted. */
        #ensureTarget(
            actor: Clutter.Actor,
            ctx: Clutter.PaintContext,
            deformed: boolean,
        ) {
            const stage = actor.get_stage();
            if (!stage) return null;
            const scale = paintScale(
                actor,
                stage as Clutter.Stage,
                ctx,
                deformed,
            );

            let x1: number;
            let y1: number;
            let x2: number;
            let y2: number;
            // While painting, the paint volume includes the outer effects,
            // so a deformation would grow the buffer to its whole area.
            const volume = deformed ? null : actor.get_paint_volume();
            if (volume) {
                const origin = volume.get_origin();
                x1 = origin.x;
                y1 = origin.y;
                x2 = x1 + volume.get_width();
                y2 = y1 + volume.get_height();
            } else {
                [x1, y1, x2, y2] = [0, 0, actor.width, actor.height];
            }
            if (x2 <= x1 || y2 <= y1) return null;

            // Mutter does not keep window actors on whole physical pixels: at
            // 150% an odd logical position lands on a half pixel, while the
            // client surface inside still lands on whole ones. Lay the buffer
            // out on the screen's pixel grid, not the actor's, so the surface
            // is copied 1:1 into it and the buffer 1:1 onto the screen.
            // Clones and animations are scaled and interpolated anyway.
            const screen = screenOrigin(ctx.get_framebuffer(), scale);
            const phaseX = screen ? phase(screen[0]) : 0;
            const phaseY = screen ? phase(screen[1]) : 0;

            // One pixel of padding absorbs floating point errors, like
            // ClutterOffscreenEffect does.
            const left = Math.floor(x1 * scale + phaseX) - 1;
            const top = Math.floor(y1 * scale + phaseY) - 1;
            const width = Math.ceil(x2 * scale + phaseX) + 1 - left;
            const height = Math.ceil(y2 * scale + phaseY) + 1 - top;

            const context = actor
                .get_context()
                .get_backend()
                .get_cogl_context();
            const target =
                this.#targets.get(scale) ?? this.#createTarget(context, scale);
            const buffer = ensureBuffer(context, target, width, height);
            if (!buffer) return null;
            if (target.width !== width || target.height !== height) {
                target.width = width;
                target.height = height;
                target.rendered = false;
            }
            target.phaseX = phaseX;
            target.phaseY = phaseY;
            const originX = (left - phaseX) / scale;
            const originY = (top - phaseY) / scale;
            if (target.originX !== originX || target.originY !== originY) {
                target.originX = originX;
                target.originY = originY;
                target.rendered = false;
            }

            this.#logState(actor, ctx, target, buffer, screen);
            this.#setupFramebuffer(stage as Clutter.Stage, target, buffer);
            this.#applyUniforms(target, buffer);
            return target;
        }

        /** Log the buffer placement when it changes, in debug mode only. */
        #logState(
            actor: Clutter.Actor,
            ctx: Clutter.PaintContext,
            target: Target,
            buffer: Buffer,
            screen: [number, number] | null,
        ) {
            if (!getPref('debug-mode')) return;
            const framebuffer = ctx.get_framebuffer();
            // biome-ignore lint/correctness/useQwikValidLexicalScope: This is GJS, not a Qwik component.
            const round = (value: number) => value.toFixed(3);
            const state = [
                `scale=${round(target.scale)}`,
                `viewport=${framebuffer.get_viewport_width()}x${framebuffer.get_viewport_height()}`,
                `screen=${screen ? screen.map(round).join(',') : 'none'}`,
                `phase=${round(target.phaseX)},${round(target.phaseY)}`,
                `frame=${
                    screen && this.#edges
                        ? this.#edges.frame
                              .map((v, i) => v * target.scale + screen[i % 2])
                              .map(round)
                              .join(',')
                        : 'none'
                }`,
                `window=${target.width}x${target.height}`,
                `buffer=${buffer.width}x${buffer.height}`,
                `actor=${round(actor.width)}x${round(actor.height)}`,
            ].join(' ');
            if (state === this.#lastState.get(target.scale)) return;
            this.#lastState.set(target.scale, state);
            const owner = actor as Clutter.Actor & {
                metaWindow?: {title: string | null};
            };
            const parent = actor.get_parent() as typeof owner | null;
            const title = owner.metaWindow?.title ?? parent?.metaWindow?.title;
            logDebug(`Rounded corners buffer for "${title}": ${state}`);
        }

        #createTarget(context: Cogl.Context, scale: number): Target {
            const pipeline = Cogl.Pipeline.new(context);
            pipeline.add_snippet(snippet);

            const locations = new Map<Uniform, number>();
            for (const name of UNIFORMS) {
                locations.set(name, pipeline.get_uniform_location(name));
            }

            const target: Target = {
                scale,
                width: 0,
                height: 0,
                originX: Number.NaN,
                originY: Number.NaN,
                phaseX: 0,
                phaseY: 0,
                pipeline,
                locations,
                buffer: null,
                rendered: false,
            };
            this.#targets.set(scale, target);
            targets.add(target);
            return target;
        }

        /** Same projection as ClutterOffscreenEffect, at the real scale. */
        #setupFramebuffer(
            stage: Clutter.Stage,
            target: Target,
            buffer: Buffer,
        ) {
            const {framebuffer, width, height} = buffer;
            const {scale} = target;
            const [stageWidth, stageHeight] = stage.get_size();
            // biome-ignore lint/style/noNonNullAssertion: The stage always has a perspective.
            const perspective = stage.get_perspective()!;
            const projection = new Graphene.Matrix();
            projection.init_perspective(
                perspective.fovy,
                perspective.aspect,
                perspective.z_near,
                perspective.z_far,
            );

            // Drop the actor's own transform: the buffer holds the window in
            // local coordinates and is placed back with the paint modelview.
            const transform = new Graphene.Matrix();
            transform.init_translate(
                new Graphene.Point3D({
                    x: -target.originX,
                    y: -target.originY,
                    z: 0,
                }),
            );
            transform.scale(
                (stageWidth * scale) / width,
                (stageHeight * scale) / height,
                1,
            );
            const modelview = transform.multiply(stage.get_transform());

            framebuffer.set_modelview_matrix(modelview);
            framebuffer.set_viewport(0, 0, width, height);
            framebuffer.set_projection_matrix(projection);
        }

        #renderActor(
            node: Clutter.PaintNode,
            actor: Clutter.Actor,
            target: Target,
            buffer: Buffer,
        ) {
            // The layer node only redirects drawing, after clearing the
            // buffer; it gets no operations of its own, so its pipeline is
            // never used.
            const layer = Clutter.LayerNode.new_to_framebuffer(
                buffer.framebuffer,
                target.pipeline,
            );
            layer.set_name('RoundedCornersEffect (offscreen)');
            node.add_child(layer);
            layer.add_child(Clutter.ActorNode.new(actor, 255));
        }

        #paintTarget(
            node: Clutter.PaintNode,
            actor: Clutter.Actor,
            target: Target,
            buffer: Buffer,
        ) {
            const opacity = actor.get_paint_opacity() / 255;
            const color = new Cogl.Color();
            color.init_from_4f(opacity, opacity, opacity, opacity);
            target.pipeline.set_color(color);

            // Back to actor-local logical coordinates.
            const transform = new Graphene.Matrix();
            transform.init_scale(1 / target.scale, 1 / target.scale, 1);
            transform.translate(
                new Graphene.Point3D({
                    x: target.originX,
                    y: target.originY,
                    z: 0,
                }),
            );
            const transformNode = Clutter.TransformNode.new(transform);
            transformNode.set_name('RoundedCornersEffect (transform)');
            node.add_child(transformNode);

            const pipelineNode = Clutter.PipelineNode.new(target.pipeline);
            pipelineNode.set_name('RoundedCornersEffect');
            transformNode.add_child(pipelineNode);
            // Reach past the window by whole pixels to draw the shadow.
            const margin = Math.ceil(this.#shadowReach() * target.scale);
            const x1 = -margin;
            const y1 = -margin;
            const x2 = target.width + margin;
            const y2 = target.height + margin;
            pipelineNode.add_texture_rectangle(
                new Clutter.ActorBox({x1, y1, x2, y2}),
                x1 / buffer.width,
                y1 / buffer.height,
                x2 / buffer.width,
                y2 / buffer.height,
            );
        }

        #applyUniforms(target: Target, buffer: Buffer) {
            // Convert texture coordinates to actor-local logical pixels.
            this.#uniforms.set('pixelStep', [
                target.scale / buffer.width,
                target.scale / buffer.height,
            ]);
            this.#uniforms.set('textureOrigin', [
                target.originX,
                target.originY,
            ]);
            this.#uniforms.set('textureLimit', [
                target.width / buffer.width,
                target.height / buffer.height,
            ]);
            this.#setShadowUniforms();
            const uniforms = new Map(this.#uniforms);
            this.#snapEdges(uniforms, target);
            for (const [name, value] of uniforms) {
                const location = target.locations.get(name) ?? -1;
                if (location < 0) continue;
                target.pipeline.set_uniform_float(
                    location,
                    value.length,
                    1,
                    value,
                );
            }
        }

        /**
         * Put the window edges and the border on whole physical pixels.
         *
         * At 150% a 1px border is 1.5 pixels wide, so depending on the parity
         * of each edge it renders as a full pixel plus a faint one, or the
         * other way round, and opposite sides look different. The clip
         * padding has the same problem: 1px of padding is 1.5 pixels, which
         * cuts a window pixel in half. Clip whole pixels on the screen's grid
         * instead, so every side and every position looks the same.
         */
        #snapEdges(uniforms: Map<Uniform, number[]>, target: Target) {
            const edges = this.#edges;
            if (!edges) return;
            const {scale, phaseX, phaseY} = target;
            const bounds = edges.frame.map((value, i) => {
                const phase = i % 2 === 0 ? phaseX : phaseY;
                // Round the frame edge and the padding inwards, so the clip
                // always hides at least the padding and never shows a window
                // pixel cut in half. Rounding to nearest hides 1 pixel on one
                // side and 2 on the other, swapping sides as the window moves.
                const tolerance = 0.001;
                const inset = Math.ceil(edges.padding[i] * scale - tolerance);
                const edge = value * scale + phase;
                if (i < 2)
                    return (
                        (Math.ceil(edge - tolerance) + inset - phase) / scale
                    );
                return (Math.floor(edge + tolerance) - inset - phase) / scale;
            });
            let borderWidth = edges.borderWidth;
            if (Math.abs(borderWidth) > 0.9) {
                const pixels = Math.max(
                    1,
                    Math.round(Math.abs(borderWidth) * scale),
                );
                borderWidth = (Math.sign(borderWidth) * pixels) / scale;
            }
            uniforms.set('bounds', bounds);
            uniforms.set('borderedAreaBounds', [
                bounds[0] + borderWidth,
                bounds[1] + borderWidth,
                bounds[2] - borderWidth,
                bounds[3] - borderWidth,
            ]);
        }

        /** Render the window again before painting it next. */
        #invalidate() {
            for (const target of this.#targets.values())
                target.rendered = false;
        }

        #clearTargets() {
            for (const target of this.#targets.values()) {
                releaseBuffer(target);
                targets.delete(target);
            }
            this.#targets.clear();
        }

        /** Logical pixels the shadow reaches past the window, if shown. */
        #shadowReach() {
            if (!this.#shadowBox || this.#deformed) return 0;
            // Cover both ends of a transition.
            return Math.max(
                shadowExtent(this.#shadowFrom),
                shadowExtent(this.#shadowTo),
            );
        }

        #setShadowUniforms() {
            const shadow = mixShadows(
                this.#shadowFrom,
                this.#shadowTo,
                this.#shadowProgress,
            );
            const box = this.#shadowBox;
            // The deforming effect is sized for the window alone and would
            // cut the shadow.
            if (!box || this.#deformed) {
                this.#uniforms.set('shadowAlpha', [0]);
                return;
            }
            const spread = shadow.spreadRadius;
            const dx = shadow.horizontalOffset;
            const dy = shadow.verticalOffset;
            this.#uniforms.set('shadowBounds', [
                box[0] - spread + dx,
                box[1] - spread + dy,
                box[2] + spread + dx,
                box[3] + spread + dy,
            ]);
            this.#uniforms.set('shadowRadius', [shadow.radius]);
            // CSS defines the blur radius as twice the standard deviation.
            this.#uniforms.set('shadowSigma', [shadow.blurOffset / 2]);
            this.#uniforms.set('shadowAlpha', [
                (shadow.opacity / 100) * this.#shadowReturn,
            ]);
        }

        /**
         * Set the shadow drawn around the window, easing into it like the
         * CSS transition of the shadow actor this replaced.
         *
         * @param shadow - Shadow settings, with an opacity of 0 to hide it
         * @param radius - Corner radius of the box that casts the shadow
         */
        setShadow(shadow: BoxShadow, radius: number) {
            const next = {...shadow, radius};
            const keys = Object.keys(next) as (keyof Shadow)[];
            if (keys.every(key => next[key] === this.#shadowTo[key])) return;

            const from = mixShadows(
                this.#shadowFrom,
                this.#shadowTo,
                this.#shadowProgress,
            );
            this.#finishShadowTransition();
            this.#shadowFrom = from;
            this.#shadowTo = next;

            const actor = this.actor;
            if (actor?.mapped && St.Settings.get().enableAnimations) {
                this.#shadowProgress = 0;
                const timeline = new Clutter.Timeline({
                    duration: SHADOW_TRANSITION_MS,
                    actor,
                });
                timeline.connect('new-frame', () => {
                    this.#shadowProgress = timeline.get_progress();
                    this.queue_repaint();
                });
                timeline.connect('completed', () => {
                    this.#finishShadowTransition();
                    // Shrink the paint volume to the final shadow.
                    actor.queue_redraw();
                });
                this.#shadowTimeline = timeline;
                timeline.start();
            }
            // The paint volume depends on the shadow.
            actor?.queue_redraw();
        }

        #startShadowReturn(actor: Clutter.Actor) {
            if (!(actor.mapped && St.Settings.get().enableAnimations)) {
                this.#shadowReturn = 1;
                return;
            }
            const timeline = new Clutter.Timeline({
                duration: SHADOW_RETURN_MS,
                actor,
            });
            timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            timeline.connect('new-frame', () => {
                this.#shadowReturn = timeline.get_progress();
                this.queue_repaint();
            });
            timeline.connect('completed', () => {
                this.#shadowReturnTimeline = null;
                this.#shadowReturn = 1;
                this.queue_repaint();
            });
            this.#shadowReturnTimeline = timeline;
            timeline.start();
        }

        #stopShadowReturn() {
            this.#shadowReturnTimeline?.stop();
            this.#shadowReturnTimeline = null;
        }

        #finishShadowTransition() {
            this.#shadowTimeline?.stop();
            this.#shadowTimeline = null;
            this.#shadowFrom = this.#shadowTo;
            this.#shadowProgress = 1;
        }

        /**
         * Update uniforms of the shader.
         * For more information, see the comments in the shader file.
         *
         * @param config - Rounded corners configuration
         * @param windowBounds - Bounds of the window without padding
         * @param focused - Whether the window appears focused
         */
        updateUniforms(
            config: RoundedCornerSettings,
            windowBounds: Bounds,
            focused: boolean,
        ) {
            const borderWidth = getPref('border-width');
            const borderColor = focused
                ? config.borderColor
                : config.unfocusedBorderColor;

            const outerRadius = config.borderRadius;
            const {padding, smoothing} = config;

            const bounds = [
                windowBounds.x1 + padding.left,
                windowBounds.y1 + padding.top,
                windowBounds.x2 - padding.right,
                windowBounds.y2 - padding.bottom,
            ];

            const borderedAreaBounds = [
                bounds[0] + borderWidth,
                bounds[1] + borderWidth,
                bounds[2] - borderWidth,
                bounds[3] - borderWidth,
            ];

            let borderedAreaRadius = outerRadius - borderWidth;
            if (borderedAreaRadius < 0.001) {
                borderedAreaRadius = 0.0;
            }

            // This is needed for squircle corners
            let exponent = smoothing * 10 + 2;
            let radius = outerRadius * 0.5 * exponent;
            const maxRadius = Math.min(
                (bounds[2] - bounds[0]) / 2,
                (bounds[3] - bounds[1]) / 2,
            );
            if (radius > maxRadius) {
                exponent *= maxRadius / radius;
                radius = maxRadius;
            }
            borderedAreaRadius *= outerRadius > 0 ? radius / outerRadius : 0;

            this.#shadowBox = bounds;
            this.#edges = {
                frame: [
                    windowBounds.x1,
                    windowBounds.y1,
                    windowBounds.x2,
                    windowBounds.y2,
                ],
                padding: [
                    padding.left,
                    padding.top,
                    padding.right,
                    padding.bottom,
                ],
                borderWidth,
            };
            this.#setUniform('bounds', bounds);
            this.#setUniform('clipRadius', [radius]);
            this.#setUniform('borderWidth', [borderWidth]);
            this.#setUniform('borderColor', borderColor);
            this.#setUniform('borderedAreaBounds', borderedAreaBounds);
            this.#setUniform('borderedAreaClipRadius', [borderedAreaRadius]);
            this.#setUniform('exponent', [exponent]);
            this.queue_repaint();
        }

        /** Store a uniform; it is uploaded to each buffer when painting. */
        #setUniform(name: Uniform, value: number[]) {
            this.#uniforms.set(name, value);
        }
    },
);
