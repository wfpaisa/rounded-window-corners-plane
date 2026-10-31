/**
 * @file Binds the corner rounding shader to the windows.
 *
 * The window is drawn into an offscreen buffer, kept while the window does
 * not repaint. The shader then clips that buffer to the window's shape and
 * draws its border, shadow and outline around it.
 *
 * Clutter.OffscreenEffect renders at ceil(scale), so at 150% a window is
 * drawn into a 2x buffer and shrunk back to 1.5x, which blurs text. This
 * effect renders at the monitor's real scale instead, laid out on the
 * screen's pixel grid, so every window pixel maps to one screen pixel.
 *
 * Adapted from lib/roundedCornersEffect.js of
 * https://github.com/ztrahmet/rounded-window-corners, with a fade for the
 * decoration and support for effects that deform the window.
 */

import type {ShadowSlot} from './shadow.js';

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
import {SHADOW_SLOTS} from './shadow.js';

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
    'clip',
    'radii',
    'fboMap',
    'texelScale',
    'smear',
    'borderRemovalWidth',
    'borderWidths',
    'borderColor',
    'outlineWidth',
    'outlineOffset',
    'outlineColor',
    'strength',
    'shadowStrength',
    ...Array.from({length: SHADOW_SLOTS}, (_, i) => [
        `shadowShape${i}`,
        `shadowColor${i}`,
    ]).flat(),
];

// Clip box coordinate that clips nothing.
const NO_CLIP = 1e6;

// Fade in of the shadow after a deformation ends.
const SHADOW_RETURN_MS = 150;

// Buffers grow in steps of this many physical pixels, so resizing a window
// does not allocate a new one on every frame.
const BUFFER_STEP = 64;

// A buffer for a scale nothing painted for this long, like the other
// monitor's after a window moved, is dropped on the next paint.
const TARGET_IDLE_US = 5_000_000;

// Freed buffers stay in video memory until their wrappers are collected.
const GC_DELAY_MS = 1000;
let gcSourceId = 0;

// Buffers allocated and not yet released, for the debug log.
let liveBuffers = 0;

function scheduleGc() {
    if (gcSourceId !== 0) return;
    gcSourceId = GLib.timeout_add(GLib.PRIORITY_LOW, GC_DELAY_MS, () => {
        gcSourceId = 0;
        System.gc();
        return GLib.SOURCE_REMOVE;
    });
}

/** Stop the pending collection, when the extension is disabled. */
export function cancelGc() {
    if (gcSourceId === 0) return;
    GLib.source_remove(gcSourceId);
    gcSourceId = 0;
    System.gc();
}

/** What the shader draws, in actor pixels. */
export type Decoration = {
    /** Window box without its CSS margin, as [x1, y1, x2, y2]. */
    bounds: number[];
    /** Box nothing is drawn past, or null for none. */
    clip: number[] | null;
    /** Clockwise from top-left. */
    radii: number[];
    /** Clockwise from the top. */
    borderWidths: number[];
    borderColor: number[];
    outlineWidth: number;
    outlineOffset: number;
    outlineColor: number[];
    shadow: ShadowSlot[];
    /** How deep the app's own border at the window's edge is replaced. */
    appBorderWidth: number;
};

