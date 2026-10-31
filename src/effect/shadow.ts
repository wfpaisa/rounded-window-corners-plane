/**
 * @file Turns box-shadow layers into the shader's uniforms.
 *
 * From lib/shadowProfile.js of https://github.com/ztrahmet/rounded-window-corners.
 */

import type {ShadowLayer} from '../style/vendor/css_parse.js';

/** Layers the shader draws. rounded_corners.frag must match. */
export const SHADOW_SLOTS = 6;
const EXTENT_SIGMAS = 3;

export type ShadowSlot = {shape: number[]; color: number[]};

const EMPTY_SLOT: ShadowSlot = {shape: [0, 0, 0, 0], color: [0, 0, 0, 0]};

/** As in GTK, a layer blurred less than this is drawn as a plain shape. */
function sigmaOf(layer: ShadowLayer) {
    return layer.blur < 0.01 ? 0 : layer.blur / 2;
}

/** How far the shadow reaches past the window box, in logical pixels. */
export function shadowExtent(layers: ShadowLayer[]) {
    return Math.max(
        0,
        ...layers.map(
            layer =>
                layer.spread +
                EXTENT_SIGMAS * sigmaOf(layer) +
                Math.hypot(layer.dx, layer.dy),
        ),
    );
}

/**
 * Fill the shader's slots with the layers, in the order GTK draws them. With
 * more layers than slots, the faintest are left out.
 */
export function compileShadow(layers: ShadowLayer[]): ShadowSlot[] {
    const kept = new Set(
        [...layers]
            .sort((a, b) => b.color[3] - a.color[3])
            .slice(0, SHADOW_SLOTS),
    );
    const slots = layers
        .filter(layer => kept.has(layer))
        .map(layer => ({
            shape: [layer.dx, layer.dy, layer.spread, sigmaOf(layer)],
            color: layer.color,
        }));
    return Array.from({length: SHADOW_SLOTS}, (_, i) => slots[i] ?? EMPTY_SLOT);
}
