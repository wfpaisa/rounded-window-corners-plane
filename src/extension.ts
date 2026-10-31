import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layoutManager} from 'resource:///org/gnome/shell/ui/main.js';

import {releaseBuffers} from './effect/rounded_corners_effect.js';
import {disableEffect, enableEffect} from './manager/event_manager.js';
import {WindowMargin} from './manager/window_margin.js';
import {logDebug} from './utils/log.js';
import {initPrefs, uninitPrefs} from './utils/settings.js';
import {WindowPicker} from './window_picker/service.js';

export default class RoundedWindowCornersPlane extends Extension {
    #windowPicker: WindowPicker | null = null;

    #windowMargin: WindowMargin | null = null;

    #layoutManagerStartupConnection: number | null = null;

    enable() {
        // Initialize extension preferences
        const settings = this.getSettings();
        initPrefs(settings);
        this.#windowMargin = new WindowMargin(settings);

        // Export the d-bus interface of the window picker in preferences.
        // See the readme in the `window_picker` directory for more information.
        this.#windowPicker = new WindowPicker();
        this.#windowPicker.export();

        if (layoutManager._startingUp) {
            // Wait for GNOME Shell to be ready before enabling rounded corners
            this.#layoutManagerStartupConnection = layoutManager.connect(
                'startup-complete',
                () => {
                    enableEffect();

                    layoutManager.disconnect(
                        // biome-ignore lint/style/noNonNullAssertion: Since this happens inside of the connection, there is no way for this to be null.
                        this.#layoutManagerStartupConnection!,
                    );
                },
            );
        } else {
            enableEffect();
        }

        // Window previews in the overview clone the window actor, so they
        // paint it with the effect, shadow included, from the buffer the
        // window already has. Nothing has to be patched for them.

        logDebug('Enabled');
    }

    disable() {
        this.#windowMargin?.destroy();
        this.#windowMargin = null;

        this.#windowPicker?.unexport();
        disableEffect();
        releaseBuffers();

        // Set all props to null
        this.#windowPicker = null;

        if (this.#layoutManagerStartupConnection !== null) {
            layoutManager.disconnect(this.#layoutManagerStartupConnection);
            this.#layoutManagerStartupConnection = null;
        }

        logDebug('Disabled');

        uninitPrefs();
    }
}
