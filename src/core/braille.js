// SPDX-License-Identifier: GPL-3.0-or-later
// The encoder. No DOM, no canvas: ImageData in, text out.

import { luma } from './pixels.js';

/**
 * U+2800 BRAILLE PATTERN BLANK. An empty cell is still a braille glyph rather
 * than an ASCII space, so chat clients cannot collapse or trim it and the art
 * keeps its alignment when pasted.
 */
export const BRAILLE_BLANK = 0x2800;

export const CELL_W = 2;
export const CELL_H = 4;

/**
 * Bit index of each dot, addressed as DOT_BITS[column][row].
 *
 * Unicode numbers the dots of a cell
 *
 *     1  4
 *     2  5
 *     3  6
 *     7  8
 *
 * and places dot N at bit N-1 of the offset from U+2800.
 */
const DOT_BITS = Object.freeze([
  Object.freeze([0, 1, 2, 6]), // dots 1, 2, 3, 7
  Object.freeze([3, 4, 5, 7]), // dots 4, 5, 6, 8
]);

export const BINARIZE_METHODS = Object.freeze(['threshold']);

/** ImageData to one luma sample per pixel, 0..255. */
export function toLuma(imageData) {
  const { data } = imageData;
  const plane = new Float32Array(imageData.width * imageData.height);
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    plane[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return plane;
}

/**
 * Luma plane to one bit per pixel, 1 meaning "dot raised".
 *
 * Dithering (Floyd-Steinberg, Atkinson, Bayer) plugs in here in 0.2; `method`
 * exists now so callers are already written against the final shape.
 */
export function binarize(plane, { threshold = 128, invert = false, method = 'threshold' } = {}) {
  if (!BINARIZE_METHODS.includes(method)) {
    throw new RangeError(`unknown binarize method: ${method}`);
  }
  const bits = new Uint8Array(plane.length);
  for (let p = 0; p < plane.length; p++) {
    const lit = plane[p] > threshold;
    bits[p] = (invert ? !lit : lit) ? 1 : 0;
  }
  return bits;
}

/** Bit plane of (cols*2 by rows*4) to braille text, rows joined by newlines. */
export function bitsToBraille(bits, cols, rows) {
  const stride = cols * CELL_W;
  const lines = new Array(rows);
  for (let cy = 0; cy < rows; cy++) {
    let line = '';
    for (let cx = 0; cx < cols; cx++) {
      let mask = 0;
      for (let c = 0; c < CELL_W; c++) {
        for (let r = 0; r < CELL_H; r++) {
          if (bits[(cy * CELL_H + r) * stride + (cx * CELL_W + c)]) {
            mask |= 1 << DOT_BITS[c][r];
          }
        }
      }
      line += String.fromCharCode(BRAILLE_BLANK + mask);
    }
    lines[cy] = line;
  }
  return lines.join('\n');
}

/**
 * ImageData sized exactly (cols*2 by rows*4) to braille text.
 *
 * The caller produces that exact size; refusing anything else keeps the cell
 * grid unambiguous and stops silent cropping of a trailing partial row.
 */
export function imageDataToBraille(imageData, options = {}) {
  const cols = imageData.width / CELL_W;
  const rows = imageData.height / CELL_H;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new RangeError(
      `image must be a multiple of ${CELL_W}x${CELL_H}, got ${imageData.width}x${imageData.height}`,
    );
  }
  return bitsToBraille(binarize(toLuma(imageData), options), cols, rows);
}

/**
 * How many rows keep the source proportions on screen.
 *
 * `cellAspect` is a glyph's rendered advance width divided by its line height.
 * Measure it from the element the art will live in rather than assuming a
 * value, or the output comes out stretched.
 */
export function rowsForAspect(cols, srcW, srcH, cellAspect) {
  return Math.max(1, Math.round(cols * (srcH / srcW) * cellAspect));
}
