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
export const DIFFUSING = Object.freeze(new Set(['floyd-steinberg', 'atkinson', 'ostromoukhov']));

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
    // Turn at each end rather than flying back. Always sending the error the
    // same way leaves it drifting that way too, and the drift shows as fine
    // horizontal streaks through the mid-tones -- plain to see on a hillside.
    // Alternating the direction cancels the bias between one row and the next.
    const ahead = y & 1 ? -1 : 1;
    for (let step = 0; step < width; step++) {
      const x = ahead > 0 ? step : width - 1 - step;
      const i = y * width + x;
      const lit = buf[i] > threshold + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const err = buf[i] - (lit ? 255 : 0);

      const nextTo = x + ahead;
      const behind = x - ahead;
      if (nextTo >= 0 && nextTo < width) buf[i + ahead] += err * 7 / 16;
      if (y + 1 < height) {
        if (behind >= 0 && behind < width) buf[i + width - ahead] += err * 3 / 16;
        buf[i + width] += err * 5 / 16;
        if (nextTo >= 0 && nextTo < width) buf[i + width + ahead] += err * 1 / 16;
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
    const ahead = y & 1 ? -1 : 1;   // see floydSteinberg for why
    for (let step = 0; step < width; step++) {
      const x = ahead > 0 ? step : width - 1 - step;
      const i = y * width + x;
      const lit = buf[i] > threshold + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const share = (buf[i] - (lit ? 255 : 0)) / 8;

      const one = x + ahead;
      const two = x + ahead * 2;
      const back = x - ahead;
      if (one >= 0 && one < width) buf[i + ahead] += share;
      if (two >= 0 && two < width) buf[i + ahead * 2] += share;
      if (y + 1 < height) {
        if (back >= 0 && back < width) buf[i + width - ahead] += share;
        buf[i + width] += share;
        if (one >= 0 && one < width) buf[i + width + ahead] += share;
      }
      if (y + 2 < height) buf[i + 2 * width] += share;
    }
  }
  return bits;
}

/**
 * Ostromoukhov's distribution coefficients, Appendix I of the 2001 paper.
 *
 * Three per tone level rather than Floyd-Steinberg's four fixed ones: to the
 * right, to the lower left, and below. Each triple was found off-line by
 * pushing the Fourier spectrum of the resulting pattern towards blue noise at
 * that tone, which is why they cannot be derived here and are copied instead.
 *
 * Levels 0 to 127 only; above that the set for 255 minus the level is used, as
 * the paper specifies. The numbers are weights, not fractions -- each triple is
 * divided by its own sum when it is used.
 */
// A typed array cannot be frozen, and does not need to be: it is never written to.
const OSTROMOUKHOV = new Int32Array([
  13, 0, 5, 13, 0, 5, 21, 0, 10, 7, 0, 4,   // 0-3
  8, 0, 5, 47, 3, 28, 23, 3, 13, 15, 3, 8,   // 4-7
  22, 6, 11, 43, 15, 20, 7, 3, 3, 501, 224, 211,   // 8-11
  249, 116, 103, 165, 80, 67, 123, 62, 49, 489, 256, 191,   // 12-15
  81, 44, 31, 483, 272, 181, 60, 35, 22, 53, 32, 19,   // 16-19
  237, 148, 83, 471, 304, 161, 3, 2, 1, 481, 314, 185,   // 20-23
  354, 226, 155, 1389, 866, 685, 227, 138, 125, 267, 158, 163,   // 24-27
  327, 188, 220, 61, 34, 45, 627, 338, 505, 1227, 638, 1075,   // 28-31
  20, 10, 19, 1937, 1000, 1767, 977, 520, 855, 657, 360, 551,   // 32-35
  71, 40, 57, 2005, 1160, 1539, 337, 200, 247, 2039, 1240, 1425,   // 36-39
  257, 160, 171, 691, 440, 437, 1045, 680, 627, 301, 200, 171,   // 40-43
  177, 120, 95, 2141, 1480, 1083, 1079, 760, 513, 725, 520, 323,   // 44-47
  137, 100, 57, 2209, 1640, 855, 53, 40, 19, 2243, 1720, 741,   // 48-51
  565, 440, 171, 759, 600, 209, 1147, 920, 285, 2311, 1880, 513,   // 52-55
  97, 80, 19, 335, 280, 57, 1181, 1000, 171, 793, 680, 95,   // 56-59
  599, 520, 57, 2413, 2120, 171, 405, 360, 19, 2447, 2200, 57,   // 60-63
  11, 10, 0, 158, 151, 3, 178, 179, 7, 1030, 1091, 63,   // 64-67
  248, 277, 21, 318, 375, 35, 458, 571, 63, 878, 1159, 147,   // 68-71
  5, 7, 1, 172, 181, 37, 97, 76, 22, 72, 41, 17,   // 72-75
  119, 47, 29, 4, 1, 1, 4, 1, 1, 4, 1, 1,   // 76-79
  4, 1, 1, 4, 1, 1, 4, 1, 1, 4, 1, 1,   // 80-83
  4, 1, 1, 4, 1, 1, 65, 18, 17, 95, 29, 26,   // 84-87
  185, 62, 53, 30, 11, 9, 35, 14, 11, 85, 37, 28,   // 88-91
  55, 26, 19, 80, 41, 29, 155, 86, 59, 5, 3, 2,   // 92-95
  5, 3, 2, 5, 3, 2, 5, 3, 2, 5, 3, 2,   // 96-99
  5, 3, 2, 5, 3, 2, 5, 3, 2, 5, 3, 2,   // 100-103
  5, 3, 2, 5, 3, 2, 5, 3, 2, 5, 3, 2,   // 104-107
  305, 176, 119, 155, 86, 59, 105, 56, 39, 80, 41, 29,   // 108-111
  65, 32, 23, 55, 26, 19, 335, 152, 113, 85, 37, 28,   // 112-115
  115, 48, 37, 35, 14, 11, 355, 136, 109, 30, 11, 9,   // 116-119
  365, 128, 107, 185, 62, 53, 25, 8, 7, 95, 29, 26,   // 120-123
  385, 112, 103, 65, 18, 17, 395, 104, 101, 4, 1, 1,   // 124-127
]);

