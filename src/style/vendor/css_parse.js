/**
 * CSS reader for the window style libadwaita draws
 *
 * @author     Ahmet Öztürk <141689708+ztrahmet@users.noreply.github.com>
 * @copyright  2026 Ahmet Öztürk
 * @license    GPL-3.0-or-later
 *
 * From https://github.com/ztrahmet/rounded-window-corners (lib/cssParse.js).
 * Adapted for Rounded Window Corners Plane: it also reads border and margin,
 * and the window's maximized, tiled and fullscreen classes.
 */

import {closingParen, parseColor, parseLength, skipString, splitOn, tokenize} from './css_values.js';

// libadwaita's window style (LGPL-2.1-or-later), for when its stylesheet cannot be read.
export const FALLBACK_CSS = `
:root { --window-radius: 15px; }
.background { color: RGB(0 0 6 / 80%); }
window.csd {
    border-radius: var(--window-radius);
    outline: 1px solid rgb(255 255 255 / 7%);
    outline-offset: -1px;
    box-shadow: 0 0 14px 5px rgb(0 0 0 / 15%), 0 0 5px 2px rgb(0 0 0 / 10%), 0 0 0 1px rgb(0 0 0 / 5%);
}
window.csd:backdrop {
    box-shadow: 0 0 14px 5px transparent, 0 0 10px 5px rgb(0 0 0 / 8%), 0 0 0 1px rgb(0 0 0 / 5%);
}
window.csd.tiled, window.csd.tiled-top, window.csd.tiled-left, window.csd.tiled-right, window.csd.tiled-bottom,
window.csd.tiled:backdrop, window.csd.tiled-top:backdrop, window.csd.tiled-left:backdrop,
window.csd.tiled-right:backdrop, window.csd.tiled-bottom:backdrop {
    --window-radius: 0px;
    outline: none;
    box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 15%, transparent);
}
window.csd.maximized, window.csd.fullscreen {
    --window-radius: 0px;
    outline: none;
    box-shadow: none;
}
@media (prefers-color-scheme: dark) {
    .background { color: white; }
}
@media (prefers-contrast: more) {
    window.csd {
        outline-color: rgb(255 255 255 / 30%);
        box-shadow: 0 0 14px 5px rgb(0 0 0 / 15%), 0 0 5px 2px rgb(0 0 0 / 10%), 0 0 0 1px rgb(0 0 0 / 80%);
    }
    window.csd:backdrop {
        box-shadow: 0 0 14px 5px transparent, 0 0 10px 5px rgb(0 0 0 / 8%), 0 0 0 1px rgb(0 0 0 / 80%);
    }
}`;

const COMMENT = /\/\*[\s\S]*?\*\//g;

const OUTLINE_STYLES = new Set([
    'none', 'hidden', 'solid', 'dotted', 'dashed', 'double', 'groove', 'ridge', 'inset', 'outset',
]);

const CORNERS = [
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
];

const SIDES = ['top', 'right', 'bottom', 'left'];

const OUTLINE = ['outline-width', 'outline-style', 'outline-color'];

// Width, style and color of each side, clockwise from the top.
const BORDER_SIDES = SIDES.map(side => [`border-${side}-width`, `border-${side}-style`, `border-${side}-color`]);
const BORDER = BORDER_SIDES.flat();

const MARGINS = SIDES.map(side => `margin-${side}`);

// GTK's initial values. The window is the root, so inherit is initial too.
const INITIAL = new Map([
    ...CORNERS.map(corner => [corner, '0']),
    ...BORDER_SIDES.flatMap(([width, style, color]) => [[width, '0'], [style, 'none'], [color, 'currentColor']]),
    ...MARGINS.map(margin => [margin, '0']),
    ['outline-width', '0'],
    ['outline-style', 'none'],
    ['outline-color', 'currentColor'],
    ['outline-offset', '0'],
    ['box-shadow', 'none'],
    ['color', '#fff'],
]);

const INITIAL_COLOR = [1, 1, 1, 1];