/** The window drawn at one monitor scale. */
type Target = {
    scale: number;
    // Holds the buffer and the shader. Clutter's paint nodes copy the
    // pipeline they get, and the copies live until their JS wrappers are
    // collected: changing a pipeline that has copies makes Cogl copy it
    // again, shader program included, which piles up in video memory
    // while windows move. So this one only changes with the buffer, and
    // each paint gets its own copy with the uniforms set.
    pipeline: Cogl.Pipeline;
    // The copy last painted, and the uniforms and opacity it has.
    paintPipeline: Cogl.Pipeline | null;
    paintKey: string;
    // Empty and never changed, for the layer node that fills the buffer.
    layerPipeline: Cogl.Pipeline;
    locations: Map<string, number>;
    texture: Cogl.Texture2D | null;
    framebuffer: Cogl.Offscreen | null;
    // Allocated size of the buffer, in physical pixels.
    bufferWidth: number;
    bufferHeight: number;
    // Size of the window in the buffer, from its top-left corner.
    width: number;
    height: number;
    // Actor-local logical coordinates of the buffer's top-left pixel.
    originX: number;
    originY: number;
    // Fractional screen position, in physical pixels, of the actor origin,
    // or null when the window is not painted 1:1 onto a monitor.
    phase: [number, number] | null;
    // Whether the buffer holds the current window.
    rendered: boolean;
    // Monotonic time of the last paint, in microseconds.
    lastUsed: number;
};

/** Whether an effect is currently deforming its actor. */
function isDeforming(effect: Clutter.Effect) {
    return effect instanceof Clutter.DeformEffect && effect.enabled;
}

/** Size to allocate for a buffer that needs at least `size` pixels. */
function bufferSize(size: number) {
    return Math.ceil(size / BUFFER_STEP) * BUFFER_STEP;
}

/**
 * Scale of the monitor being painted.
 *
 * ClutterPaintContext.get_stage_view() is not introspectable, but Clutter
 * sizes each view's viewport as the stage size times the view scale. Match
 * that ratio against the monitor scales to drop the viewport rounding.
 *
 * @returns null in an offscreen paint, like a screenshot or a deformation.
 */
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

/** Scale of the window's monitor, for paints that are not onto a monitor. */
function monitorScale(actor: Clutter.Actor) {
    const monitor =
        actor instanceof Meta.WindowActor
            ? (actor.metaWindow?.get_monitor() ?? -1)
            : -1;
    if (monitor >= 0) return global.display.get_monitor_scale(monitor);
    return actor.get_resource_scale();
}

