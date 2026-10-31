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

## Improvements over Rounded Window Corners Reborn

- **Sharp text with fractional scaling.** Reborn renders windows through
  Clutter's offscreen effect at `ceil(scale)` (2x at 150%) and shrinks them back,
  which blurs or jags text. This fork renders at the monitor's real scale and
  lays the buffer out on the screen's pixel grid, so every window pixel maps to
  one screen pixel.
- **Even borders at fractional scales.** Window edges, padding and border width
  are snapped to whole physical pixels, so all four sides look the same at any
  window position.
- **Much less VRAM.** The shadow is computed by the corner shader instead of
  a separate actor rendered offscreen at 2x, and window buffers share a fixed
  VRAM budget: windows painted least recently hand their buffer over instead
  of allocating more. See [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md).
- **Unfocused border color.** A separate border color for windows without focus,
  globally and per application.
- **Works with deforming effects.** Wobbly windows from *Compiz windows effect*
  and *Compiz alike magic lamp effect* deform the rounded window, border
  included, instead of being cut at the window frame. The shadow is hidden while
  the window is deformed. This also works for XWayland windows.
- **Outer window margin** for maximized and tiled windows (see below).
- **Optionally hide effects while moving or resizing**, fading them back
  afterwards (see below).
- **GNOME Shell 51 support**, replacing the removed `Shell.GLSLEffect`.

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

## Outer window margin

In General → Window margin, enable **Enable outer margin** and choose a size
from 0 to 64 logical pixels (default: 2). The feature is disabled by default.
Changes apply immediately. GNOME reserves this space outside maximized and
tiled windows, preserving their native states and resizing their contents.
Fullscreen applications remain unchanged. This affects all applications,
including those excluded from corner rounding, and adds no gap between adjacent
tiled windows. Disabling the switch or the extension restores the original work
area. The margin is measured from the usable area after panels and docks.

## Effects during moving and resizing

General → Tweaks → **Hide effects while moving or resizing** controls this
behavior (enabled by default). A title-bar click leaves effects unchanged. Once the window actually moves
or changes size during a pointer operation, it hides the extension's border, corner rounding and shadow. When the operation ends,
all three fade back together over 180 ms. The border fades from transparent to its
configured color and opacity; application contents do not fade. Starting another
operation cancels the previous transition. Turning the switch off restores normal
effects immediately, including during an active operation. The return is immediate
when GNOME animations are disabled.

## Fractional scaling

The rounded corners effect renders each window into its own buffer at the real
scale of the monitor being painted (for example 1.5, not 2), aligned with the
screen's pixel grid. Window edges, the clip padding and the border width are
rounded to whole physical pixels on that grid, rounding inwards so the clip
always hides at least the configured padding. Enable debug logs to see the
buffer placement of each window in the journal.

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