const CSS_WIDE_KEYWORDS = /^(?:initial|inherit|unset)$/i;

/**
 * Removes comments, which GTK ignores everywhere.
 *
 * @param {string} css
 * @returns {string}
 */
export function stripComments(css) {
    return css.replace(COMMENT, ' ');
}

function parseShadowLayer(text, names) {
    const tokens = tokenize(text);
    let lengths = null;
    let inset = false;
    let color = null;
    for (let i = 0; i < tokens.length;) {
        const run = [];
        while (run.length < 4 && i < tokens.length && parseLength(tokens[i]) !== null)
            run.push(parseLength(tokens[i++]));

        if (run.length > 0) {
            if (lengths || run.length < 2 || run[2] < 0)
                return null;
            lengths = run;
        } else if (!inset && tokens[i].toLowerCase() === 'inset') {
            inset = true;
            i++;
        } else if (!color) {
            color = parseColor(tokens[i++], names);
            if (!color)
                return null;
        } else {
            return null;
        }
    }
    if (!lengths)
        return null;

    const [dx, dy, blur = 0, spread = 0] = lengths;
    return {dx, dy, blur, spread, color: color ?? names('currentColor'), inset};
}

/**
 * Parses a box-shadow into its outer layers that show.
 *
 * @param {string} value
 * @param {function(string): ?number[]} names - As for parseColor().
 * @returns {?Array<{dx: number, dy: number, blur: number, spread: number, color: number[]}>}
 */
export function parseBoxShadow(value, names) {
    if (value.trim().toLowerCase() === 'none')
        return [];

    const layers = [];
    for (const part of splitOn(value, ',')) {
        const layer = parseShadowLayer(part, names);
        if (!layer)
            return null;
        const {dx, dy, blur, spread, color, inset} = layer;
        if (!inset && color[3] > 0)
            layers.push({dx, dy, blur, spread, color});
    }
    return layers;
}

const isRadius = r => r !== null && r >= 0;

// Elliptical corners are drawn as circles of their horizontal radius.
function parseRadii(value) {
    const groups = splitOn(value, '/').map(group => tokenize(group).map(parseLength));
    if (groups.length > 2 || !groups.every(g => g.length >= 1 && g.length <= 4 && g.every(isRadius)))
        return null;
    const [a, b = a, c = a, d = b] = groups[0];
    return new Map(CORNERS.map((corner, i) => [corner, [a, b, c, d][i]]));
}

function parseCorner(value) {
    const radii = tokenize(value).map(parseLength);
    return radii.length >= 1 && radii.length <= 2 && radii.every(isRadius) ? radii[0] : null;
}

function parseWidth(value) {
    const width = parseLength(value);
    return width !== null && width >= 0 ? width : null;
}

function parseStyle(value) {
    const style = value.trim().toLowerCase();
    return OUTLINE_STYLES.has(style) ? style : null;
}

const LINE = [parseWidth, parseStyle, parseColor];
const LINE_INITIAL = ['0', 'none', 'currentColor'];

// Width, style and color in any order; what is left out is reset.
function parseLine(value, names) {
    const tokens = tokenize(value);
    if (tokens.length === 0)
        return null;
    const parts = [null, null, null];
    for (const token of tokens) {
        const read = LINE.map(parse => parse(token, names));
        const i = read.findIndex(v => v !== null);
        if (i < 0 || parts[i] !== null)
            return null;
        parts[i] = read[i];
    }
    return parts.map((part, i) => part ?? LINE[i](LINE_INITIAL[i], names));
}

// outline, border and border-top..left: longhands come as width, style, color.
const lineOf = longhands => (value, names) => {
    const parts = parseLine(value, names);
    return parts && new Map(longhands.map((name, i) => [name, parts[i % 3]]));
};

// One to four values, clockwise from the top, like margin and border-width.
const boxOf = (longhands, parse) => (value, names) => {
    const values = tokenize(value).map(token => parse(token, names));
    if (values.length < 1 || values.length > 4 || values.includes(null))
        return null;
    const [top, right = top, bottom = top, left = right] = values;
    return new Map(longhands.map((name, i) => [name, [top, right, bottom, left][i]]));
};

