// Based on this shader from Mutter:
// https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/compositor/meta-background-content.c

// This shader is what actually does the most important part of the extension -
// corner rounding.
//
// The way Fragment shaders work in GNOME is that they receive the information
// about a point on the screen, process it in some way, and set the `cogl_color_out`
// variable which indicates what color should be drawn to the screen at that
// point.
//
// Corner rounding is works by doing a bunch of simple calculations on
// the point coordinates to determine if the point lies within the visible part
// of the window, and making it invisible (multiplying `cogl_color_out` by 0)
// if it's not.

// First, we declare our uniforms.
// Uniforms are parameters that are passed to the shader from external code.

// Bounds of the window as {x, y, z, w}:
//   x - left
//   y - top
//   z - right
//   w - bottom
uniform vec4 bounds;

// Blend decorations without fading the actual application contents.
uniform float effectStrength;

// The border radius of the corner clipping.
uniform float clipRadius;

// Width and color of the border
uniform float borderWidth;
uniform vec4 borderColor;

// Bounds and clip radius of the area inside of borders.
// When using inner borders, this is the smaller window area within those borders.
// With outer borders, this is the total area of the window together with them.
uniform vec4 borderedAreaBounds;
uniform float borderedAreaClipRadius;

// Exponent to use for squircle corners
uniform float exponent;

// Size of one logical pixel in texture coordinates. Dividing texture
// coordinates by it gives logical pixels from the offscreen buffer's origin.
uniform vec2 pixelStep;

// Actor-local logical position of the offscreen buffer's top-left pixel.
uniform vec2 textureOrigin;

// Texture coordinates of the bottom-right corner of the window in the buffer.
// The buffer is shared by all windows, so past it there are no window pixels.
uniform vec2 textureLimit;

// The shadow is drawn by this shader too, around the window, instead of by a
// separate actor: it needs no texture of its own.
//
// Box that casts the shadow as {x, y, z, w} like `bounds`, already grown by
// the spread and moved by the offset of the shadow.
uniform vec4 shadowBounds;
uniform float shadowRadius;
// Standard deviation of the Gaussian blur: half the CSS blur radius.
uniform float shadowSigma;
// Opacity of the black shadow, 0 to disable it.
uniform float shadowAlpha;

// Calculate whether a point is within the rounded window when using regular
// circular corner rounding.
//
//          p | The point
//     center | The center of the circle used for border rounding
// clipRadius | Border radius
float circleBounds(vec2 p, vec2 center, float clipRadius) {
    // Get the distance from the circle center to the point
    vec2 delta = p - center;
    float distSquared = dot(delta, delta);

    // If the distance is larger than the border radius, the point is outside
    // of the rounded corner, and should be invisible.
    float outerRadius = clipRadius + 0.5;
    if (distSquared >= (outerRadius * outerRadius))
        return 0.0;

    // Likewise, if it is smaller, the point is inside of the window.
    float borderedAreaRadius = clipRadius - 0.5;
    if (distSquared <= (borderedAreaRadius * borderedAreaRadius))
        return 1.0;

    // If the difference between border radius and the distance is less than
    // 0.5, the point is located on the edge of the window, and should be
    // antialiased.
    //
    // Taking a square root is computationally expensive, so this is avoided as
    // much as possible.
    return outerRadius - sqrt(distSquared);
}

// Calculate whether a point is within the rounded window when using squircle
// corner rounding.
//
// A squircle is what's called a "superellipse", which is defined by this formula:
//     (|x|^n + |y|^n)^(1/n)
//
//          p | The point
//     center | The center of the circle used for border rounding
// clipRadius | Border radius
//   exponent | The exponent (n) of the superellipse
float squircleBounds(vec2 p, vec2 center, float clipRadius, float exponent) {
    // Get the distances from the circle center to the point (|x|, |y|)
    vec2 delta = abs(p - center);

    // Raise the distances to the given power (|x|^n, |y|^n)
    float powDx = pow(delta.x, exponent);
    float powDy = pow(delta.y, exponent);

    // Calculate the end result of the formula (|x|^n + |y|^n)^(1/n)
    float dist = pow(powDx + powDy, 1.0 / exponent);

    // Calculate the opacity for the point and normalize it between 0 and 1
    return clamp(clipRadius - dist + 0.5, 0.0, 1.0);
}

// Calculate the correct opacity for a given point within the window.
//
//          p | The point
//     bounds | The bounds of the window
// clipRadius | Border radius
//   exponent | The exponent (smoothness) of the squircle corners.
//            | See `squircleBounds` for more information.
float getPointOpacity(vec2 p, vec4 bounds, float clipRadius, float exponent) {
    // Cover straight edges continuously instead of dropping a complete row
    // when a thin border falls between pixel centers at fractional scaling.
    vec2 edgeDistance = min(p - bounds.xy, bounds.zw - p);
    vec2 pixelWidth = max(fwidth(p), vec2(0.0001));
    vec2 edgeCoverage = clamp(edgeDistance / pixelWidth + 0.5, 0.0, 1.0);
    float rectangleAlpha = min(edgeCoverage.x, edgeCoverage.y);
    if (rectangleAlpha <= 0.0)
        return 0.0;

    // This is the center of the circle that is used for corner rounding.
    vec2 center;

    // First, we find the centers of the circles on the horizontal axis.
    // `centerLeft` is for two corners on the left of the window, and
    // `centerRight` is for corners on the right.
    float centerLeft = bounds.x + clipRadius;
    float centerRight = bounds.z - clipRadius;

    // If the point is closer to the window border than the circle center, it
    // has a chance of being within the rounded area, so we store the center
    // x position and continue. If it's not, then it should always be visible
    // and we can return 1.0 early to avoid extra computation (this is the case
    // for the vast majority of points).
    if (p.x < centerLeft)
        center.x = centerLeft;
    else if (p.x > centerRight)
        center.x = centerRight;
    else
        return rectangleAlpha;

    // Now we do the same, but for the vertical coordinate of the center.
    float centerTop = bounds.y + clipRadius;
    float centerBottom = bounds.w - clipRadius;

    if (p.y < centerTop)
        center.y = centerTop;
    else if (p.y > centerBottom)
        center.y = centerBottom;
    else
        return rectangleAlpha;

    // If the exponent is set, apply squircle bounds, otherwise use regular
    // circular ones.
    if (exponent <= 2.0)
        return min(rectangleAlpha, circleBounds(p, center, clipRadius));
    else
        return min(rectangleAlpha, squircleBounds(p, center, clipRadius, exponent));
}

