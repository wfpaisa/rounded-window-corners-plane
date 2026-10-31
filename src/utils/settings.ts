/**
 * @file Provides wrappers around the GSettings object that add type safety and
 * automatically convert values between JS types and GLib Variant types that
 * are used for storing GSettings.
 */

import type Gio from 'gi://Gio';
import type GObject from 'gi://GObject';

import GLib from 'gi://GLib';

/** Mapping of schema keys to the JS representation of their type. */
type Schema = {
    'settings-version': number;
    blacklist: string[];
    whitelist: boolean;
    'suspend-during-interaction': boolean;
    'debug-mode': boolean;
};

/** All existing schema keys. */
export type SchemaKey = keyof Schema;

/** Mapping of schema keys to their GLib Variant type string */
export const Schema = {
    'settings-version': 'u',
    blacklist: 'as',
    whitelist: 'b',
    'suspend-during-interaction': 'b',
    'debug-mode': 'b',
};

/** The raw GSettings object for direct manipulation. */
export let prefs: Gio.Settings;

/**
 * Initialize the {@link prefs} object with existing GSettings.
 *
 * The look of the windows comes from GTK's stylesheets since settings
 * version 11, so the settings of older versions for it are gone from the
 * schema and need no migration.
 *
 * @param gSettings - GSettings to initialize the prefs with.
 */
export function initPrefs(gSettings: Gio.Settings) {
    prefs = gSettings;
}

/** Delete the {@link prefs} object for garbage collection. */
export function uninitPrefs() {
    (prefs as Gio.Settings | null) = null;
}

/**
 * Get a preference from GSettings and convert it from a GLib Variant to a
 * JavaScript type.
 *
 * @param key - The key of the preference to get.
 * @returns The value of the preference.
 */
export function getPref<K extends SchemaKey>(key: K) {
    return prefs.get_value(key).recursiveUnpack() as Schema[K];
}

/**
 * Pack a value into a GLib Variant type and store it in GSettings.
 *
 * @param key - The key of the preference to set.
 * @param value - The value to set the preference to.
 */
export function setPref<K extends SchemaKey>(key: K, value: Schema[K]) {
    // @ts-expect-error
    // TypeScript can't figure out that the value will always match the glib schema type here
    prefs.set_value(key, new GLib.Variant(Schema[key], value));
}

/** A simple type-checked wrapper around {@link prefs.bind} */
export function bindPref(
    key: SchemaKey,
    object: GObject.Object,
    property: string,
    flags: Gio.SettingsBindFlags,
) {
    // @ts-expect-error: TODO https://github.com/gjsify/ts-for-gir/issues/431
    prefs.bind(key, object, property, flags);
}