const LONGHANDS = new Map([
    ...CORNERS.map(corner => [corner, parseCorner]),
    ...BORDER_SIDES.flatMap(([width, style, color]) => [[width, parseWidth], [style, parseStyle], [color, parseColor]]),
    ...MARGINS.map(margin => [margin, parseLength]),
    ['outline-width', parseWidth],
    ['outline-style', parseStyle],
    ['outline-color', parseColor],
    ['outline-offset', parseLength],
    ['box-shadow', parseBoxShadow],
    ['color', parseColor],
]);

const SHORTHANDS = new Map([
    ['border-radius', {longhands: CORNERS, parse: parseRadii}],
    ['outline', {longhands: OUTLINE, parse: lineOf(OUTLINE)}],
    ['border', {longhands: BORDER, parse: lineOf(BORDER)}],
    ...SIDES.map((side, i) => [`border-${side}`, {longhands: BORDER_SIDES[i], parse: lineOf(BORDER_SIDES[i])}]),
    ...['width', 'style', 'color'].map((part, i) => {
        const longhands = BORDER_SIDES.map(side => side[i]);
        return [`border-${part}`, {longhands, parse: boxOf(longhands, LINE[i])}];
    }),
    ['margin', {longhands: MARGINS, parse: boxOf(MARGINS, parseLength)}],
    // GTK's all takes nothing but initial, inherit and unset.
    ['all', {longhands: [...LONGHANDS.keys()], parse: () => null}],
]);

const PROPERTIES = new Set([...LONGHANDS.keys(), ...SHORTHANDS.keys()]);
const COLOR_PROPERTIES = new Set(['color', 'all']);

function readLonghand(name, value, names) {
    return LONGHANDS.get(name)(value, names);
}

// The longhands a declaration sets, or null when its value cannot be read.
function readDeclaration(name, value, names) {
    const shorthand = SHORTHANDS.get(name);
    if (CSS_WIDE_KEYWORDS.test(value)) {
        const longhands = shorthand ? shorthand.longhands : [name];
        return new Map(longhands.map(longhand => [longhand, readLonghand(longhand, INITIAL.get(longhand), names)]));
    }
    if (shorthand)
        return shorthand.parse(value, names);
    const parsed = readLonghand(name, value, names);
    return parsed === null ? null : new Map([[name, parsed]]);
}

function mediaMatches(query, env) {
    const features = new Map([
        ['prefers-color-scheme', env.dark ? 'dark' : 'light'],
        ['prefers-contrast', env.highContrast ? 'more' : 'no-preference'],
    ]);
    return query.split(',').some(condition => condition.split(/\band\b/i).every(term => {
        const m = /^\s*\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)\s*$/.exec(term);
        return m !== null && features.get(m[1].toLowerCase()) === m[2].toLowerCase();
    }));
}

function matchBrace(css, open) {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        const c = css[i];
        if (c === '"' || c === "'")
            i = skipString(css, i);
        else if (c === '{')
            depth++;
        else if (c === '}' && --depth === 0)
            return i;
    }
    return -1;
}

// Rules and @define-color statements, inside the media queries that match.
function* eachRule(css, env) {
    let i = 0;
    while (i < css.length) {
        let brace = i;
        while (brace < css.length && css[brace] !== '{' && css[brace] !== ';') {
            if (css[brace] === '"' || css[brace] === "'")
                brace = skipString(css, brace);
            brace++;
        }
        const prelude = css.slice(i, brace).trim();
        if (css[brace] !== '{') {
            const define = /^@define-color\s+([\w-]+)\s+(.+)$/is.exec(prelude);
            if (define)
                yield {define: [define[1], define[2]]};
            i = brace + 1;
            continue;
        }

        const end = matchBrace(css, brace);
        if (end < 0)
            return;
        const body = css.slice(brace + 1, end);
        i = end + 1;

        const media = /^@media\b/i.exec(prelude);
        if (media && mediaMatches(prelude.slice(media[0].length), env))
            yield* eachRule(body, env);
        else if (!prelude.startsWith('@'))
            yield {prelude, body};
    }
}

