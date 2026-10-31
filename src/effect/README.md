# `effect`

This directory contains the code for applying GLSL effects to windows.

## `rounded_corners_effect.ts`

`RoundedCornersEffect` draws the window into an offscreen buffer at its
monitor's real scale, on the screen's pixel grid, and the shader clips it to its
rounded shape and draws the border, shadow and outline. `ShadowRoomEffect` goes before it and grows the
paint volume, so the buffer has room for the shadow. The effect also moves
itself after effects that deform the window.

## `shadow.ts`

Turns `box-shadow` layers into the shader's uniforms.

## `shader`

This is the directory where the Fragment shaders are stored.

`shader/rounded_corners.frag` is commented and explains how it works.
