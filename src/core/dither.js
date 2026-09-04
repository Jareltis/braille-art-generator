// SPDX-License-Identifier: GPL-3.0-or-later
// Ways of turning a continuous luma plane into one bit per pixel.
//
// Every method takes (plane, width, height, threshold) and returns a Uint8Array
// where 1 means "bright side of the decision". Inversion is applied afterwards
// by binarize(), so these stay independent of how the dots are finally used.

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
function floydSteinberg(plane, width, height, threshold) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lit = buf[i] > threshold;
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
function atkinson(plane, width, height, threshold) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lit = buf[i] > threshold;
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
 * Ordered dithering: no error travels between pixels, the threshold itself is
 * modulated by a fixed tile. Gives a regular crosshatch instead of the organic
 * grain of error diffusion, and unlike the others it is position-independent,
 * so panning or re-cropping cannot change existing pixels.
 */
function bayer4(plane, width, height, threshold) {
  const bits = new Uint8Array(plane.length);
  for (let y = 0; y < height; y++) {
    const row = (y % 4) * 4;
    for (let x = 0; x < width; x++) {
      // (m + 0.5) / 16 - 0.5 spans -0.5..0.5; times 255 it reproduces the
      // canonical full-range ordered dither when threshold is 128.
      const bias = ((BAYER_4[row + (x % 4)] + 0.5) / 16 - 0.5) * 255;
      const i = y * width + x;
      bits[i] = plane[i] > threshold + bias ? 1 : 0;
    }
  }
  return bits;
}

/** Registry. Keys are the values stored in the UI and in saved settings. */
export const DITHER_METHODS = Object.freeze({
  'floyd-steinberg': floydSteinberg,
  atkinson,
  bayer4,
  threshold: hardThreshold,
});

export const DEFAULT_DITHER = 'floyd-steinberg';