function parseDeclarations(body) {
    const declarations = [];
    for (const part of splitOn(body, ';')) {
        const colon = part.indexOf(':');
        if (colon < 1)
            continue;
        const name = part.slice(0, colon).trim();
        const value = part.slice(colon + 1).trim();
        declarations.push([name.startsWith('--') ? name : name.toLowerCase(), value]);
    }
    return declarations;
}

const SIMPLE = /^(?:\*|[a-z][\w-]*|\.[\w-]+|:[\w-]+(?:\([^()]*\))?)$/i;
const PSEUDO = String.raw`:[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?`;
const COMPOUND = new RegExp(String.raw`^(\*|[a-z][\w-]*)?((?:\.[\w-]+|${PSEUDO})*)$`, 'i');
const PARTS = new RegExp(String.raw`\.[\w-]+|${PSEUDO}`, 'g');

// state holds the window's classes, whether it is in backdrop and whether the text runs right to left.
function matchSimple(simple, state) {
    const [, kind, name, argument] = /^([.:]?)([\w-]+|\*)(?:\((.*)\))?$/s.exec(simple);
    if (kind === '')
        return [name === '*' || name === 'window', name === '*' ? 0 : 1];
    if (kind === '.')
        return [state.classes.has(name), 100];
    if (name === 'not' && argument !== undefined) {
        const inner = argument.trim();
        const [matches, weight] = SIMPLE.test(inner) && !/^:not\(/i.test(inner) ? matchSimple(inner, state) : [true, 0];
        return [!matches, weight];
    }
    if (name === 'dir' && argument !== undefined)
        return [argument.trim().toLowerCase() === (state.rtl ? 'rtl' : 'ltr'), 100];
    return [argument === undefined && (name === 'root' || (name === 'backdrop' && state.backdrop)), 100];
}

// Specificity of a selector that matches the window, or -1.
function specificity(selector, state) {
    const m = COMPOUND.exec(selector.trim());
    if (!m || !m[0])
        return -1;
    let total = 0;
    for (const simple of [m[1] ?? '*', ...m[2].match(PARTS) ?? []]) {
        const [matches, weight] = matchSimple(simple, state);
        if (!matches)
            return -1;
        total += weight;
    }
    return total;
}

// The value with every var() replaced, or null when one cannot be resolved.
function substituteVars(value, vars, resolving = new Set()) {
    let result = '';
    let from = 0;
    for (const match of value.matchAll(/\bvar\(/gi)) {
        if (match.index < from)
            continue;
        const end = closingParen(value, match.index + 3);
        if (end < 0)
            return null;
        const [reference, ...fallback] = splitOn(value.slice(match.index + 4, end), ',');
        const name = reference.trim();

        let replacement = null;
        if (vars.has(name) && !resolving.has(name)) {
            resolving.add(name);
            replacement = substituteVars(vars.get(name), vars, resolving);
            resolving.delete(name);
        }
        if (replacement === null && fallback.length > 0)
            replacement = substituteVars(fallback.join(',').trim(), vars, resolving);
        if (replacement === null)
            return null;

        result += value.slice(from, match.index) + replacement;
        from = end + 1;
    }
    return result + value.slice(from);
}

// @define-color names resolve across stylesheets, the last definition winning.
function colorNames(defines, colorName, currentColor) {
    const resolving = new Set();
    const names = name => {
        if (name.toLowerCase() === 'currentcolor')
            return currentColor;
        if (!name.startsWith('@'))
            return colorName(name);

        const key = name.slice(1);
        if (!defines.has(key) || resolving.has(key))
            return null;
        resolving.add(key);
        const color = parseColor(defines.get(key), names);
        resolving.delete(key);
        return color;
    };
    return names;
}

// The window's values for one set of classes, focused or in backdrop.
function computeState(rules, state, defines, colorName) {
    const ordered = rules
        .map(rule => ({...rule, weight: Math.max(...rule.selectors.map(s => specificity(s, state)))}))
        .filter(rule => rule.weight >= 0)
        .sort((a, b) => a.sheet - b.sheet || a.weight - b.weight);

    const vars = new Map();
    for (const rule of ordered) {
        for (const [name, value] of rule.declarations) {
            if (name.startsWith('--'))
                vars.set(name, value);
        }
    }

    // As in GTK, a value that cannot be read is dropped, but one using var() becomes unset.
    const cascade = (currentColor, properties) => {
        const names = colorNames(defines, colorName, currentColor);
        const values = readDeclaration('all', 'initial', names);
        for (const rule of ordered) {
            for (const [name, value] of rule.declarations) {
                if (!properties.has(name))
                    continue;
                const usesVars = /\bvar\(/i.test(value);
                const substituted = usesVars ? substituteVars(value, vars) : value;
                let read = substituted === null ? null : readDeclaration(name, substituted, names);
                if (read === null && usesVars)
                    read = readDeclaration(name, 'unset', names);
                for (const [property, parsed] of read ?? [])
                    values.set(property, parsed);
            }
        }
        return values;
    };

    // For the window's own color, currentColor is the initial color, since the window is the root.
    const color = cascade(INITIAL_COLOR, COLOR_PROPERTIES).get('color');
    return cascade(color, PROPERTIES);
}

// GTK keeps colors outside sRGB until it draws them.
const drawn = color => color.map(v => Math.min(Math.max(v, 0), 1));

const visible = style => style !== 'none' && style !== 'hidden';

function windowLook(values) {
    // The border is drawn in a single color, the top one.
    const borderWidths = BORDER_SIDES.map(([width, style]) => visible(values.get(style)) ? values.get(width) : 0);
    return {
        radii: CORNERS.map(corner => values.get(corner)),
        margins: MARGINS.map(margin => values.get(margin)),
        borderWidths,
        borderColor: drawn(values.get(BORDER_SIDES[0][2])),
        outlineWidth: visible(values.get('outline-style')) ? values.get('outline-width') : 0,
        outlineOffset: values.get('outline-offset'),
        outlineColor: drawn(values.get('outline-color')),
        shadow: values.get('box-shadow').map(layer => ({...layer, color: drawn(layer.color)})),
    };
}

/**
 * Reads the stylesheets once, to compute the window's look the way GTK does
 * for any of its states.
 *
 * @param {string[]} sheets - Stylesheets, lowest priority first.
 * @param {object} env
 * @param {boolean} env.dark
 * @param {boolean} env.highContrast
 * @param {boolean} env.rtl - Whether text runs right to left.
 * @param {function(string): ?number[]} env.colorName - Looks up a color
 *   name, as Pango does for GTK.
 * @returns {function(string[], boolean): object} Takes the window's state
 *   classes, like maximized or tiled-left, and whether it is in backdrop.
 *   Returns its corner radii, margins, border, outline and shadow layers.
 */
export function readWindowStyle(sheets, env) {
    const rules = [];
    const defines = new Map();
    sheets.forEach((css, sheet) => {
        for (const item of eachRule(stripComments(css), env)) {
            if (item.define)
                defines.set(...item.define);
            else
                rules.push({sheet, selectors: splitOn(item.prelude, ','), declarations: parseDeclarations(item.body)});
        }
    });

    const looks = new Map();
    return (classes, backdrop) => {
        const key = `${[...classes].sort().join(' ')}${backdrop ? ':backdrop' : ''}`;
        if (!looks.has(key)) {
            // A libadwaita window is the root node, with these classes.
            const state = {classes: new Set(['background', 'csd', ...classes]), backdrop, rtl: env.rtl};
            looks.set(key, windowLook(computeState(rules, state, defines, env.colorName)));
        }
        return looks.get(key);
    };
}
