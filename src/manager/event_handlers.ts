/**
 * @file Contains the implementation of handlers for various events that need
 * to be processed by the extension. Those handlers are bound to event signals
 * in effect_manager.ts.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';
import {logDebug} from '../utils/log.js';
import {getPref} from '../utils/settings.js';
import {hasMetaWindow, type RoundedWindowActor} from '../utils/types.js';
import {
    computeBounds,
    computeWindowContentsOffset,
    getRoundedCornersCfg,
    getRoundedCornersEffect,
    getShadowCfg,
    isChromium,
    shouldEnableEffect,
    unwrapActor,
} from './utils.js';

/**
 * Per-actor queue lock to run event handlers one after another and avoid
 * needlessly refreshing the effect a lot of times.
 */
function withActorLock(
    actor: RoundedWindowActor,
    fn: () => Promise<void>,
): Promise<void> {
    const prev: Promise<void> | undefined = actor.rwcLock;
    const next = prev ? prev.then(fn, fn) : fn();
    actor.rwcLock = next;
    return next;
}

export function onAddEffect(actor: RoundedWindowActor) {
    return withActorLock(actor, async () => {
        logDebug(`Adding effect to ${actor?.metaWindow.wmClass}`);
        const win = actor.metaWindow;

        // Skip windows that already have the effect to prevent a memory leak
        const shouldHaveEffect = await shouldEnableEffect(win);
        const effect = getRoundedCornersEffect(actor);
        const hasEffect = effect && actor.rwcCustomData;

        if (!shouldHaveEffect || hasEffect) {
            logDebug(`Skipping ${win.wmClass}`);
            return;
        }

        createEffect(actor);
    });
}

/**
 * Create the effect on an actor.
 *
 * @param actor - The window actor to create the effect on.
 */
function createEffect(actor: RoundedWindowActor) {
    const effect = new RoundedCornersEffect();
    unwrapActor(actor)?.add_effect_with_name(ROUNDED_CORNERS_EFFECT, effect);

    actor.rwcCustomData = {unminimizedTimeoutId: 0};

    // Make sure the effect is applied correctly.
    updateEffect(actor);
}

export function onRemoveEffect(actor: RoundedWindowActor) {
    stopRestoreTransition(actor);
    pendingRestore.delete(actor);
    const name = ROUNDED_CORNERS_EFFECT;
    unwrapActor(actor)?.remove_effect_by_name(name);

    // Remove all timeout handler
    const timeoutId = actor.rwcCustomData?.unminimizedTimeoutId;
    if (timeoutId) {
        GLib.source_remove(timeoutId);
    }
    delete actor.rwcCustomData;
}

// A grab can begin on a title-bar click, before the window actually moves.
let pendingGrabs = new WeakMap<
    RoundedWindowActor,
    {x: number; y: number; width: number; height: number}
>();
// Track real motion independently of the setting so toggling it mid-drag is safe.
let movingWindows = new WeakSet<RoundedWindowActor>();
let pendingRestore = new WeakSet<RoundedWindowActor>();
const restoreTransitions = new Map<RoundedWindowActor, Clutter.Timeline>();

export function clearMovingWindows() {
    for (const actor of restoreTransitions.keys()) stopRestoreTransition(actor);
    movingWindows = new WeakSet();
    pendingRestore = new WeakSet();
    pendingGrabs = new WeakMap();
}

export function onMoveBegin(actor: RoundedWindowActor) {
    const {x, y, width, height} = actor.metaWindow.get_frame_rect();
    pendingGrabs.set(actor, {x, y, width, height});
}

export function onInteractionGeometryChanged(actor: RoundedWindowActor) {
    const initial = pendingGrabs.get(actor);
    if (!initial || movingWindows.has(actor)) return;
    const rect = actor.metaWindow.get_frame_rect();
    // Mutter can emit geometry notifications without changing the frame.
    if (
        rect.x === initial.x &&
        rect.y === initial.y &&
        rect.width === initial.width &&
        rect.height === initial.height
    )
        return;
    movingWindows.add(actor);
    if (getPref('suspend-during-interaction')) suspendMovingEffect(actor);
}

export function onMoveEnd(actor: RoundedWindowActor) {
    pendingGrabs.delete(actor);
    if (!movingWindows.delete(actor)) return;
    if (getPref('suspend-during-interaction')) pendingRestore.add(actor);
    return refreshRoundedCorners(actor);
}

export function onInteractionSettingChanged() {
    for (const actor of global.get_window_actors()) {
        if (!hasMetaWindow(actor)) continue;
        stopRestoreTransition(actor);
        pendingRestore.delete(actor);
        getRoundedCornersEffect(actor)?.setStrength(1);
        refreshRoundedCorners(actor);
    }
}

function stopRestoreTransition(actor: RoundedWindowActor) {
    const timeline = restoreTransitions.get(actor);
    if (!timeline) return;
    timeline.stop();
    timeline.disconnectObject(actor);
    restoreTransitions.delete(actor);
}

