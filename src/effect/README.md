# `effect`

This directory contains the code for applying GLSL effects to windows.

## `rounded_corners_effect.ts`

This effect loads the actual Fragment shader that rounds the corners and draws
custom borders and the shadow of the window. The class applies the effect and provides a
function to change uniforms passed to the effect.

## `shader`

This is the directory where the Fragment shaders are stored.

If you're interested in implementation details of the shader, you can read the
`shader/rounded_corners.frag` file, which is well commented and explains how
it works in great detail.
