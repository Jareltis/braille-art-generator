// SPDX-License-Identifier: GPL-3.0-or-later
// The colours of a cell.
//
// A braille cell is one glyph, so as text it carries exactly one colour however
// many of its eight dots are raised. Colour therefore never takes part in
// deciding the dots -- that stays a question about luminance -- it only tints
// what was already decided.
//
// Anywhere that has a background as well as a foreground -- the page, a PNG, an
// HTML file, a terminal -- the cell can carry two, and the unraised dots stop
// being the page showing through. That is worth a great deal: measured over six
// pictures as the mean CIE distance between a dot and the colour it should have
// been, one tint on a shared background is 24 to 36 off, and the same pattern
// with a colour of its own behind it is 4.3 to 7.9.

import { srgbToLinear, linearToSrgb } from './gamma.js';
import { CELL_H, CELL_W } from './pixels.js';

/**
 * Average colour of each cell, taken over the pixels whose dots are raised.
 *
 * Only the lit pixels, because only they are drawn: averaging in the unlit ones
 * would drag every cell toward the background and wash the whole picture out.
 * A cell with nothing raised gets its plain average, which costs nothing and
 * keeps the array meaningful if something later decides to draw it.
 *
 * The mean is taken in linear light. Averaging gamma-encoded channels is the
 * same mistake as dithering over them: the result is not the colour the eye
 * would see mixed, it is systematically too bright.
 */
export function cellColours(imageData, bits, cols, rows, wantGround = false) {
  const { width, height, data } = imageData;
  const dotsW = cols * CELL_W;
  const dotsH = rows * CELL_H;

  const lit = new Float64Array(cols * rows * 3);
  const litCount = new Uint32Array(cols * rows);
  const all = new Float64Array(cols * rows * 3);
  const allCount = new Uint32Array(cols * rows);
  const dark = wantGround ? new Float64Array(cols * rows * 3) : null;
  const darkCount = wantGround ? new Uint32Array(cols * rows) : null;

  // The raster may be larger than the grid, so a pixel is placed by the same
  // partition the reduction uses rather than by a fixed block size.
  const dotColumn = new Uint32Array(width);
  for (let x = 0; x < width; x++) dotColumn[x] = Math.min(dotsW - 1, Math.floor((x * dotsW) / width));

  for (let y = 0; y < height; y++) {
    const dotRow = Math.min(dotsH - 1, Math.floor((y * dotsH) / height));
    const cellRow = ((dotRow / CELL_H) | 0) * cols;
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      const r = srgbToLinear(data[pixel]);
      const g = srgbToLinear(data[pixel + 1]);
      const b = srgbToLinear(data[pixel + 2]);
      const cell = cellRow + ((dotColumn[x] / CELL_W) | 0);
      const at = cell * 3;

      all[at] += r; all[at + 1] += g; all[at + 2] += b;
      allCount[cell] += 1;

      if (bits[dotRow * dotsW + dotColumn[x]]) {
        lit[at] += r; lit[at + 1] += g; lit[at + 2] += b;
        litCount[cell] += 1;
      } else if (wantGround) {
        dark[at] += r; dark[at + 1] += g; dark[at + 2] += b;
        darkCount[cell] += 1;
      }
    }
  }

  const ink = new Uint8ClampedArray(cols * rows * 3);
  const ground = wantGround ? new Uint8ClampedArray(cols * rows * 3) : null;
  for (let cell = 0; cell < cols * rows; cell++) {
    const at = cell * 3;
    const source = litCount[cell] ? lit : all;
    const count = litCount[cell] || allCount[cell] || 1;
    ink[at] = linearToSrgb(source[at] / count);
    ink[at + 1] = linearToSrgb(source[at + 1] / count);
    ink[at + 2] = linearToSrgb(source[at + 2] / count);

    if (!wantGround) continue;
    // A cell with every dot raised has nothing behind it; the plain average is
    // the closest thing to the colour that would show if one appeared, and it
    // keeps the array meaningful for whoever draws it.
    const behind = darkCount[cell] ? dark : all;
    const behindCount = darkCount[cell] || allCount[cell] || 1;
    ground[at] = linearToSrgb(behind[at] / behindCount);
    ground[at + 1] = linearToSrgb(behind[at + 1] / behindCount);
    ground[at + 2] = linearToSrgb(behind[at + 2] / behindCount);
  }
  return wantGround ? { ink, ground } : ink;
}

/** `#rrggbb` for cell `index`, for CSS and for SVG. */
export function cellHex(colours, index) {
  const at = index * 3;
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(colours[at])}${hex(colours[at + 1])}${hex(colours[at + 2])}`;
}

/** Whether two cells are close enough to share one run. */
export function sameColour(colours, a, b, tolerance = 8) {
  const i = a * 3;
  const j = b * 3;
  return Math.abs(colours[i] - colours[j]) <= tolerance
    && Math.abs(colours[i + 1] - colours[j + 1]) <= tolerance
    && Math.abs(colours[i + 2] - colours[j + 2]) <= tolerance;
}

/**
 * Split a row into runs of near-enough equal colour.
 *
 * Colouring cell by cell would put one element around every glyph -- a 400x400
 * grid is 160,000 of them, which no browser lays out quickly. Neighbouring
 * cells of a photograph are usually within a few levels of each other, so runs
 * collapse that by one or two orders of magnitude at no visible cost.
 */
export function colourRuns(colours, row, cols, tolerance = 8, ground = null) {
  const runs = [];
  let start = 0;
  for (let x = 1; x <= cols; x++) {
    // Compared against the run's first cell rather than its neighbour, so a
    // run cannot drift arbitrarily far from the colour it claims. With a
    // background in play both have to match, or the run would claim one cell's
    // ink over another cell's ground.
    const alike = x < cols
      && sameColour(colours, row * cols + start, row * cols + x, tolerance)
      && (!ground || sameColour(ground, row * cols + start, row * cols + x, tolerance));
    if (alike) continue;
    runs.push({ start, end: x, index: row * cols + start });
    start = x;
  }
  return runs;
}
