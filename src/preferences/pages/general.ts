/**
 * @file Contains the implementation of the main preferences page.
 * There isn't much logic in this file.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {bindPref} from '../../utils/settings.js';

export const GeneralPage = GObject.registerClass(
    {
        Template: GLib.uri_resolve_relative(
            import.meta.url,
            'general.ui',
            GLib.UriFlags.NONE,
        ),
        GTypeName: 'PrefsGeneral',

        // Those variables are declared inside of the `general.ui` file and
        // passed into the JS module prefixed with an underscore.
        // (enableDebugLogs -> _enableDebugLogs)
        InternalChildren: ['suspendDuringInteraction', 'enableDebugLogs'],
    },
    class extends Adw.PreferencesPage {
        private declare _suspendDuringInteraction: Adw.SwitchRow;
        private declare _enableDebugLogs: Adw.SwitchRow;

        // Bind all switches to respective prefs.
        constructor() {
            super();

            bindPref(
                'suspend-during-interaction',
                this._suspendDuringInteraction,
                'active',
                Gio.SettingsBindFlags.DEFAULT,
            );

            bindPref(
                'debug-mode',
                this._enableDebugLogs,
                'active',
                Gio.SettingsBindFlags.DEFAULT,
            );
        }
    },
);
