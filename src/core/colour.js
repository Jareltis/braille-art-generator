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

import { lab, srgbToLinear, linearToSrgb } from './gamma.js';
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


/**
 * The colour of every dot, at dot resolution.
 *
 * The raster handed in is larger than the grid, so a dot is the average of
 * whatever fell under it -- in linear light, for the same reason every other
 * average here is.
 */
function dotColours(imageData, dotsW, dotsH) {
  const { width, height, data } = imageData;
  const sum = new Float64Array(dotsW * dotsH * 3);
  const count = new Uint32Array(dotsW * dotsH);

  const columnOf = new Uint32Array(width);
  for (let x = 0; x < width; x++) columnOf[x] = Math.min(dotsW - 1, Math.floor((x * dotsW) / width));

  for (let y = 0; y < height; y++) {
    const row = Math.min(dotsH - 1, Math.floor((y * dotsH) / height)) * dotsW;
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      const dot = row + columnOf[x];
      const at = dot * 3;
      sum[at] += srgbToLinear(data[pixel]);
      sum[at + 1] += srgbToLinear(data[pixel + 1]);
      sum[at + 2] += srgbToLinear(data[pixel + 2]);
      count[dot] += 1;
    }
  }
  return { sum, count };
}

/**
 * Let colour choose the pattern.
 *
 * Everywhere else in this app the dots answer to luminance and colour only
 * tints them afterwards. This is the one place that inverts that, and it is a
 * separate mode for exactly that reason: the art stops reading as tone and
 * becomes a mosaic of two colours per cell.
 *
 * Each cell's eight dots are split between the two colours that fit them best
 * -- k-means with k=2 in L*a*b*, started from the two furthest apart, which for
 * eight points is a handful of comparisons rather than an optimisation. The
 * brighter group is the one that gets raised, so inversion still means what it
 * means everywhere else and the art still resembles its own tone in a client
 * that has no colour at all.
 *
 * Measured against the picture as the mean CIE distance per dot: one tint on a
 * shared background is 24 to 36 out, ink and ground chosen after a luminance
 * pattern is 4.3 to 7.9, and this is 2.0 to 3.8.
 */
export function colourPattern(imageData, cols, rows, { invert = false } = {}) {
  const dotsW = cols * CELL_W;
  const dotsH = rows * CELL_H;
  const { sum, count } = dotColours(imageData, dotsW, dotsH);

  const bits = new Uint8Array(dotsW * dotsH);
  const ink = new Uint8ClampedArray(cols * rows * 3);
  const ground = new Uint8ClampedArray(cols * rows * 3);

  const linear = new Float64Array(CELL_W * CELL_H * 3);
  const places = new Float64Array(CELL_W * CELL_H * 3);
  const side = new Uint8Array(CELL_W * CELL_H);
  const at = new Uint32Array(CELL_W * CELL_H);

  for (let cell = 0; cell < cols * rows; cell++) {
    const cellX = (cell % cols) * CELL_W;
    const cellY = Math.floor(cell / cols) * CELL_H;

    for (let dy = 0, seen = 0; dy < CELL_H; dy++) {
      for (let dx = 0; dx < CELL_W; dx++, seen++) {
        const dot = (cellY + dy) * dotsW + (cellX + dx);
        at[seen] = dot;
        const n = count[dot] || 1;
        const r = sum[dot * 3] / n;
        const g = sum[dot * 3 + 1] / n;
        const b = sum[dot * 3 + 2] / n;
        linear[seen * 3] = r;
        linear[seen * 3 + 1] = g;
        linear[seen * 3 + 2] = b;
        const colour = lab(linearToSrgb(r), linearToSrgb(g), linearToSrgb(b));
        places[seen * 3] = colour[0];
        places[seen * 3 + 1] = colour[1];
        places[seen * 3 + 2] = colour[2];
      }
    }

    split(places, side);
    write(cell, at, linear, side, bits, ink, ground, invert);
  }

  return { bits, ink, ground };
}

const gap = (points, i, j) => Math.hypot(
  points[i * 3] - points[j * 3],
  points[i * 3 + 1] - points[j * 3 + 1],
  points[i * 3 + 2] - points[j * 3 + 2],
);

/** k-means with k=2 over eight points, started from the two furthest apart. */
function split(points, side) {
  const dots = side.length;
  let a = 0;
  let b = 1;
  let widest = -1;
  for (let i = 0; i < dots; i++) {
    for (let j = i + 1; j < dots; j++) {
      const apart = gap(points, i, j);
      if (apart > widest) { widest = apart; a = i; b = j; }
    }
  }

  const first = [points[a * 3], points[a * 3 + 1], points[a * 3 + 2]];
  const second = [points[b * 3], points[b * 3 + 1], points[b * 3 + 2]];
  const to = (centre, i) => Math.hypot(
    points[i * 3] - centre[0], points[i * 3 + 1] - centre[1], points[i * 3 + 2] - centre[2],
  );

  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < dots; i++) {
      const nearer = to(first, i) <= to(second, i) ? 0 : 1;
      if (nearer !== side[i]) { side[i] = nearer; moved = true; }
    }
    if (!moved && pass) break;

    for (const [want, centre] of [[0, first], [1, second]]) {
      let n = 0;
      const total = [0, 0, 0];
      for (let i = 0; i < dots; i++) {
        if (side[i] !== want) continue;
        total[0] += points[i * 3];
        total[1] += points[i * 3 + 1];
        total[2] += points[i * 3 + 2];
        n++;
      }
      if (!n) continue;
      centre[0] = total[0] / n;
      centre[1] = total[1] / n;
      centre[2] = total[2] / n;
    }
  }
}

/** The brighter group is the raised one, so inversion still means something. */
function write(cell, at, linear, side, bits, ink, ground, invert) {
  const light = [0, 0];
  const seen = [0, 0];
  const total = [[0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < side.length; i++) {
    const group = side[i];
    total[group][0] += linear[i * 3];
    total[group][1] += linear[i * 3 + 1];
    total[group][2] += linear[i * 3 + 2];
    // Rec.709, the same weights the tone path uses.
    light[group] += 0.2126 * linear[i * 3] + 0.7152 * linear[i * 3 + 1] + 0.0722 * linear[i * 3 + 2];
    seen[group] += 1;
  }

  const meanLight = [seen[0] ? light[0] / seen[0] : -1, seen[1] ? light[1] / seen[1] : -1];
  let raised = meanLight[0] >= meanLight[1] ? 0 : 1;
  if (invert) raised = 1 - raised;

  for (let i = 0; i < side.length; i++) bits[at[i]] = side[i] === raised ? 1 : 0;

  const paint = (array, group, fallback) => {
    const n = seen[group] || seen[fallback] || 1;
    const source = seen[group] ? total[group] : total[fallback];
    array[cell * 3] = linearToSrgb(source[0] / n);
    array[cell * 3 + 1] = linearToSrgb(source[1] / n);
    array[cell * 3 + 2] = linearToSrgb(source[2] / n);
  };
  paint(ink, raised, 1 - raised);
  paint(ground, 1 - raised, raised);
}
