// SPDX-License-Identifier: GPL-3.0-or-later
// Pure pixel maths. No document, no canvas -- only ImageData, which exists in
// workers too, so everything under core/ can be moved off the main thread as-is.

/** A braille cell covers this many source pixels. */
export const CELL_W = 2;
export const CELL_H = 4;

/** BT.601 luma over gamma-encoded sRGB. */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Largest size inside maxW x maxH that keeps the source ratio. Never upscales. */
export function fitWithin(srcW, srcH, maxW, maxH) {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * How much bigger than the dot grid the raster handed to the encoder may be.
 *
 * Four each way, sixteen samples for every dot, is where the extra stops
 * telling the encoder anything it did not already know.
 */
export const DETAIL_SCALE = 4;

/**
 * The least sampling worth calling sampling: two each way, four to a dot.
 *
 * The old rule was a flat two million pixels, and a flat count of pixels means
 * a different thing at every grid size -- sixteen samples per dot for a hundred
 * columns and 2.1 for four hundred, which is barely more than reading the
 * pixels straight. Measured on a 4912x7360 photograph at four hundred columns,
 * against a reference sampled as finely as the picture allows: 2.1 samples per
 * dot scores 0.9035, 4.2 scores 0.9094, 8.3 scores 0.9140 and the full sixteen
 * 0.9211, costing 290 ms, 512 ms, 935 ms and 1726 ms. The floor buys the first
 * step, which is the cheap one. The rest wants six times the time and sixty
 * megabytes of raster for another 0.012, and this project has turned down that
 * kind of trade before.
 */
const DETAIL_FLOOR = 4;

/** What the floor is not allowed to talk anyone into: twenty megabytes of
 *  ImageData is the largest grid this app will draw, and enough. */
const DETAIL_CEILING = 8_000_000;

/** And the least it will ask for, so small grids still sample generously. */
const DETAIL_BUDGET = 2_000_000;

/**
 * The raster the encoder should be handed for a given grid.
 *
 * Never larger than the source -- there is nothing in an upscale that was not
 * in the picture -- and never smaller than the dot grid itself.
 */
export function detailSize(cols, rows, sourceW, sourceH) {
  const gridW = cols * CELL_W;
  const gridH = rows * CELL_H;
  let w = Math.max(gridW, Math.min(gridW * DETAIL_SCALE, sourceW));
  let h = Math.max(gridH, Math.min(gridH * DETAIL_SCALE, sourceH));

  const budget = Math.min(DETAIL_CEILING, Math.max(DETAIL_BUDGET, gridW * gridH * DETAIL_FLOOR));
  const fit = Math.sqrt(budget / (w * h));
  if (fit < 1) {
    w = Math.max(gridW, Math.round(w * fit));
    h = Math.max(gridH, Math.round(h * fit));
  }
  return { w, h };
}
