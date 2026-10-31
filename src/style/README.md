# `style`

Reads the window style the way GTK does for a libadwaita window.

## `style_resolver.ts`

Loads libadwaita's stylesheet, the accent color and
`~/.config/gtk-4.0/gtk.css` (with its imports), and watches them for changes.

## `adw_probe.js`

Prints libadwaita's stylesheet. GNOME Shell must not load libadwaita, so the
extension runs it with `gjs`.

## `vendor`

The CSS reader of [Rounded Window Corners Native](https://github.com/ztrahmet/rounded-window-corners),
kept in JavaScript to stay close to its source. `css_values.js` is unchanged;
`css_parse.js` also reads `border` and `margin`, and the window's state
classes. Biome skips these files.
