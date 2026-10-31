// Draws the window the way GTK draws a libadwaita one: clipped to its rounded
// shape, with its border, its box-shadow outside and its outline on top.
//
// Adapted from the shader of https://github.com/ztrahmet/rounded-window-corners
// (lib/roundedCornersEffect.js). The shadow comes from GTK's renderer,
// gsk/gpu/shaders/gskgpuboxshadow.glsl (LGPL-2.1-or-later).
//
// The effect has already drawn the window into its offscreen buffer, and Cogl
// has sampled it into `cogl_color_out`, premultiplied and with the window's
// opacity applied, when this code runs.

// Window box in actor pixels as {x1, y1, x2, y2}: the frame without the CSS
// margin. The radii run clockwise from top-left.
uniform vec4 bounds;
uniform vec4 radii;
// Nothing is drawn outside this box, in actor pixels.
uniform vec4 clip;

// actorPixel = fboMap.xy + texCoord * fboMap.zw
uniform vec4 fboMap;
// Physical pixels per actor pixel in the offscreen buffer.
uniform float texelScale;
// 1 when the buffer is not painted 1:1 onto the screen at a fractional scale,
// which blurs edges by a texel.
uniform float smear;
// How deep the app's own border reaches into the window, 0 to keep it.
uniform float borderRemovalWidth;

// CSS border, clockwise from the top, drawn in a single color.
uniform vec4 borderWidths;
uniform vec4 borderColor;

uniform float outlineWidth;
uniform float outlineOffset;
uniform vec4 outlineColor;

// Box-shadow layers, filled from the first: (dx, dy, spread, sigma) and their
// color. Clutter sets each uniform as a single value, so every layer has
// uniforms of its own. SHADOW_SLOTS in shadow.ts must match.
uniform vec4 shadowShape0;
uniform vec4 shadowColor0;
uniform vec4 shadowShape1;
uniform vec4 shadowColor1;
uniform vec4 shadowShape2;
uniform vec4 shadowColor2;
uniform vec4 shadowShape3;
uniform vec4 shadowColor3;
uniform vec4 shadowShape4;
uniform vec4 shadowColor4;
uniform vec4 shadowShape5;
uniform vec4 shadowColor5;

// How much of the decoration shows, to fade it in. The shadow has its own,
// since it hides while another effect deforms the window.
uniform float strength;
uniform float shadowStrength;

const float PI = 3.14159265;

float coverage(float distance) {
    return clamp(0.5 - distance * texelScale, 0.0, 1.0);
}

float cornerRadius(vec4 corners, vec2 p) {
    vec2 side = p.x < 0.0 ? corners.xw : corners.yz;
    return p.y < 0.0 ? side.x : side.y;
}

float sdRoundRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Abramowitz and Stegun 7.1.27.
vec2 erfApprox(vec2 x) {
    vec2 s = sign(x);
    vec2 a = abs(x);
    x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
    x *= x;
    return s - s / (x * x);
}

float erfRange(vec2 x, float sigma) {
    vec2 fromTo = 0.5 - 0.5 * erfApprox(x / (sigma * sqrt(2.0)));
    return fromTo.y - fromTo.x;
}

// p measured inward from the corner.
float blurCorner(vec2 p, float r, float sigma) {
    if (r <= 0.0)
        return 0.0;
    p /= sigma;
    r /= sigma;
    if (min(p.x, p.y) <= -2.95 || max(p.x, p.y) - r >= 2.95)
        return 0.0;

    float start = max(p.y - 3.0, 0.0);
    float step = (min(p.y + 3.0, r) - start) / 7.0;
    float result = 0.0;
    for (int i = 0; i < 8; i++) {
        float y = start + float(i) * step;
        float t = (r - y) / r;
        float x = r - r * sqrt(max(1.0 - t * t, 0.0));
        result -= exp(-0.5 * (p.y - y) * (p.y - y)) / sqrt(2.0 * PI) * erfRange(vec2(-p.x, x - p.x), 1.0);
    }
    return step * result;
}

// Like GTK, an unblurred layer is a plain shape.
float shadowLayer(vec2 p, vec2 halfSize, float spread, float sigma) {
    vec2 h = halfSize + spread;
    vec4 corners = max(radii + sign(radii) * spread, 0.0);
    if (sigma == 0.0)
        return coverage(sdRoundRect(p, h, min(cornerRadius(corners, p), min(h.x, h.y))));

    float shadow = erfRange(vec2(-h.x - p.x, h.x - p.x), sigma) * erfRange(vec2(-h.y - p.y, h.y - p.y), sigma);
    shadow -= blurCorner(p + h, corners.x, sigma);
    shadow -= blurCorner(vec2(h.x - p.x, p.y + h.y), corners.y, sigma);
    shadow -= blurCorner(h - p, corners.z, sigma);
    shadow -= blurCorner(vec2(p.x + h.x, h.y - p.y), corners.w, sigma);
    return shadow;
}

void shadowSlot(int i, out vec4 shape, out vec4 color) {
    if (i == 0) {
        shape = shadowShape0;
        color = shadowColor0;
    } else if (i == 1) {
        shape = shadowShape1;
        color = shadowColor1;
    } else if (i == 2) {
        shape = shadowShape2;
        color = shadowColor2;
    } else if (i == 3) {
        shape = shadowShape3;
        color = shadowColor3;
    } else if (i == 4) {
        shape = shadowShape4;
        color = shadowColor4;
    } else {
        shape = shadowShape5;
        color = shadowColor5;
    }
}