/**
 * The same table as fractions, worked out once.
 *
 * Each triple is divided by its own sum where it is used, and doing that per
 * pixel doubled the cost of the method for nothing: the sums never change.
 */
const OSTROMOUKHOV_SHARE = (() => {
  const shares = new Float32Array(OSTROMOUKHOV.length);
  for (let level = 0; level < 128; level++) {
    const at = level * 3;
    const total = OSTROMOUKHOV[at] + OSTROMOUKHOV[at + 1] + OSTROMOUKHOV[at + 2];
    if (total <= 0) continue;
    shares[at] = OSTROMOUKHOV[at] / total;
    shares[at + 1] = OSTROMOUKHOV[at + 1] / total;
    shares[at + 2] = OSTROMOUKHOV[at + 2] / total;
  }
  return shares;
})();

/**
 * Error diffusion with coefficients that change with the tone.
 *
 * Floyd-Steinberg spreads its error the same way whatever the tone is, and in
 * the highlights and shadows that produces the patterns the trade calls worms.
 * These coefficients were fitted per level so the pattern comes out close to
 * blue noise across the whole range, which the paper's own comparison makes
 * against serpentine Floyd-Steinberg -- the thing this app does already.
 *
 * The level is looked up from the picture's own value rather than from the
 * value plus its accumulated error: the coefficients belong to the tone being
 * drawn, and letting the error choose them would make that choice jitter.
 */
function ostromoukhov(plane, width, height, threshold, neutral = threshold, bias = null) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    const ahead = y & 1 ? -1 : 1;
    for (let step = 0; step < width; step++) {
      const x = ahead > 0 ? step : width - 1 - step;
      const i = y * width + x;
      const lit = buf[i] > threshold + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const err = buf[i] - (lit ? 255 : 0);

      const level = plane[i] < 0 ? 0 : plane[i] > 255 ? 255 : Math.round(plane[i]);
      const at = (level < 128 ? level : 255 - level) * 3;

      const nextTo = x + ahead;
      const behind = x - ahead;
      if (nextTo >= 0 && nextTo < width) buf[i + ahead] += err * OSTROMOUKHOV_SHARE[at];
      if (y + 1 < height) {
        if (behind >= 0 && behind < width) buf[i + width - ahead] += err * OSTROMOUKHOV_SHARE[at + 1];
        buf[i + width] += err * OSTROMOUKHOV_SHARE[at + 2];
      }
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
  ostromoukhov,
  atkinson,
  bluenoise: blueNoise,
  bayer4,
  sauvola,
  threshold: hardThreshold,
});

/**
 * What a picture gets when nothing is chosen.
 *
 * Measured on four pictures at sixty columns, the variable coefficients beat
 * Floyd-Steinberg on every one -- 0.901 to 0.907 on a landscape, 0.841 to 0.852
 * on a forest -- and cost nothing worth counting at these sizes. Floyd is still
 * on the list, and a link saved with it still asks for it.
 */
export const DEFAULT_DITHER = 'ostromoukhov';