/** Scale to draw the window at: its monitor's, also when painted offscreen. */
function paintScale(
    actor: Clutter.Actor,
    stage: Clutter.Stage,
    ctx: Clutter.PaintContext,
) {
    return viewScale(stage, ctx) ?? monitorScale(actor);
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
 * Fractional part of a screen position, quantized so float noise does not
 * invalidate the buffer on every frame.
 */
function phase(position: number) {
    const fraction = Math.round((position - Math.floor(position)) * 256) / 256;
    return fraction >= 1 ? 0 : fraction;
}

/**
 * Room for the shadow and outline. It goes before the rounded corners effect,
 * which sizes its buffer from the paint volume, so that offscreen effects
 * after it, like the Shell's dimmer, have room for them too.
 */
export const ShadowRoomEffect = GObject.registerClass(
    {},
    class ShadowRoomEffect extends Clutter.Effect {
        #box = new Clutter.ActorBox();

        /**
         * @param box - [x1, y1, x2, y2], in actor pixels.
         * @returns Whether the room changed.
         */
        setBox([x1, y1, x2, y2]: number[]) {
            const box = Clutter.ActorBox.new(x1, y1, x2, y2);
            if (box.equal(this.#box)) return false;
            this.#box = box;
            return true;
        }

        /** The room with the window in it, in actor pixels. */
        size(actor: Clutter.Actor) {
            const box = this.#box;
            return [
                Math.max(box.x2, actor.width) - Math.min(box.x1, 0),
                Math.max(box.y2, actor.height) - Math.min(box.y1, 0),
            ];
        }

        // Clutter asks disabled effects too.
        vfunc_modify_paint_volume(volume: Clutter.PaintVolume) {
            if (this.enabled) volume.union_box(this.#box);
            return true;
        }
    },
);

type ShadowRoom = InstanceType<typeof ShadowRoomEffect>;

export const RoundedCornersEffect = GObject.registerClass(
    {},
    class RoundedCornersEffect extends Clutter.Effect {
        readonly #room: ShadowRoom;
        // One target per scale, so a window spanning two monitors is not
        // drawn again for each of them on every frame.
        readonly #targets = new Map<number, Target>();
        readonly #uniforms = new Map<string, number[]>();
        #decoration: Decoration | null = null;

        // Whether another effect deforms the window, as seen in the last paint.
        #deformed = false;
        #reorderPending = false;
        // Set while this effect is moved within its actor's effects.
        #reordering = false;
        #shadowReturn: Clutter.Timeline | null = null;
        #releaseSourceId = 0;

        constructor(room: ShadowRoom) {
            super();
            this.#room = room;
            this.setStrength(1);
            this.#setShadowStrength(1);
        }

        vfunc_set_actor(actor: Clutter.Actor | null) {
            // Moving the effect leaves the window as it was: reallocating the
            // buffers on every drag only fragments video memory.
            if (!this.#reordering) this.#clearTargets();
            if (this.#shadowReturn) {
                this.#stopShadowReturn();
                this.#setShadowStrength(this.#deformed ? 0 : 1);
            }
            super.vfunc_set_actor(actor);
        }

        vfunc_set_enabled(enabled: boolean) {
            this.#cancelRelease();
            // The window may have changed while the effect was off.
            if (enabled)
                for (const target of this.#targets.values())
                    target.rendered = false;
            // Keep the buffers a while, as across a drag or a maximize.
            else
                this.#releaseSourceId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    TARGET_IDLE_US / 1000,
                    () => {
                        this.#releaseSourceId = 0;
                        this.#clearTargets();
                        return GLib.SOURCE_REMOVE;
                    },
                );
            super.vfunc_set_enabled(enabled);
        }

        #cancelRelease() {
            if (this.#releaseSourceId === 0) return;
            GLib.source_remove(this.#releaseSourceId);
            this.#releaseSourceId = 0;
        }

        vfunc_paint(
            node: Clutter.PaintNode,
            ctx: Clutter.PaintContext,
            flags: Clutter.EffectPaintFlags,
        ) {
            const actor = this.actor;
            if (!actor) return;
            this.#checkDeformation(actor);
            // biome-ignore lint/suspicious/noBitwiseOperators: Bit flags.
            const bypass = flags & Clutter.EffectPaintFlags.BYPASS_EFFECT;
            // Clutter clears the dirty state after the first monitor paints
            // the window, so new contents invalidate every scale at once.
            // biome-ignore lint/suspicious/noBitwiseOperators: Bit flags.
            if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY)
                for (const target of this.#targets.values())
                    target.rendered = false;
            // Nothing to paint, and above all no buffer to allocate.
            // A deforming effect paints the window into its own buffer, which
            // Clutter allocates again whenever the deformation changes size.
            // Leave that framebuffer alone: its JS wrapper would keep every
            // one of those buffers in video memory until it is collected.
            if (!(bypass || this.#deformed) && this.#offView(actor, ctx))
                return;

            const target = bypass ? null : this.#prepare(actor, ctx);
            if (!target) {
                node.add_child(Clutter.ActorNode.new(actor, -1));
                return;
            }
            if (!target.rendered) {
                this.#renderActor(node, actor, target);
                target.rendered = true;
            }
            this.#paintTarget(node, actor, target);
        }

        /** Fade the whole decoration, from 0 (plain window) to 1. */
        setStrength(strength: number) {
            this.#uniforms.set('strength', [strength]);
            this.queue_repaint();
        }

        update(decoration: Decoration) {
            this.#decoration = decoration;
            this.#uniforms.set(
                'clip',
                decoration.clip ?? [-NO_CLIP, -NO_CLIP, NO_CLIP, NO_CLIP],
            );
            this.#uniforms.set('radii', decoration.radii);
            this.#uniforms.set('borderColor', decoration.borderColor);
            this.#uniforms.set('outlineOffset', [decoration.outlineOffset]);
            this.#uniforms.set('outlineColor', decoration.outlineColor);
            decoration.shadow.forEach(({shape, color}, i) => {
                this.#uniforms.set(`shadowShape${i}`, shape);
                this.#uniforms.set(`shadowColor${i}`, color);
            });
            this.queue_repaint();
        }

        /**
         * Whether the window, shadow included, lies outside the monitor
         * being painted. Windows are painted on every monitor, also on those
         * that do not show them, and each would need a buffer at its scale.
         */
        #offView(actor: Clutter.Actor, ctx: Clutter.PaintContext) {
            const stage = actor.get_stage() as Clutter.Stage | null;
            const volume = actor.get_paint_volume();
            if (!(stage && volume)) return false;
            const scale = viewScale(stage, ctx);
            if (scale === null) return false;
            const framebuffer = ctx.get_framebuffer();
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

        /** The target for the monitor being painted, with its buffer laid out. */
        #prepare(actor: Clutter.Actor, ctx: Clutter.PaintContext) {
            const stage = actor.get_stage() as Clutter.Stage | null;
            if (!stage) return null;
            const scale = this.#deformed
                ? monitorScale(actor)
                : paintScale(actor, stage, ctx);

            // While deformed, the paint volume includes the deformation, and
            // the shadow is hidden anyway.
            const volume = this.#deformed ? null : actor.get_paint_volume();
            let [x1, y1, x2, y2] = [0, 0, actor.width, actor.height];
            if (volume) {
                const origin = volume.get_origin();
                x1 = origin.x;
                y1 = origin.y;
                x2 = x1 + volume.get_width();
                y2 = y1 + volume.get_height();
            }
            if (x2 <= x1 || y2 <= y1) return null;

            // Mutter does not keep window actors on whole physical pixels: at
            // 150% an odd logical position lands on a half pixel, while the
            // app's surface inside still lands on whole ones. Lay the buffer
            // out on the screen's pixel grid, not the actor's, so the surface
            // is copied 1:1 into it and the buffer 1:1 onto the screen.
            const screen = this.#deformed
                ? null
                : screenOrigin(ctx.get_framebuffer(), scale);
            const [phaseX, phaseY] = screen ? screen.map(phase) : [0, 0];
            // One pixel of padding absorbs floating point errors, like
            // ClutterOffscreenEffect does.
            const left = Math.floor(x1 * scale + phaseX) - 1;
            const top = Math.floor(y1 * scale + phaseY) - 1;
            const width = Math.ceil(x2 * scale + phaseX) + 1 - left;
            const height = Math.ceil(y2 * scale + phaseY) + 1 - top;

            const now = GLib.get_monotonic_time();
            this.#dropIdleTargets(now, scale);
            const target =
                this.#targets.get(scale) ?? this.#createTarget(actor, scale);
            // A deformed window is drawn without its shadow: size the buffer
            // for the shadow anyway, so it is not allocated again after.
            const [roomWidth, roomHeight] = this.#deformed
                ? this.#room
                      .size(actor)
                      .map(size => Math.ceil(size * scale) + 3)
                : [0, 0];
            if (
                !this.#ensureBuffer(
                    actor,
                    target,
                    Math.max(width, roomWidth),
                    Math.max(height, roomHeight),
                )
            )
                return null;
            target.lastUsed = now;

            const originX = (left - phaseX) / scale;
            const originY = (top - phaseY) / scale;
            if (
                target.width !== width ||
                target.height !== height ||
                target.originX !== originX ||
                target.originY !== originY
            ) {
                target.width = width;
                target.height = height;
                target.originX = originX;
                target.originY = originY;
                target.rendered = false;
            }
            target.phase = screen ? [phaseX, phaseY] : null;

            this.#setupFramebuffer(stage, target);
            return target;
        }

        #createTarget(actor: Clutter.Actor, scale: number): Target {
            const context = actor
                .get_context()
                .get_backend()
                .get_cogl_context();
            const pipeline = Cogl.Pipeline.new(context);
            pipeline.add_snippet(snippet);
            // Texels line up with screen pixels, so linear filtering samples
            // texel centers exactly. It only blends when the window itself is
            // scaled, as in the overview or in animations.
            pipeline.set_layer_filters(
                0,
                Cogl.PipelineFilter.LINEAR,
                Cogl.PipelineFilter.LINEAR,
            );
            pipeline.set_layer_wrap_mode(
                0,
                Cogl.PipelineWrapMode.CLAMP_TO_EDGE,
            );
            const locations = new Map(
                UNIFORMS.map(name => [
                    name,
                    pipeline.get_uniform_location(name),
                ]),
            );
            const target: Target = {
                scale,
                pipeline,
                paintPipeline: null,
                paintKey: '',
                layerPipeline: Cogl.Pipeline.new(context),
                locations,
                texture: null,
                framebuffer: null,
                bufferWidth: 0,
                bufferHeight: 0,
                width: 0,
                height: 0,
                originX: Number.NaN,
                originY: Number.NaN,
                phase: null,
                rendered: false,
                lastUsed: 0,
            };
            this.#targets.set(scale, target);
            return target;
        }

        /**
         * Allocate the buffer again when it is too small, or much bigger
         * than needed, as after a window is restored from maximized.
         */
        #ensureBuffer(
            actor: Clutter.Actor,
            target: Target,
            width: number,
            height: number,
        ) {
            const allocWidth = bufferSize(width);
            const allocHeight = bufferSize(height);
            if (
                target.framebuffer &&
                target.bufferWidth >= width &&
                target.bufferHeight >= height &&
                target.bufferWidth * target.bufferHeight <=
                    2 * allocWidth * allocHeight
            )
                return true;

            this.#releaseBuffer(target);
            const context = actor
                .get_context()
                .get_backend()
                .get_cogl_context();
            // Cogl returns null for sizes it cannot hold, for example while
            // GNOME takes the snapshot for a maximize animation.
            const texture = Cogl.Texture2D.new_with_size(
                context,
                allocWidth,
                allocHeight,
            );
            if (!texture) return false;
            const framebuffer = Cogl.Offscreen.new_with_texture(texture);
            try {
                framebuffer.allocate();
            } catch {
                return false;
            }
            target.pipeline.set_layer_texture(0, texture);
            target.paintPipeline = null;
            target.texture = texture;
            target.framebuffer = framebuffer;
            target.bufferWidth = allocWidth;
            target.bufferHeight = allocHeight;
            target.rendered = false;
            liveBuffers++;
            const title =
                actor instanceof Meta.WindowActor
                    ? actor.metaWindow?.title
                    : actor.name;
            logDebug(
                `Buffer for "${title}": ${allocWidth}x${allocHeight} at scale ${target.scale}, ${liveBuffers} live`,
            );
            return true;
        }

        #releaseBuffer(target: Target) {
            if (!target.framebuffer) return;
            liveBuffers--;
            target.pipeline.remove_layer(0);
            target.paintPipeline = null;
            target.texture = null;
            target.framebuffer = null;
            target.bufferWidth = 0;
            target.bufferHeight = 0;
            target.rendered = false;
            scheduleGc();
        }

        /** A still window is not painted at all, so keep the current scale. */
        #dropIdleTargets(now: number, current: number) {
            for (const [scale, target] of this.#targets) {
                if (
                    scale === current ||
                    now - target.lastUsed <= TARGET_IDLE_US
                )
                    continue;
                this.#releaseBuffer(target);
                this.#targets.delete(scale);
            }
        }

        #clearTargets() {
            this.#cancelRelease();
            for (const target of this.#targets.values())
                this.#releaseBuffer(target);
            this.#targets.clear();
        }

        /** Same projection as ClutterOffscreenEffect, at the real scale. */
        #setupFramebuffer(stage: Clutter.Stage, target: Target) {
            const framebuffer = target.framebuffer as Cogl.Offscreen;
            const {scale, bufferWidth, bufferHeight} = target;
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
                (stageWidth * scale) / bufferWidth,
                (stageHeight * scale) / bufferHeight,
                1,
            );
            const modelview = transform.multiply(stage.get_transform());

            framebuffer.set_modelview_matrix(modelview);
            framebuffer.set_viewport(0, 0, bufferWidth, bufferHeight);
            framebuffer.set_projection_matrix(projection);
        }

        /**
         * Put the window edges and widths on whole physical pixels: at 150% a
         * 1px border is 1.5 pixels wide, a full pixel and a faint one, and
         * opposite sides would look different.
         */
        #updateUniforms(target: Target) {
            const {scale} = target;
            const uniforms = this.#uniforms;
            uniforms.set('fboMap', [
                target.originX,
                target.originY,
                target.bufferWidth / scale,
                target.bufferHeight / scale,
            ]);
            uniforms.set('texelScale', [scale]);
            // An unaligned or fractionally scaled paint blurs edges by a texel.
            uniforms.set('smear', [target.phase || scale % 1 === 0 ? 0 : 1]);

            const decoration = this.#decoration;
            if (decoration) {
                const tolerance = 0.001;
                const [phaseX, phaseY] = target.phase ?? [0, 0];
                const bounds = target.phase
                    ? decoration.bounds.map((value, i) => {
                          const offset = i % 2 === 0 ? phaseX : phaseY;
                          const edge = value * scale + offset;
                          const snapped =
                              i < 2
                                  ? Math.ceil(edge - tolerance)
                                  : Math.floor(edge + tolerance);
                          return (snapped - offset) / scale;
                      })
                    : decoration.bounds;
                // biome-ignore lint/correctness/useQwikValidLexicalScope: This is GJS, not a Qwik component.
                const snapWidth = (width: number) =>
                    width > 0
                        ? Math.max(1, Math.round(width * scale)) / scale
                        : 0;
                uniforms.set('bounds', bounds);
                uniforms.set(
                    'borderWidths',
                    decoration.borderWidths.map(snapWidth),
                );
                uniforms.set('outlineWidth', [
                    snapWidth(decoration.outlineWidth),
                ]);
                uniforms.set('borderRemovalWidth', [decoration.appBorderWidth]);
            }
        }

        /** A copy of the pipeline with the current uniforms and opacity. */
        #paintPipeline(actor: Clutter.Actor, target: Target) {
            this.#updateUniforms(target);
            const opacity = actor.get_paint_opacity() / 255;
            const key = JSON.stringify([...this.#uniforms, opacity]);
            if (target.paintPipeline && key === target.paintKey)
                return target.paintPipeline;

            const pipeline = target.pipeline.copy();
            for (const [name, value] of this.#uniforms) {
                const location = target.locations.get(name) ?? -1;
                if (location < 0) continue;
                pipeline.set_uniform_float(location, value.length, 1, value);
            }
            const color = new Cogl.Color();
            color.init_from_4f(opacity, opacity, opacity, opacity);
            pipeline.set_color(color);
            target.paintPipeline = pipeline;
            target.paintKey = key;
            return pipeline;
        }

        #renderActor(
            node: Clutter.PaintNode,
            actor: Clutter.Actor,
            target: Target,
        ) {
            // The layer node only redirects drawing, after clearing the
            // buffer; it gets no operations of its own, so its pipeline is
            // never used.
            const layer = Clutter.LayerNode.new_to_framebuffer(
                target.framebuffer as Cogl.Offscreen,
                target.layerPipeline,
            );
            layer.set_name('RoundedCornersEffect (offscreen)');
            node.add_child(layer);
            layer.add_child(Clutter.ActorNode.new(actor, 255));
        }

        #paintTarget(
            node: Clutter.PaintNode,
            actor: Clutter.Actor,
            target: Target,
        ) {
            const pipeline = this.#paintPipeline(actor, target);

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

            const pipelineNode = Clutter.PipelineNode.new(pipeline);
            pipelineNode.set_name('RoundedCornersEffect');
            transformNode.add_child(pipelineNode);
            pipelineNode.add_texture_rectangle(
                new Clutter.ActorBox({
                    x1: 0,
                    y1: 0,
                    x2: target.width,
                    y2: target.height,
                }),
                0,
                0,
                target.width / target.bufferWidth,
                target.height / target.bufferHeight,
            );
        }

        #setShadowStrength(strength: number) {
            this.#uniforms.set('shadowStrength', [strength]);
            this.queue_repaint();
        }

        /**
         * Find effects that deform the window, like the wobbly windows of
         * "Compiz windows effect" or the magic lamp.
         *
         * Clutter runs effects in the order they were added, and each one
         * wraps the ones added after it. Those effects are added after this
         * one, so this mask would cut the deformed window at its frame. Move
         * this effect after them instead, so they deform the rounded window.
         *
         * Their buffer is sized from the effects before them, so it has no
         * room for the shadow: it hides while they deform the window.
         */
        #checkDeformation(actor: Clutter.Actor) {
            let inside = false;
            let inner = false;
            let deformed = false;
            for (const effect of actor.get_effects()) {
                if (effect === this) inside = true;
                else if (isDeforming(effect)) {
                    deformed = true;
                    inner ||= inside;
                }
            }

            if (inner) this.#scheduleReorder(actor);
            if (deformed === this.#deformed) return;
            this.#deformed = deformed;
            this.#stopShadowReturn();
            if (deformed) this.#setShadowStrength(0);
            // The effect list and timelines cannot change while painting.
            else this.#later(actor, () => this.#startShadowReturn(actor));
        }

        #scheduleReorder(actor: Clutter.Actor) {
            if (this.#reorderPending) return;
            this.#reorderPending = true;
            this.#later(actor, () => {
                this.#reorderPending = false;
                this.#moveAfterDeformations(actor);
            });
        }

        /**
         * Move the room and this effect after the deforming effects, keeping
         * every other effect that was after them, like GNOME Shell's dimmer,
         * after them still.
         */
        #moveAfterDeformations(actor: Clutter.Actor) {
            const effects = actor.get_effects();
            const start = effects.indexOf(this.#room);
            if (start < 0) return;
            const moved = [
                this.#room,
                this,
                ...effects
                    .slice(start)
                    .filter(
                        effect =>
                            effect !== this.#room &&
                            effect !== this &&
                            !(effect instanceof Clutter.DeformEffect),
                    ),
            ];
            const names = moved.map(effect => effect.get_name());
            this.#reordering = true;
            try {
                for (const effect of moved) actor.remove_effect(effect);
                moved.forEach((effect, i) => {
                    const name = names[i];
                    if (name) actor.add_effect_with_name(name, effect);
                    else actor.add_effect(effect);
                });
            } finally {
                this.#reordering = false;
            }
        }

        #later(actor: Clutter.Actor, callback: () => void) {
            global.compositor
                .get_laters()
                .add(Meta.LaterType.BEFORE_REDRAW, () => {
                    if (this.actor === actor) callback();
                    return GLib.SOURCE_REMOVE;
                });
        }

        #startShadowReturn(actor: Clutter.Actor) {
            if (!(actor.mapped && St.Settings.get().enableAnimations)) {
                this.#setShadowStrength(1);
                return;
            }
            const timeline = new Clutter.Timeline({
                duration: SHADOW_RETURN_MS,
                actor,
            });
            timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            timeline.connect('new-frame', () =>
                this.#setShadowStrength(timeline.get_progress()),
            );
            timeline.connect('completed', () => {
                this.#shadowReturn = null;
                this.#setShadowStrength(1);
            });
            this.#shadowReturn = timeline;
            timeline.start();
        }

        #stopShadowReturn() {
            this.#shadowReturn?.stop();
            this.#shadowReturn = null;
        }
    },
);
