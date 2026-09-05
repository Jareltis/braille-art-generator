// SPDX-License-Identifier: GPL-3.0-or-later
// Ways of turning a continuous luma plane into one bit per pixel.
//
// Every method takes (plane, width, height, threshold, neutral) and returns a
// Uint8Array where 1 means "bright side of the decision". Inversion is applied
// afterwards by binarize(), so these stay independent of how the dots are
// finally used.
//
// `neutral` is where the threshold control sits when it is centred, in the same
// units as the plane. Only the local method needs it: it chooses thresholds
// itself, so the control can only shift what it chose.

import { BLUE_NOISE_SIZE, blueNoiseMatrix } from './bluenoise.js';
import { gaussianBlur } from './blur.js';

/**
 * The methods that hand their error to the neighbours.
 *
 * Only these can have their threshold pushed about per pixel without the tone
 * going with it: whatever the moved threshold decides, the difference from the
 * true value is still what gets passed on, so the neighbourhood corrects it.
 * An ordered tile has no such second chance -- moving its threshold moves the
 * tone, full stop, which is the same trap the ordered methods were already
 * caught in once.
 */
export const DIFFUSING = Object.freeze(new Set(['floyd-steinberg', 'atkinson']));

/**
 * How much to lean on the threshold at an edge, per pixel.
 *
 * The classic edge enhancement for error diffusion, after Eschbach and Knox:
 * subtract a scaled high-pass of the picture from the threshold, so a pixel on
 * the bright side of an edge finds it easier to light and one on the dark side
 * harder. One multiply and one add per pixel.
 *
 * It costs faithfulness -- measured, the score against the original falls from
 * 0.89 to 0.86 as this is turned up -- and buys legibility, which that score
 * cannot see: on a graphic with lettering, the word reads at strength 1 and
 * mushes into its background at 0. So it is a control and not a default.
 */
export function edgeBias(plane, width, height, strength) {
  if (!(strength > 0)) return null;
  const soft = gaussianBlur(plane, width, height, 1.2);
  const bias = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) bias[i] = -strength * (plane[i] - soft[i]);
  return bias;
}

/** No diffusion at all: each pixel decided on its own. Best for logos and text. */
function hardThreshold(plane, width, height, threshold) {
  const bits = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) bits[i] = plane[i] > threshold ? 1 : 0;
  return bits;
}

/**
 * Floyd-Steinberg, raster order:
 *
 *          *   7/16
 *   3/16 5/16 1/16
 *
 * The error is measured against the value actually emitted, so the average
 * brightness survives whatever threshold is chosen.
 */
function floydSteinberg(plane, width, height, threshold, neutral = threshold, bias = null) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lit = buf[i] > threshold + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const err = buf[i] - (lit ? 255 : 0);

      if (x + 1 < width) buf[i + 1] += err * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += err * 3 / 16;
        buf[i + width] += err * 5 / 16;
        if (x + 1 < width) buf[i + width + 1] += err * 1 / 16;
      }
    }
  }
  return bits;
}

/**
 * Atkinson: an eighth of the error to each of six neighbours, so only 6/8 is
 * passed on at all. Losing the rest is the point -- highlights and shadows
 * clip instead of smearing, which reads better on a grid this coarse.
 *
 *        *  1/8  1/8
 *  1/8  1/8  1/8
 *       1/8
 */
function atkinson(plane, width, height, threshold, neutral = threshold, bias = null) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lit = buf[i] > threshold + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const share = (buf[i] - (lit ? 255 : 0)) / 8;

      if (x + 1 < width) buf[i + 1] += share;
      if (x + 2 < width) buf[i + 2] += share;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += share;
        buf[i + width] += share;
        if (x + 1 < width) buf[i + width + 1] += share;
      }
      if (y + 2 < height) buf[i + 2 * width] += share;
    }
  }
  return bits;
}

/** Ordered 4x4 Bayer matrix, values 0..15 in the usual recursive order. */
const BAYER_4 = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

/**
 * Ordered dithering: no error travels between pixels, the tile *is* the ladder
 * of thresholds. Gives a regular crosshatch instead of the organic grain of
 * error diffusion, and unlike the others it is position-independent, so panning
 * or re-cropping cannot change existing pixels.
 *
 * The tile spans the whole range, so a flat value lands above exactly as many
 * of its rungs as the value is bright: coverage equals the value, which is what
 * reproduces the tone. The control cannot be the centre of that ladder -- with
 * no error being fed back there is nothing to correct the bias it would add --
 * so like Sauvola it shifts the ladder instead.
 *
 * It used to centre the tile on the threshold, which was right while the plane
 * was gamma-encoded and the centred control sat at 128. Tone moved to linear
 * light in 0.9 and the centred control became 55, so the ladder was pivoting a
 * third of the way up its own range: measured, a flat linear 128 came out at
 * 81% coverage instead of 50%, and 26 came out at 38% instead of 10%. Error
 * diffusion survived that move because it feeds its error back; these have no
 * such second chance, and no test was watching them.
 */
