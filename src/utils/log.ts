/** @file Provides wrapper functions for printing out debug messages. */

import {getPref} from './settings.js';

/**
 * Log a message with a [Rounded Window Corners Plane] prefix, but only
 * when debug mode is enabled.
 */
export function logDebug(...args: unknown[]) {
    if (getPref('debug-mode')) {
        console.log(`[Rounded Window Corners Plane] ${args}`);
    }
}

/**
 * Log an error with a [Rounded Window Corners Plane] prefix.
 */
export function logError(...args: unknown[]) {
    console.error(`[Rounded Window Corners Plane] ${args}`);
}
