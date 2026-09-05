// SPDX-License-Identifier: GPL-3.0-or-later
// Fewer colours, on purpose.
//
// Colour leaves here in two directions. One is a terminal, which may only have
// 256 entries or 16, and where sending twenty-four-bit codes to something that
// cannot read them gets the escape sequences printed as text. The other is
// taste: a picture cut to eight colours reads as a deliberate thing rather than
// as a photograph that lost.
//
// Both are the same operation -- snap every cell to the nearest entry of some
// palette -- so they are one control and one code path. What differs is only
// where the palette comes from: fixed for a terminal, drawn from the picture
// otherwise.

import { lab, linearToSrgb, srgbToLinear } from './gamma.js';

/** What the control can be set to. `full` means no snapping at all. */
export const PALETTES = Object.freeze(['full', 'ansi256', 'ansi16', 'picture8', 'picture4', 'picture2']);

/**
 * The sixteen every terminal has had since the VGA, in the order the escape
 * codes number them.
 */
const BASIC_16 = Object.freeze([
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]);

/** The six levels of the xterm colour cube. Not evenly spaced, and never were. */
const CUBE = Object.freeze([0, 95, 135, 175, 215, 255]);

function buildXterm256() {
  const entries = BASIC_16.map((rgb) => [...rgb]);
  for (const r of CUBE) for (const g of CUBE) for (const b of CUBE) entries.push([r, g, b]);
  // Twenty-four greys, deliberately missing both ends: black and white are
  // already in the first sixteen.
  for (let step = 0; step < 24; step++) {
    const level = 8 + step * 10;
    entries.push([level, level, level]);
  }
  return entries;
}

const XTERM_256 = Object.freeze(buildXterm256().map(Object.freeze));

/** Flat r,g,b triples, which is the shape every consumer here wants. */
const flatten = (entries) => {
  const flat = new Uint8ClampedArray(entries.length * 3);
  entries.forEach((entry, index) => {
    flat[index * 3] = entry[0];
    flat[index * 3 + 1] = entry[1];
    flat[index * 3 + 2] = entry[2];
  });
  return flat;
};

export const TERMINAL_PALETTES = Object.freeze({
  ansi256: flatten(XTERM_256),
  ansi16: flatten(BASIC_16),
});

/**
 * How far apart two colours look.
 *
 * Straight distance between sRGB numbers answers a different question -- it
 * treats a step in dark green as the same size as a step in pale yellow, which
 * the eye does not. L*a*b* was built so that distance in it means roughly what
 * the eye means, so the match is made there. This is plain CIE76, not the later
 * refinements: for choosing among 256 fixed entries the difference between them
 * does not show.
 */
function distance(a, b) {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

/** Nearest entry of a palette, as an index. */
export function nearest(palette, r, g, b, cache = null) {
  const key = (r << 16) | (g << 8) | b;
  const known = cache?.get(key);
  if (known !== undefined) return known;

  const wanted = lab(r, g, b);
  let best = 0;
  let closest = Infinity;
  for (let index = 0; index * 3 < palette.length; index++) {
    const at = index * 3;
    const apart = distance(wanted, lab(palette[at], palette[at + 1], palette[at + 2]));
    if (apart < closest) { closest = apart; best = index; }
  }
  cache?.set(key, best);
  return best;
}

/**
 * A palette drawn from the picture itself, by median cut.
 *
 * Repeatedly split the box with the widest spread along that widest side. The
 * classic method, and it earns its keep here for the same reason it always
 * did: it spends entries where the colours actually are, so a picture that is
 * mostly sky and grass does not waste half its palette on the reds it lacks.
 *
 * The split is measured on sRGB channels, as the method assumes, but each
 * box's colour is averaged in linear light -- averaging gamma-encoded channels
 * gives a result systematically too bright, which is the same mistake the
 * dithering path was written to avoid.
 */
export function medianCut(colours, count) {
  const cells = Math.floor(colours.length / 3);
  if (cells === 0 || count < 1) return flatten([[0, 0, 0]]);

  let boxes = [Array.from({ length: cells }, (_, i) => i)];

  while (boxes.length < count) {
    let widest = -1;
    let choice = -1;
    let axis = 0;

    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let channel = 0; channel < 3; channel++) {
        let low = 255, high = 0;
        for (const cell of box) {
          const value = colours[cell * 3 + channel];
          if (value < low) low = value;
          if (value > high) high = value;
        }
        if (high - low > widest) { widest = high - low; choice = index; axis = channel; }
      }
    });

    // Every box is a single colour, or a single cell: nothing left to split.
    if (choice < 0 || widest <= 0) break;

    const box = boxes[choice];
    box.sort((a, b) => colours[a * 3 + axis] - colours[b * 3 + axis]);
    const middle = Math.floor(box.length / 2);
    boxes.splice(choice, 1, box.slice(0, middle), box.slice(middle));
  }

  return flatten(boxes.filter((box) => box.length).map((box) => {
    let r = 0, g = 0, b = 0;
    for (const cell of box) {
      r += srgbToLinear(colours[cell * 3]);
      g += srgbToLinear(colours[cell * 3 + 1]);
      b += srgbToLinear(colours[cell * 3 + 2]);
    }
    return [
      Math.round(linearToSrgb(r / box.length)),
      Math.round(linearToSrgb(g / box.length)),
      Math.round(linearToSrgb(b / box.length)),
    ];
  }));
}

/** The palette a setting asks for, given the picture's own colours. */
export function paletteFor(kind, colours) {
  if (kind === 'ansi256' || kind === 'ansi16') return TERMINAL_PALETTES[kind];
  const drawn = /^picture(\d+)$/.exec(kind ?? '');
  if (drawn && colours) return medianCut(colours, Number(drawn[1]));
  return null;
}

/**
 * Snap every cell to its nearest entry.
 *
 * The cache matters more than it looks: a picture has one colour per cell but
 * only a handful of distinct ones once it has been through this, and without it
 * every cell would walk all 256 entries again.
 */
export function snap(colours, palette) {
  if (!colours || !palette) return colours;
  const out = new Uint8ClampedArray(colours.length);
  const cache = new Map();
  for (let cell = 0; cell * 3 < colours.length; cell++) {
    const at = cell * 3;
    const index = nearest(palette, colours[at], colours[at + 1], colours[at + 2], cache);
    out[at] = palette[index * 3];
    out[at + 1] = palette[index * 3 + 1];
    out[at + 2] = palette[index * 3 + 2];
  }
  return out;
}

/**
 * The escape code that selects a palette entry as the foreground.
 *
 * The sixteen are the old direct codes rather than `38;5;n`, because those are
 * what a terminal with only sixteen colours understands -- naming an index it
 * does not have is how the sequence ends up printed as text.
 */
export function ansiForeground(kind, index) {
  if (kind === 'ansi16') return index < 8 ? `${30 + index}` : `${90 + index - 8}`;
  return `38;5;${index}`;
}

/**
 * The same, for what is behind the glyph.
 *
 * Backgrounds sit ten higher than foregrounds in every one of these families,
 * which is the whole of the difference: 40-47 and 100-107 for the sixteen, and
 * 48 where the foreground says 38.
 */
export function ansiBackground(kind, index) {
  if (kind === 'ansi16') return index < 8 ? `${40 + index}` : `${100 + index - 8}`;
  return `48;5;${index}`;
}