function suspendMovingEffect(actor: RoundedWindowActor) {
    stopRestoreTransition(actor);
    pendingRestore.delete(actor);
    const effect = getRoundedCornersEffect(actor);
    if (effect) {
        effect.setStrength(0);
        effect.enabled = false;
    }
}

function restoreWithTransition(actor: RoundedWindowActor) {
    const effect = getRoundedCornersEffect(actor);
    if (!effect) return;
    stopRestoreTransition(actor);
    // The strength fades the shadow too.
    // biome-ignore lint/correctness/useQwikValidLexicalScope: This is a GJS timeline callback, not a Qwik component.
    const updateProgress = (progress: number) => effect.setStrength(progress);
    updateProgress(0);
    // Respect GNOME's accessibility preference for animations.
    if (!St.Settings.get().enableAnimations) {
        updateProgress(1);
        return;
    }
    const timeline = new Clutter.Timeline({duration: 180, actor});
    timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
    timeline.connectObject(
        'new-frame',
        () => updateProgress(timeline.get_progress()),
        'completed',
        () => {
            updateProgress(1);
            stopRestoreTransition(actor);
        },
        actor,
    );
    restoreTransitions.set(actor, timeline);
    timeline.start();
}

export async function onUnminimize(actor: RoundedWindowActor) {
    // Chromium has a bug where windows are sometimes unminimized to the
    // wrong location, and then move to the correct position shortly after.
    // This forces an effect refresh after the window has already moved to the
    // proper position; otherwise, the effect bounds would use the wrong one and
    // cut off a part of the window.
    //
    // See https://github.com/flexagoon/rounded-window-corners/issues/124
    if (
        (await isChromium(actor.metaWindow)) &&
        actor.rwcCustomData !== undefined
    ) {
        const oldTimeout = actor.rwcCustomData.unminimizedTimeoutId;
        if (oldTimeout !== 0) GLib.source_remove(oldTimeout);
        actor.rwcCustomData.unminimizedTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250,
            () => {
                refreshRoundedCorners(actor);
                return GLib.SOURCE_REMOVE;
            },
        );
    }
}

export const onSizeChanged = refreshRoundedCorners;

export function onFocusChanged(actor: RoundedWindowActor) {
    refreshShadow(actor);
    // The border color depends on focus.
    updateEffect(actor);
}

export const onSettingsChanged = refreshAllRoundedCorners;

/**
 * Refresh the shadow of a window.
 *
 * @param actor - The window actor to refresh the shadow for.
 */
function refreshShadow(actor: RoundedWindowActor) {
    const {shadow, radius} = getShadowCfg(actor.metaWindow);
    getRoundedCornersEffect(actor)?.setShadow(shadow, radius);
}

/**
 * Refresh rounded corners state and settings for a window.
 *
 * @param actor - The window actor to refresh the rounded corners settings for.
 */
function refreshRoundedCorners(actor: RoundedWindowActor) {
    return withActorLock(actor, async () => {
        const win = actor.metaWindow;

        const shouldHaveEffect = await shouldEnableEffect(win);

        const windowInfo = (actor as RoundedWindowActor).rwcCustomData;
        const effect = getRoundedCornersEffect(actor);

        const hasEffect = effect && windowInfo;

        // onAddEffect already skips windows that shouldn't have rounded corners.
        // This if statement is just for code readability to match the check for
        // onRemoveEffect below.
        if (!hasEffect && shouldHaveEffect) {
            createEffect(actor);

            // createEffect already calls updateEffect at the end,
            // so return here to avoid running the update twice.
            return;
        }

        if (hasEffect && !shouldHaveEffect) {
            onRemoveEffect(actor);
            return;
        }

        // Don'd do anything when the window doesn't have the effect and shouldn't have it.
        if (!hasEffect) return;

        updateEffect(actor);
    });
}

/**
 * Update effect uniforms and constraints for a window.
 *
 * @param actor - The window actor to update the effect for.
 */
function updateEffect(actor: RoundedWindowActor) {
    const win = actor.metaWindow;
    const windowInfo = actor.rwcCustomData;
    if (!windowInfo) return;

    const effect = getRoundedCornersEffect(actor);
    if (!effect) return;

    // Resizing, focus changes and pending async refreshes must not restore
    // the effect before the move ends.
    if (movingWindows.has(actor) && getPref('suspend-during-interaction')) {
        suspendMovingEffect(actor);
        return;
    }

    if (!effect.enabled) {
        effect.enabled = true;
    }

    const cfg = getRoundedCornersCfg(win);
    const windowContentOffset = computeWindowContentsOffset(win);
    effect.updateUniforms(
        cfg,
        computeBounds(actor, windowContentOffset),
        win.appears_focused,
    );
    refreshShadow(actor);
    if (pendingRestore.delete(actor)) restoreWithTransition(actor);
}

/** Refresh rounded corners settings for all windows. */
function refreshAllRoundedCorners() {
    for (const actor of global.get_window_actors()) {
        if (hasMetaWindow(actor)) {
            refreshRoundedCorners(actor);
        }
    }
}
