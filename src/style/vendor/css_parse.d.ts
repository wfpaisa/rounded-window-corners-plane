/** @file Types of the CSS reader taken from Rounded Window Corners Native. */

type Rgba = [number, number, number, number];

/** One outer layer of a box-shadow, in logical pixels. */
export type ShadowLayer = {
    dx: number;
    dy: number;
    blur: number;
    spread: number;
    color: Rgba;
};

/** What GTK draws around a window, in logical pixels. */
export type WindowLook = {
    /** Clockwise from top-left. */
    radii: [number, number, number, number];
    /** Clockwise from the top. */
    margins: [number, number, number, number];
    /** Clockwise from the top, 0 where the border is not drawn. */
    borderWidths: [number, number, number, number];
    borderColor: Rgba;
    outlineWidth: number;
    outlineOffset: number;
    outlineColor: Rgba;
    shadow: ShadowLayer[];
};

export const FALLBACK_CSS: string;

export function stripComments(css: string): string;

export function readWindowStyle(
    sheets: string[],
    env: {
        dark: boolean;
        highContrast: boolean;
        rtl: boolean;
        colorName: (name: string) => Rgba | null;
    },
): (classes: string[], backdrop: boolean) => WindowLook;
