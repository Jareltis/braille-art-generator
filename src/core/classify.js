// SPDX-License-Identifier: GPL-3.0-or-later
// What kind of picture is this?
//
// The presets already know what to do with a photograph, a drawing, a flat
// graphic and a piece of pixel art. What nobody wants to do is tell the page
// which one they brought. So the picture is measured and the answer is a guess
// with its reasons attached -- a preset, not a code path: whatever comes back
// is applied by setting the same controls a person would have set.
//
// Every threshold here was measured rather than chosen. The measurements are
// quoted beside each one, and so is the sample they came from, which is small:
// six photographs and drawings, plus synthetic pixel art, a synthetic logo and
// a synthetic line drawing, each also measured after a trip through JPEG. Three
// of the four classes therefore rest on synthetic evidence, and the thresholds
// sit in the wide middle of the gaps rather than snug against them.

import { lightness } from './gamma.js';
import { sobel } from './edges.js';

/** The four the presets cover. */
export const IMAGE_KINDS = Object.freeze(['photo', 'lineart', 'logo', 'pixel']);

/**
 * Gradient below this is flat ground, above it is a boundary.
 *
 * Photographs are almost never flat -- 13% and 19% of two landscapes -- while
 * drawn and rendered things mostly are: 80% for a line drawing, 96% for a flat
 * logo, 82% for pixel art.
 */
const FLAT = 4;
const BUSY = 40;

/**
 * Near-black and near-white, on the L* scale the eye uses.
 *
 * A drawing is ink on paper and lives at both ends: 89% of a line drawing and
 * 77% of a logo, against 0.5%-36% for every photograph measured.
 */
const DARK = 8;
const LIGHT = 92;

export function imageFeatures(imageData) {
  const { data, width, height } = imageData;
  const count = width * height;
  const light = new Float32Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    light[p] = lightness(data[i], data[i + 1], data[i + 2]);
  }
  const slope = sobel(light, width, height);

  let flat = 0, busy = 0, extremes = 0, saturation = 0;
  const seen = new Set();
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    if (slope[p] < FLAT) flat++;
    if (slope[p] > BUSY) busy++;
    const l = light[p] / 2.55;
    if (l < DARK || l > LIGHT) extremes++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const top = Math.max(r, g, b);
    saturation += top ? (top - Math.min(r, g, b)) / top : 0;
    // Five bits a channel: enough to tell a palette from a photograph, coarse
    // enough that JPEG's ringing does not invent hundreds of shades.
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  return {
    flat: flat / count,
    busy: busy / count,
    extremes: extremes / count,
    saturation: saturation / count,
    colours: seen.size / count,
    twins: twinColumns(imageData),
  };
}

/**
 * How often a column is identical to the one before it.
 *
 * Pixel art is almost always shown enlarged, and enlarging it without smoothing
 * repeats every column: 97% of them, and still 91% after the file has been
 * through JPEG. A logo's flat areas do the same thing but far less -- 45% -- and
 * a photograph essentially never: 0% to 6% across six of them.
 *
 * Regularity of the spacing was measured too, and dropped. It reads 100% on
 * clean pixel art and 0% on the same image saved as JPEG, because compression
 * scatters extra changes between the block boundaries. A feature that a single
 * save destroys is worse than no feature.
 */
function twinColumns({ data, width, height }) {
  if (width < 2) return 0;
  let twins = 0;
  for (let x = 1; x < width; x++) {
    let same = true;
    // Every third row: a column that matches on a third of its length matches,
    // and this is measured on the largest raster in the process.
    for (let y = 0; y < height && same; y += 3) {
      const here = (y * width + x) * 4;
      const before = here - 4;
      for (let channel = 0; channel < 3; channel++) {
        // Six levels of slack, which is JPEG's noise on a flat area and well
        // under the smallest step any palette uses.
        if (Math.abs(data[here + channel] - data[before + channel]) > 6) same = false;
      }
    }
    if (same) twins++;
  }
  return twins / (width - 1);
}

/**
 * Enlarged pixel art repeats its columns. Measured: 91% (after JPEG) and 97%
 * (clean) for pixel art, 45% for a logo built of flat shapes, 21% for a line
 * drawing, 0-6% for photographs. The threshold sits in the gap, nearer the
 * logo than the pixel art, because mistaking a very flat logo for pixel art
 * costs little: both want sharp scaling and no detail borrowing.
 */
const PIXEL_TWINS = 0.7;

/**
 * Ink on paper: a drawing and a logo live at the ends of the scale, photographs
 * in the middle. Measured 77%-89% against 0.5%-36%, so the threshold has room
 * on both sides.
 */
const INK_EXTREMES = 0.55;

/**
 * What separates a drawing from a logo, once both are known to be ink on paper:
 * a drawing is mostly strokes and a logo mostly fill. Measured 16% of the frame
 * answering strongly for a line drawing against 3% for a logo.
 */
const DRAWN_BUSY = 0.1;

/**
 * The kind of picture, and why.
 *
 * Returns the reasons alongside the answer so the interface can say what it
 * saw rather than pronounce. Photograph is the default and the fallback: it is
 * both the commonest thing brought here and the least damaged by being wrong,
 * since its preset changes the least.
 */
export function classifyImage(imageData) {
  const features = imageFeatures(imageData);

  let kind = 'photo';
  if (features.twins >= PIXEL_TWINS) kind = 'pixel';
  else if (features.extremes >= INK_EXTREMES) kind = features.busy >= DRAWN_BUSY ? 'lineart' : 'logo';

  return { kind, features };
}