function bayer4(plane, width, height, threshold, neutral = threshold) {
  const shift = threshold - neutral;
  const bits = new Uint8Array(plane.length);
  for (let y = 0; y < height; y++) {
    const row = (y % 4) * 4;
    for (let x = 0; x < width; x++) {
      const rung = ((BAYER_4[row + (x % 4)] + 0.5) / 16) * 255;
      const i = y * width + x;
      bits[i] = plane[i] > rung + shift ? 1 : 0;
    }
  }
  return bits;
}

/**
 * Sauvola's local threshold.
 *
 * A single number cannot serve a photograph lit from one side: whatever it is,
 * one end of the frame is crushed. This picks a threshold per pixel from the
 * mean and spread of its neighbourhood
 *
 *     T = m * (1 + K * (s / R - 1))
 *
 * so a dim corner is judged against dim surroundings. The variance term is what
 * keeps flat areas from dissolving into noise: where there is no local contrast,
 * s is small, T drops below m and the region stays whole.
 *
 * Both moments come from integral images, so the window costs four lookups
 * regardless of its size -- scanning it per pixel would be quadratic in radius.
 */
function sauvola(plane, width, height, threshold, neutral = threshold) {
  const K = 0.2;
  const R = 128;                 // the range local spread is measured against
  // A sixteenth of the shorter side was too tight. Measured on three pictures
  // at sixty columns, the score climbs steadily out to a radius of about 24 and
  // falls off past it: the landscape gained 28% between the old radius and the
  // best one, the others 4-6%. An eighth lands inside that range at every width
  // the app offers, and stays a rule rather than a number picked for one size.
  const radius = Math.max(3, Math.round(Math.min(width, height) / 8));
  const stride = width + 1;

  const sum = new Float64Array(stride * (height + 1));
  const sumSquares = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 0; x < width; x++) {
      const value = plane[y * width + x];
      rowSum += value;
      rowSquares += value * value;
      const here = (y + 1) * stride + (x + 1);
      sum[here] = sum[here - stride] + rowSum;
      sumSquares[here] = sumSquares[here - stride] + rowSquares;
    }
  }

  // The control cannot set the threshold here, so it shifts it instead.
  const shift = threshold - neutral;
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const area = (right - left + 1) * (bottom - top + 1);

      const a = top * stride + left;
      const b = top * stride + right + 1;
      const c = (bottom + 1) * stride + left;
      const d = (bottom + 1) * stride + right + 1;

      const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / area;
      const spread = Math.sqrt(Math.max(0, (sumSquares[d] - sumSquares[b] - sumSquares[c] + sumSquares[a]) / area - mean * mean));
      const local = mean * (1 + K * (spread / R - 1));

      bits[y * width + x] = plane[y * width + x] > local + shift ? 1 : 0;
    }
  }
  return bits;
}

/**
 * Blue-noise ordered dithering.
 *
 * Same shape as bayer4 -- a tile of thresholds indexed by position, so nothing
 * travels between pixels and the result never shifts when the image is re-cropped.
 * The difference is the tile: void-and-cluster spreads its thresholds so that no
 * scale carries a repeating structure, which removes the crosshatch a Bayer
 * matrix leaves without giving up the position-only property.
 */
function blueNoise(plane, width, height, threshold, neutral = threshold) {
  const matrix = blueNoiseMatrix();
  const shift = threshold - neutral;
  const bits = new Uint8Array(plane.length);
  for (let y = 0; y < height; y++) {
    const row = (y % BLUE_NOISE_SIZE) * BLUE_NOISE_SIZE;
    for (let x = 0; x < width; x++) {
      // The matrix is already 0..1 across its whole tile, so it is the ladder
      // itself. See bayer4 for why the control shifts it rather than centring it.
      const rung = matrix[row + (x % BLUE_NOISE_SIZE)] * 255;
      const i = y * width + x;
      bits[i] = plane[i] > rung + shift ? 1 : 0;
    }
  }
  return bits;
}

/** Registry. Keys are the values stored in the UI and in saved settings. */
export const DITHER_METHODS = Object.freeze({
  'floyd-steinberg': floydSteinberg,
  atkinson,
  bluenoise: blueNoise,
  bayer4,
  sauvola,
  threshold: hardThreshold,
});

export const DEFAULT_DITHER = 'floyd-steinberg';
