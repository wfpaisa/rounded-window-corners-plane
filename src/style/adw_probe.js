// Prints libadwaita's stylesheet. GNOME Shell must not load libadwaita, since
// that registers its stylesheet, so the extension runs this with gjs.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';

// The first call loads the library, which registers its resources.
Adw.get_major_version();

const bytes = Gio.resources_lookup_data(
    '/org/gnome/Adwaita/styles/gtk.css',
    Gio.ResourceLookupFlags.NONE,
);

print(new TextDecoder().decode(bytes.get_data()));