// Approximation of the error function, with a maximum error of 0.0005
// (Abramowitz and Stegun, formula 7.1.27).
vec2 erf(vec2 x) {
    vec2 s = sign(x);
    vec2 a = abs(x);
    x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
    x *= x;
    return s - s / (x * x);
}

float gaussian(float x, float sigma) {
    return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.50662827 * sigma);
}

// Blur of one row of the rounded box along x, which has a closed form: the
// row is a plain segment, as wide as the box at that height.
float shadowRow(float x, float y, float sigma, float radius, vec2 halfSize) {
    float delta = min(halfSize.y - radius - abs(y), 0.0);
    float curved = halfSize.x - radius + sqrt(max(0.0, radius * radius - delta * delta));
    vec2 integral = 0.5 + 0.5 * erf((x + vec2(-curved, curved)) * (0.70710678 / sigma));
    return integral.y - integral.x;
}

// Opacity of a Gaussian blurred rounded box at a point. The blur along y has
// no closed form, so it is sampled from a few rows, as described in
// https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/
float shadowOpacity(vec2 p) {
    vec2 halfSize = (shadowBounds.zw - shadowBounds.xy) * 0.5;
    float radius = min(shadowRadius, min(halfSize.x, halfSize.y));
    float sigma = max(shadowSigma, 0.5);
    p -= (shadowBounds.xy + shadowBounds.zw) * 0.5;

    // Rows further than 3 sigma add nothing.
    float start = clamp(-3.0 * sigma, p.y - halfSize.y, p.y + halfSize.y);
    float end = clamp(3.0 * sigma, p.y - halfSize.y, p.y + halfSize.y);
    float stride = (end - start) / 4.0;
    float y = start + stride * 0.5;
    float value = 0.0;
    for (int i = 0; i < 4; i++) {
        value += shadowRow(p.x, p.y - y, sigma, radius, halfSize) * gaussian(y, sigma) * stride;
        y += stride;
    }
    return value;
}

// This is the main function of the shader. It's what is actually being called
// when rendering a point to the screen. It has no return value; as explained
// at the beginning of the file, the `cogl_color_out` variable is used to set
// the point color.
void main() {
    // The painted area reaches past the window to draw the shadow: drop the
    // pixels sampled there.
    vec2 texCoord = cogl_tex_coord0_in.xy;
    vec2 inTexture = step(vec2(0.0), texCoord) * step(texCoord, textureLimit);
    cogl_color_out *= inTexture.x * inTexture.y;

    vec4 originalColor = cogl_color_out;
    vec2 p = texCoord / pixelStep + textureOrigin;

    float pointAlpha = getPointOpacity(p, bounds, clipRadius, exponent);
    // How much of the point the window and its border cover.
    float coverage = pointAlpha;

    if (borderWidth > 0.9 || borderWidth < -0.9) {
        // If there is a border, we have to paint it.

        // Calculate if the point lies within the bordered area (see the
        // `borderedAreaBounds` uniform for an explanation of what this means)
        float borderedAreaAlpha = getPointOpacity(p, borderedAreaBounds, borderedAreaClipRadius, exponent);

        if (borderWidth > 0.0) {
            // Inner borders

            // Clip points that are not inside of the window
            cogl_color_out *= pointAlpha;
            // Calculate if the point is located on the border itself
            float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0);
            // Then, mix the window color and the border color
            cogl_color_out = mix(cogl_color_out, vec4(borderColor.rgb, 1.0), borderAlpha * borderColor.a);
        } else {
            // Outer borders

            // If the point is within the bordered area, paint it with the
            // border color
            vec4 borderRect = vec4(borderColor.rgb, 1.0) * borderedAreaAlpha * borderColor.a;
            coverage = max(pointAlpha, borderedAreaAlpha);
            // Then, if the point is also inside of the actual window
            // (pointAlpha = 1), draw the correct window pixel on top
            cogl_color_out = mix(borderRect, cogl_color_out, pointAlpha);
        }
    } else {
        // If there's no border, just multiply the output color by the calculated
        // alpha value.
        cogl_color_out *= pointAlpha;
    }
    cogl_color_out = mix(originalColor, cogl_color_out, effectStrength);

    // Draw the shadow only outside the window, so that it never shows
    // through translucent windows.
    if (shadowAlpha > 0.0 && coverage < 1.0) {
        float shadow = shadowAlpha * shadowOpacity(p) * (1.0 - coverage);
        // cogl_color_in carries the opacity of the window.
        cogl_color_out.a += shadow * effectStrength * cogl_color_in.a;
    }
}
