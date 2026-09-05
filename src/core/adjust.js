// SPDX-License-Identifier: GPL-3.0-or-later
// Tone and sharpness passes. Pure: every function returns fresh ImageData and
// leaves its input untouched, so the source pixels are only ever read.

import { gaussianBlur } from './blur.js';
import { linearToSrgb, luminance, srgbToLinear } from './gamma.js';
import { clamp255 } from './pixels.js';

export const DEFAULT_ADJUSTMENTS = Object.freeze({
  shadows: 0,     // 0..100
  highlights: 0,  // 0..100
  brightness: 0,  // -100..100
  contrast: 0,    // -100..100
  saturation: 0,  // -100..100
  sharpness: 0,   // 0..5
});

/**
 * The neighbourhood is judged on a picture this many times smaller.
 *
 * The mask only has to be smooth, and a wide blur over a two-megapixel raster
 * is the most expensive thing this project owns. Built at an eighth and blurred
 * there, the whole pass costs 15 to 36 ms.
 */
const MASK_SCALE = 8;

/**
 * What the two sliders reach at the top.
 *
 * Measured: shadows 1.2 with highlights 0.3 is the pair that cleared a global
 * lift matched to the same mean light on all four test pictures, so the useful
 * settings sit around four fifths of the shadow slider.
 */
const SHADOW_RANGE = 1.5;
const HIGHLIGHT_RANGE = 0.8;

/**
 * Shadows up and highlights down, by how bright the neighbourhood is.
 *
 * A dot is raised or it is not: the art has one bit where the photograph has
 * eight, and a picture that lives in the bottom of its range spends that bit on
 * nothing. The frame-wide curve the other sliders offer cannot fix it -- measured
 * against a global lift matched to the same mean light, the global one made two
 * of four pictures worse, trading cells that were flat black for cells that were
 * flat white. This asks something else of every pixel: not how bright it is, but
 * how bright it is next to what surrounds it.
 *
 * The gain multiplies the linear light of all three channels alike, so a lifted
 * shadow keeps its colour instead of drifting grey. The neighbourhood is a
 * fraction of the frame rather than a count of pixels, so one setting means the
 * same thing whatever size the raster happens to be.
 */
export function applyLocalTone(input, { shadows = 0, highlights = 0 } = {}) {
  const lift = (Number(shadows) || 0) / 100 * SHADOW_RANGE;
  const pull = (Number(highlights) || 0) / 100 * HIGHLIGHT_RANGE;
  if (lift <= 0 && pull <= 0) return input;

  const { width, height, data } = input;
  const w = Math.max(1, Math.round(width / MASK_SCALE));
  const h = Math.max(1, Math.round(height / MASK_SCALE));

  const small = new Float32Array(w * h);
  const seen = new Float32Array(w * h);
  for (let y = 0; y < height; y++) {
    const row = Math.min(h - 1, Math.floor(y / MASK_SCALE)) * w;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const cell = row + Math.min(w - 1, Math.floor(x / MASK_SCALE));
      small[cell] += luminance(data[at], data[at + 1], data[at + 2]) / 255;
      seen[cell]++;
    }
  }
  for (let i = 0; i < small.length; i++) small[i] /= seen[i] || 1;

  const mask = gaussianBlur(small, w, h, Math.max(2, Math.sqrt(w * h) / 14));

  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(h - 1, y / MASK_SCALE);
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(w - 1, x / MASK_SCALE);
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      // Read between the mask's samples rather than in blocks: a step in the
      // gain shows as a rectangle, and the mask is an eighth of what it steers.
      const top = mask[y0 * w + x0] * (1 - tx) + mask[y0 * w + x1] * tx;
      const bottom = mask[y1 * w + x0] * (1 - tx) + mask[y1 * w + x1] * tx;
      const around = Math.min(1, Math.max(0, top * (1 - ty) + bottom * ty));

      // Cubed at both ends, so the middle of the range is left alone. Measured
      // against squared and against fourth and sixth powers on four pictures:
      // cubed is the best on average and the worst on none, and it is the
      // gentlest that keeps a lit sky out of the shadow slider's reach -- at a
      // neighbourhood of 0.64 the square still adds a fifth of the light.
      const gain = (1 + lift * (1 - around) ** 3) * (1 - pull * around ** 3);

      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        out.data[at + channel] = clamp255(Math.round(linearToSrgb(srgbToLinear(data[at + channel]) * gain)));
      }
      out.data[at + 3] = data[at + 3];
    }
  }
  return out;
}

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

/**
 * Full adjustment chain.
 *
 * The local pass goes first, on the pixels as they arrived: it answers what the
 * scene was, and its mask would otherwise be reading the person's own curve
 * back to itself. Then taste -- brightness, contrast, saturation -- and
 * sharpening last, on already-toned pixels.
 */
export function applyAdjustments(input, params = DEFAULT_ADJUSTMENTS) {
  return applySharpen(applyTone(applyLocalTone(input, params), params), params.sharpness);
}
