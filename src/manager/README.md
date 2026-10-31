# `manager`

## `window_tracker.ts`

Decides which windows get rounded corners and keeps their effects in sync with
the window's state (normal, maximized, tiled, fullscreen), its focus, the
blacklist and the GTK style. It also hides the effects while a window is
dragged, when that preference is on.
