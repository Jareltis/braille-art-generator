// SPDX-License-Identifier: GPL-3.0-or-later
// One colour per cell.
//
// A braille cell is a single glyph, so it can carry exactly one colour however
// many of its eight dots are raised. Colour therefore never takes part in
// deciding the dots -- that stays a question about luminance -- it only tints
// what was already decided.

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
export function cellColours(imageData, bits, cols, rows) {
  const { width, data } = imageData;
  const colours = new Uint8ClampedArray(cols * rows * 3);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let lit = 0;
      let rAll = 0;
      let gAll = 0;
      let bAll = 0;

      for (let dy = 0; dy < CELL_H; dy++) {
        for (let dx = 0; dx < CELL_W; dx++) {
          const x = cx * CELL_W + dx;
          const y = cy * CELL_H + dy;
          const pixel = (y * width + x) * 4;
          const lr = srgbToLinear(data[pixel]);
          const lg = srgbToLinear(data[pixel + 1]);
          const lb = srgbToLinear(data[pixel + 2]);

          rAll += lr; gAll += lg; bAll += lb;
          if (bits[y * width + x]) {
            r += lr; g += lg; b += lb;
            lit++;
          }
        }
      }

      const count = lit || CELL_W * CELL_H;
      const source = lit ? [r, g, b] : [rAll, gAll, bAll];
      const at = (cy * cols + cx) * 3;
      colours[at] = linearToSrgb(source[0] / count);
      colours[at + 1] = linearToSrgb(source[1] / count);
      colours[at + 2] = linearToSrgb(source[2] / count);
    }
  }
  return colours;
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
export function colourRuns(colours, row, cols, tolerance = 8) {
  const runs = [];
  let start = 0;
  for (let x = 1; x <= cols; x++) {
    // Compared against the run's first cell rather than its neighbour, so a
    // run cannot drift arbitrarily far from the colour it claims.
    if (x < cols && sameColour(colours, row * cols + start, row * cols + x, tolerance)) continue;
    runs.push({ start, end: x, index: row * cols + start });
    start = x;
  }
  return runs;
}
