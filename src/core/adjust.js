// SPDX-License-Identifier: GPL-3.0-or-later
// Tone and sharpness passes. Pure: every function returns fresh ImageData and
// leaves its input untouched, so the source pixels are only ever read.

import { clamp255 } from './pixels.js';

export const DEFAULT_ADJUSTMENTS = Object.freeze({
  brightness: 0,  // -100..100
  contrast: 0,    // -100..100
  saturation: 0,  // -100..100
  sharpness: 0,   // 0..5
});

/** Brightness, then contrast, then saturation, in one pass. */
export function applyTone(input, { brightness = 0, contrast = 0, saturation = 0 } = {}) {
  const { width, height, data } = input;
  const out = new ImageData(width, height);
  const dst = out.data;

  const offset = brightness * 2.55;
  const c = contrast * 2.55;
  const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));
  const satFactor = 1 + saturation / 100;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] + offset;
    let g = data[i + 1] + offset;
    let b = data[i + 2] + offset;

    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    // Pull toward / push away from the pixel's own gray.
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    dst[i] = clamp255(Math.round(gray + (r - gray) * satFactor));
    dst[i + 1] = clamp255(Math.round(gray + (g - gray) * satFactor));
    dst[i + 2] = clamp255(Math.round(gray + (b - gray) * satFactor));
    dst[i + 3] = data[i + 3];
  }
  return out;
}

/**
 * Unsharp mask over the 4-neighbourhood:
 *
 *      0    -a     0
 *     -a   1+4a   -a        kernel sum == 1
 *      0    -a     0
 *
 * The kernel must sum to 1 or the pass changes overall exposure. The previous
 * kernel summed to 1 + 2a, so at amount 5 it multiplied the image by 11 and the
 * "sharpness" slider blew everything out to white.
 *
 * Alpha is copied through rather than convolved: sharpening opacity has no
 * meaning, and doing it distorted images that carry transparency.
 */
export function applySharpen(input, amount = 0) {
  if (!(amount > 0)) return input;

  const { width: w, height: h, data: src } = input;
  const out = new ImageData(w, h);
  const dst = out.data;
  const center = 1 + 4 * amount;

  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : 0;
    const yDown = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const up = (yUp * w + x) * 4;
      const down = (yDown * w + x) * 4;
      const left = (y * w + (x > 0 ? x - 1 : 0)) * 4;
      const right = (y * w + (x < w - 1 ? x + 1 : w - 1)) * 4;

      for (let ch = 0; ch < 3; ch++) {
        const v = center * src[i + ch]
          - amount * (src[up + ch] + src[down + ch] + src[left + ch] + src[right + ch]);
        dst[i + ch] = clamp255(Math.round(v));
      }
      dst[i + 3] = src[i + 3];
    }
  }
  return out;
}

/** Full adjustment chain. Sharpening runs last, on already-toned pixels. */
export function applyAdjustments(input, params = DEFAULT_ADJUSTMENTS) {
  return applySharpen(applyTone(input, params), params.sharpness);
}
