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

import { fromLab, lab, linearToSrgb, srgbToLinear } from './gamma.js';

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

/**
 * How many cells the palette is fitted to.
 *
 * Finding eight entries does not need every cell of a four-hundred-square grid.
 * Measured against fitting all of them, a strided eight thousand give a palette
 * no worse -- 11.64 against 11.77 mean deltaE, the sampled one slightly ahead --
 * and turn 311 ms into 15 ms on the largest grid this app will draw.
 */
const SAMPLE_CAP = 8000;

/** How many times the entries may move. Twelve is past settling on every
 *  picture measured; stopping at four costs 0.13 of error. */
const REFINE_ROUNDS = 12;

/** Every nth cell, so the palette answers to the whole picture rather than to
 *  its first corner -- and by stride rather than at random, because the same
 *  picture has to give the same palette every time. */
function thin(colours, cap) {
  const cells = colours.length / 3;
  if (cells <= cap) return colours;
  const step = cells / cap;
  const out = new Uint8ClampedArray(cap * 3);
  for (let i = 0; i < cap; i++) {
    const from = Math.floor(i * step) * 3;
    out[i * 3] = colours[from];
    out[i * 3 + 1] = colours[from + 1];
    out[i * 3 + 2] = colours[from + 2];
  }
  return out;
}

/** The same colours in L*a*b*, worked out once: the fitting below reads them
 *  once per entry per round. */
function labsOf(colours) {
  const out = new Float32Array(colours.length);
  for (let cell = 0; cell * 3 < colours.length; cell++) {
    const at = cell * 3;
    const parts = lab(colours[at], colours[at + 1], colours[at + 2]);
    out[at] = parts[0];
    out[at + 1] = parts[1];
    out[at + 2] = parts[2];
  }
  return out;
}

/**
 * Move every entry to the middle of the colours it caught, and do it again.
 *
 * Median cut chooses boxes and then puts an entry at the average of each. It
 * never asks the question after that one: given where the entries ended up,
 * which colours actually belong to which, and is that entry still in the middle
 * of them? Lloyd's iteration asks exactly that, and measured over six pictures
 * at six grid sizes it takes a tenth off the error -- 12.91 to 11.64 mean
 * deltaE, better on 36 cases out of 36, worse on none.
 *
 * The middle of a cluster is its mean in L*a*b*, not in linear light. That
 * looks like a contradiction of the rule this project keeps everywhere else and
 * is not: averaging light is right when the answer has to give off the light of
 * what it stands for, which is what a cell's own colour does. Here the answer
 * has to sit as close as it can to a set of colours in the space the distance
 * is measured in, and that is the mean in that space.
 *
 * The best round is kept rather than the last. Entries are rounded to whole
 * sRGB channels between rounds, so this is not quite the textbook iteration
 * that cannot go backwards -- and the cost is already being added up while the
 * colours are assigned, so knowing which round was best is free.
 */
function refine(palette, samples) {
  const points = labsOf(samples);
  const cells = points.length / 3;
  const count = palette.length / 3;
  let entries = palette;
  let best = palette;
  let bestCost = Infinity;

  for (let round = 0; round <= REFINE_ROUNDS; round++) {
    const centres = labsOf(entries);
    const sums = new Float64Array(count * 3);
    const caught = new Uint32Array(count);
    let cost = 0;

    for (let cell = 0; cell < cells; cell++) {
      const at = cell * 3;
      let pick = 0;
      let closest = Infinity;
      for (let entry = 0; entry < count; entry++) {
        const dl = points[at] - centres[entry * 3];
        const da = points[at + 1] - centres[entry * 3 + 1];
        const db = points[at + 2] - centres[entry * 3 + 2];
        const apart = dl * dl + da * da + db * db;
        if (apart < closest) { closest = apart; pick = entry; }
      }
      cost += closest;
      caught[pick]++;
      sums[pick * 3] += points[at];
      sums[pick * 3 + 1] += points[at + 1];
      sums[pick * 3 + 2] += points[at + 2];
    }

    if (cost < bestCost) { bestCost = cost; best = entries; }
    if (round === REFINE_ROUNDS) break;

    const moved = Uint8ClampedArray.from(entries);
    let distance = 0;
    for (let entry = 0; entry < count; entry++) {
      // An entry that caught nothing stays where it is: there is nothing to
      // move it towards, and dropping it would give back fewer colours than
      // were asked for.
      if (!caught[entry]) continue;
      const at = entry * 3;
      const rgb = fromLab(sums[at] / caught[entry], sums[at + 1] / caught[entry], sums[at + 2] / caught[entry]);
      for (let channel = 0; channel < 3; channel++) {
        distance += Math.abs(rgb[channel] - moved[at + channel]);
        moved[at + channel] = rgb[channel];
      }
    }
    if (!distance) break;
    entries = moved;
  }

  return best;
}

/**
 * The palette a setting asks for, given the picture's own colours.
 *
 * Both of a cell's colours are snapped to this one palette, so both are what it
 * is fitted to: one that had only ever seen the ink could leave a cell's ground
 * on a colour that nothing in the picture is behind.
 */
export function paletteFor(kind, colours, ground = null) {
  if (kind === 'ansi256' || kind === 'ansi16') return TERMINAL_PALETTES[kind];
  const drawn = /^picture(\d+)$/.exec(kind ?? '');
  if (!drawn || !colours) return null;

  let samples = colours;
  if (ground?.length) {
    samples = new Uint8ClampedArray(colours.length + ground.length);
    samples.set(colours, 0);
    samples.set(ground, colours.length);
  }
  samples = thin(samples, SAMPLE_CAP);
  return refine(medianCut(samples, Number(drawn[1])), samples);
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