// Premultiplied. As in GTK, each layer is drawn over the ones before it.
vec4 shadow(vec2 p, vec2 halfSize) {
    vec4 result = vec4(0.0);
    for (int i = 0; i < 6; i++) {
        vec4 shape, color;
        shadowSlot(i, shape, color);
        // The layers fill the slots from the first.
        if (color.a == 0.0)
            break;
        float a = color.a * shadowLayer(p - shape.xy, halfSize, shape.z, shape.w);
        result = vec4(color.rgb * a, a) + result * (1.0 - a);
    }
    return result;
}

// Where to take the color that replaces the app's own border.
vec2 removalSample(vec2 p, vec2 halfSize, float r, float d) {
    vec2 q = abs(p) - halfSize + r;
    vec2 edge = halfSize - abs(p);
    float reach = borderRemovalWidth + (0.5 + smear) / texelScale;

    if (q.x <= 0.0 || q.y <= 0.0 || max(edge.x, edge.y) < reach)
        return p - sign(p) * max(vec2(reach) - edge, 0.0);

    // Parallel to the nearer edge, so lines running into the arc stay straight.
    bool alongY = edge.x >= reach && (edge.y < reach || edge.x < edge.y);
    vec2 dir = alongY ? vec2(0.0, -sign(p.y)) : vec2(-sign(p.x), 0.0);
    float inward = dot(dir, -sign(p) * normalize(q));
    return p + dir * max(reach + d, 0.0) / max(inward, 0.25);
}

// Signed distance to the inner edge of the border. As in GTK, each inner
// corner is the outer one shrunk by the widths of its sides.
float borderInner(vec2 p, vec2 center) {
    // {top, right, bottom, left} -> inset of {x1, y1, x2, y2}
    vec4 inner = bounds + vec4(borderWidths.w, borderWidths.x, -borderWidths.y, -borderWidths.z);
    vec2 innerHalf = max((inner.zw - inner.xy) * 0.5, 0.0);
    vec2 ip = p + center - (inner.xy + inner.zw) * 0.5;
    vec4 shrink = vec4(
        max(borderWidths.w, borderWidths.x),
        max(borderWidths.x, borderWidths.y),
        max(borderWidths.y, borderWidths.z),
        max(borderWidths.z, borderWidths.w));
    vec4 innerRadii = max(radii - shrink, 0.0);
    float ir = min(cornerRadius(innerRadii, ip), min(innerHalf.x, innerHalf.y));
    return sdRoundRect(ip, innerHalf, ir);
}

void main() {
    // Already applied to cogl_color_out, but not to what is added to it.
    float opacity = cogl_color_in.a;
    vec4 original = cogl_color_out;

    vec2 halfSize = (bounds.zw - bounds.xy) * 0.5;
    vec2 center = (bounds.xy + bounds.zw) * 0.5;
    vec2 p = fboMap.xy + cogl_tex_coord0_in.xy * fboMap.zw - center;
    float maxRadius = min(halfSize.x, halfSize.y);
    float r = min(cornerRadius(radii, p), maxRadius);
    float d = sdRoundRect(p, halfSize, r);

    float removalWidth = borderRemovalWidth > 0.0 ? borderRemovalWidth + 2.0 * smear / texelScale : 0.0;
    float maxBorder = max(max(borderWidths.x, borderWidths.y), max(borderWidths.z, borderWidths.w));

    // Deeper inside the window there is nothing to replace or draw over.
    if (d > -(max(max(removalWidth, maxBorder), -outlineOffset) + 0.5 / texelScale)) {
        float content = coverage(d);

        float removalBand = content - coverage(d + removalWidth);
        if (removalBand > 0.0) {
            vec2 st = cogl_tex_coord0_in.xy + (removalSample(p, halfSize, r, d) - p) / fboMap.zw;
            cogl_color_out = mix(cogl_color_out, texture2D(cogl_sampler0, st) * opacity, removalBand / content);
        }

        cogl_color_out *= content;

        // The border lies inside the window, over its contents.
        if (maxBorder > 0.0) {
            float ba = (content - coverage(borderInner(p, center))) * borderColor.a;
            cogl_color_out = cogl_color_out * (1.0 - ba) + vec4(borderColor.rgb, 1.0) * ba * opacity;
        }

        if (content < 1.0 && shadowStrength > 0.0)
            cogl_color_out += shadow(p, halfSize) * (1.0 - content) * opacity * shadowStrength;

        // GTK draws the outline over the window and its shadow.
        float outlineBand = coverage(d - outlineOffset - outlineWidth) - coverage(d - outlineOffset);
        float oa = outlineBand * outlineColor.a;
        cogl_color_out = cogl_color_out * (1.0 - oa) + vec4(outlineColor.rgb, 1.0) * oa * opacity;
    }

    cogl_color_out = mix(original, cogl_color_out, strength);

    vec2 actorPixel = p + center;
    if (any(lessThan(actorPixel, clip.xy)) || any(greaterThan(actorPixel, clip.zw)))
        cogl_color_out = vec4(0.0);
}
