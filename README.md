<div align="center">
  <h1>Rounded Window Corners Plane</h1>
  <p><i>A GNOME extension that adds rounded corners to all windows</i></p>
</div>
<br>

> [!NOTE]
> This is a fork of [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)
> by @flexagoon, itself a fork of the [original rounded-window-corners extension](https://github.com/yilozt/rounded-window-corners)
> by @yilozt. It uses its own UUID (`rounded-window-corners-plane@wfpaisa`)
> and settings schema, so it can be installed next to Reborn without
> conflicts. Enable only one of them at a time.

## How it differs from Rounded Window Corners Reborn

- **Follows GTK instead of its own settings.** Corner radius, border, outline,
  shadow and margin come from libadwaita's stylesheet and your
  `~/.config/gtk-4.0/gtk.css`, for every state: normal, unfocused, maximized,
  tiled and fullscreen. Light, dark, high contrast and the accent color follow
  on their own, and edits to `gtk.css` apply live. libadwaita apps are left
  alone, since they already draw all of this themselves.
- **libadwaita's shadow.** The shadow is computed the way GTK's renderer does,
  with every `box-shadow` layer, and the app's own thin border is replaced so
  only one outline is left.
- **Sharp text at fractional scales.** Each window is drawn into one buffer at
  its monitor's real scale, laid out on the screen's pixel grid, so text looks
  the same as without the extension. Windows whose look draws nothing, like
  maximized ones with libadwaita's style, cost nothing.
- **Works with deforming effects.** Wobbly windows from *Compiz windows effect*
  and *Compiz alike magic lamp effect* deform the rounded window, border
  included, instead of being cut at the window frame. The shadow is hidden while
  the window is deformed.
- **Optionally hide effects while moving or resizing**, fading them back
  afterwards (see below).
- **GNOME Shell 51 support.**

The rendering, the CSS reading and the shadow are adapted from
[Rounded Window Corners Native](https://github.com/ztrahmet/rounded-window-corners)
by @ztrahmet. See [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md).

## Installation

### From pre-built archives

If you want to install the latest commit of the extension, you can get a
pre-built archive from GitHub Actions.

1. Sign in to GitHub.
2. Go to [the build action page](https://github.com/wfpaisa/rounded-window-corners-plane/actions/workflows/build.yml)
3. Click on the latest workflow run
4. Download the extension from the "artifacts" section at the bottom
5. Install it with the `gnome-extensions install` command

### From source code

1. Install the dependencies:
    - Node.js
    - npm
    - gettext
    - [just](https://just.systems)

    Those packages are available in the repositories of most linux distros, so
    you can simply install them with your package manager.

2. Build the extension

    ```bash
    git clone https://github.com/wfpaisa/rounded-window-corners-plane
    cd rounded-window-corners-plane
    just install
    ```

After this, the extension will be installed to
`~/.local/share/gnome-shell/extensions`.

## Translation

Translations are inherited from Rounded Window Corners Reborn. You can edit the
.po files in `po/` and submit a PR.

## Development

Here are the avaliable `just` commands (run `just --list` to see this message):

```bash
Available recipes:
    build   # Compile the extension and all resources
    clean   # Delete the build directory
    install # Build and install the extension from source
    pack    # Build and pack the extension
    pot     # Update and compile the translation files
```

## Credits

Based on the work of @yilozt and @flexagoon, and everyone who contributed to
Rounded Window Corners and Rounded Window Corners Reborn. Thanks to [yotamguttman](https://github.com/yotamguttman) for making an icon for the extension!

## Window margin

There is no setting for it: windows take the `margin` of GTK's window style,
as libadwaita apps do. For example, this in `~/.config/gtk-4.0/gtk.css` leaves
a 2 px gap around tiled windows, in every app. Maximized and fullscreen windows
get it too, since Mutter tells apps they are tiled on every edge, and GTK then
matches these rules as well:

```css
window.tiled, window.tiled-top, window.tiled-bottom,
window.tiled-left, window.tiled-right {
  margin: 2px;
}
```

The window keeps its size; the margin is cut from its edges, as GTK leaves it
empty inside the window.

## Effects during moving and resizing

General → Tweaks → **Hide effects while moving or resizing** controls this
behavior (enabled by default). A title-bar click leaves effects unchanged. Once the window actually moves
or changes size during a pointer operation, it hides the extension's border, corner rounding and shadow. When the operation ends,
all three fade back together over 180 ms. Application contents do not fade. Starting another
operation cancels the previous transition. Turning the switch off restores normal
effects immediately, including during an active operation. The return is immediate
when GNOME animations are disabled.

## Install and test locally

Run `npm run install` to build and install the extension. Then run
`npm run debug` to open a separate GNOME Wayland development session without
logging out of the current desktop. This requires a GNOME Shell/Mutter build with
Devkit support (`--devkit`); builds without it cannot run this command.
The script checks this before launching. Installing the separate `mutter-devkit`
package is not enough if Mutter itself was built without Devkit.
Enable Rounded Window Corners Plane in that
session to test it. Close the development session and run the two commands again
after source changes to load the latest code.

The build installs npm dependencies with `--ignore-scripts` to avoid recursively
calling the package's `install` script.
