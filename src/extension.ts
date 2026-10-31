import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layoutManager} from 'resource:///org/gnome/shell/ui/main.js';

import {cancelGc} from './effect/rounded_corners_effect.js';
import {WindowTracker} from './manager/window_tracker.js';
import {logDebug} from './utils/log.js';
import {initPrefs, uninitPrefs} from './utils/settings.js';
import {WindowPicker} from './window_picker/service.js';

export default class RoundedWindowCornersPlane extends Extension {
    #windowPicker: WindowPicker | null = null;

    #tracker: WindowTracker | null = null;

    enable() {
        // Initialize extension preferences
        initPrefs(this.getSettings());

        // Export the d-bus interface of the window picker in preferences.
        // See the readme in the `window_picker` directory for more information.
        this.#windowPicker = new WindowPicker();
        this.#windowPicker.export();

        if (layoutManager._startingUp) {
            // Wait for GNOME Shell to be ready before enabling rounded corners
            layoutManager.connectObject(
                'startup-complete',
                () => {
                    layoutManager.disconnectObject(this);
                    this.#startTracker();
                },
                this,
            );
        } else {
            this.#startTracker();
        }

        logDebug('Enabled');
    }

    disable() {
        layoutManager.disconnectObject(this);

        this.#tracker?.destroy();
        cancelGc();
        this.#tracker = null;

        this.#windowPicker?.unexport();
        this.#windowPicker = null;

        logDebug('Disabled');

        uninitPrefs();
    }

    #startTracker() {
        this.#tracker = new WindowTracker(
            GLib.build_filenamev([this.path, 'style', 'adw_probe.js']),
        );
    }
}
