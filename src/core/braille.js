// SPDX-License-Identifier: GPL-3.0-or-later
// The encoder. No DOM, no canvas: ImageData in, text out.

import { lightness, luminance, thresholdToLinear } from './gamma.js';
import { DITHER_METHODS, DEFAULT_DITHER } from './dither.js';
import { applyEdges } from './edges.js';

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
export const DOT_BITS = Object.freeze([
  Object.freeze([0, 1, 2, 6]), // dots 1, 2, 3, 7
  Object.freeze([3, 4, 5, 7]), // dots 4, 5, 6, 8
]);

function samplePlane(imageData, convert) {
  const { data } = imageData;
  const plane = new Float32Array(imageData.width * imageData.height);
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    plane[p] = convert(data[i], data[i + 1], data[i + 2]);
  }
  return plane;
}

/**
 * Linear light, which is what dot coverage reproduces: half the dots lit emits
 * half the light, so the fraction that renders a tone is its linear luminance.
 */
export const toLuminance = (imageData) => samplePlane(imageData, luminance);

/** Perceptual lightness, which is where edge detection belongs -- see ./gamma.js. */
export const toLightness = (imageData) => samplePlane(imageData, lightness);

/**
 * The plane the encoder will actually threshold, and the units it is in.
 *
 * Tone and line want different spaces, and the choice decides how the threshold
 * control has to be read, so both are settled in one place rather than at each
 * call site.
 */
export function tonePlane(imageData, options = {}) {
  const edge = options.edge;
  const drawingLines = edge && edge.mode && edge.mode !== 'none' && (edge.amount ?? 1) > 0;

  if (!drawingLines) {
    return { plane: toLuminance(imageData), linear: true };
  }
  // Line strength is not a light measurement, so no gamma applies to it, and
  // the tone it is mixed with is perceptual for the same reason.
  const lines = applyEdges(toLightness(imageData), imageData.width, imageData.height, edge);
  return { plane: lines, linear: false };
}

/** The threshold control is in sRGB; a linear plane needs it converted. */
export const thresholdFor = (threshold, linear) =>
  (linear ? thresholdToLinear(threshold) : threshold);

/**
 * Luma plane to one bit per pixel, 1 meaning "dot raised".
 *
 * The chosen method decides which pixels land on the bright side; inversion is
 * applied here afterwards, so no dithering method has to know about it.
 */
export function binarize(plane, width, height, { threshold = 128, neutral = threshold, invert = false, method = DEFAULT_DITHER } = {}) {
  const dither = DITHER_METHODS[method];
  if (!dither) throw new RangeError(`unknown dither method: ${method}`);

  const bits = dither(plane, width, height, threshold, neutral);
  if (invert) {
    for (let i = 0; i < bits.length; i++) bits[i] ^= 1;
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
  const { width, height } = imageData;
  const cols = width / CELL_W;
  const rows = height / CELL_H;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new RangeError(
      `image must be a multiple of ${CELL_W}x${CELL_H}, got ${width}x${height}`,
    );
  }
  const { plane, linear } = tonePlane(imageData, options);
  const threshold = thresholdFor(options.threshold ?? 128, linear);
  // Where the control sits when centred, so a method that picks its own
  // threshold knows what "no adjustment" means in the plane's units.
  const neutral = thresholdFor(128, linear);
  return bitsToBraille(binarize(plane, width, height, { ...options, threshold, neutral }), cols, rows);
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
