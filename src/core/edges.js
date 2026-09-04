// SPDX-License-Identifier: GPL-3.0-or-later
// Turning tone into line.
//
// Both detectors return a plane in the same 0..255 units as luma, where a high
// value means "there is a line here". That matches the polarity of the tone
// path -- bright becomes a dot -- so the rest of the pipeline needs no special
// case, and the two can simply be mixed.

import { gaussianBlur } from './blur.js';

export const EDGE_MODES = Object.freeze(['none', 'sobel', 'xdog']);

/**
 * Sobel gradient magnitude.
 *
 * Fast and predictable, but it answers "how steep is it here", so a soft edge
 * comes back as a wide band rather than a line. Good for hard-edged art and for
 * seeing quickly what the image has; xdog is the one that draws.
 */
export function sobel(plane, width, height) {
  const out = new Float32Array(plane.length);
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
    const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
    return plane[cy * width + cx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      // Peak magnitude of either axis is 4*255, so a quarter puts it back in range.
      const magnitude = Math.hypot(gx, gy) / 4;
      out[y * width + x] = magnitude > 255 ? 255 : magnitude;
    }
  }
  return out;
}

// Difference-of-Gaussians with a soft threshold, after Winnemoeller. Only sigma
// is worth exposing; the rest behave for line art as they are.
const K = 1.6;    // ratio between the two blurs
const TAU = 1;    // how much of the wider blur is subtracted
const PHI = 60;   // steepness of the ink ramp
//
// TAU is deliberately 1 rather than the ~0.98 the paper uses for stylisation.
// Below 1 the flat-field response is l*(1-TAU) -- proportional to brightness --
// so an even mid-grey answers with ink and dark areas silt up with strokes that
// are not edges. At exactly 1 a flat region cancels to zero at any level, and
// the detector reports lines and nothing else. Tone comes back through the
// fill/line mix instead, where it can be dialled.

/**
 * XDoG: the difference between two Gaussians, run through a soft threshold.
 *
 * Where Sobel reports a slope, this reports a *stroke* -- the difference goes
 * negative only on the dark side of an edge, so the result is a one-sided line
 * of varying weight rather than a band straddling the boundary. That variation
 * is what the 2x4 cell grid renders well, and it is why this suits line art,
 * comics and drawings.
 */
export function xdog(plane, width, height, sigma) {
  const near = gaussianBlur(plane, width, height, sigma);
  const far = gaussianBlur(plane, width, height, sigma * K);
  const out = new Float32Array(plane.length);

  for (let i = 0; i < plane.length; i++) {
    const difference = (near[i] - TAU * far[i]) / 255; // work in 0..1
    // Only the dark side of an edge goes negative, and that is where ink lands.
    // The ramp is soft rather than a hard cut so stroke weight varies with edge
    // strength, which is the part a 2x4 cell grid can actually show.
    const ink = difference >= 0 ? 0 : -Math.tanh(PHI * difference);
    out[i] = ink > 1 ? 255 : ink * 255;
  }
  return out;
}

/**
 * Replace or mix the tone plane with a line plane.
 *
 * `amount` is the slider between fill and lines: 0 leaves the tone untouched,
 * 1 is pure line, and in between the two are blended before dithering, so a
 * drawing can keep its shading and still gain defined edges.
 */
export function applyEdges(plane, width, height, { mode = 'none', amount = 1, radius = 1 } = {}) {
  if (mode === 'none' || !(amount > 0)) return plane;
  if (!EDGE_MODES.includes(mode)) throw new RangeError(`unknown edge mode: ${mode}`);

  // Both detectors amplify noise, so smooth first. For xdog this same radius is
  // the stroke width; for sobel it is purely denoising.
  const lines = mode === 'sobel'
    ? sobel(gaussianBlur(plane, width, height, radius), width, height)
    : xdog(plane, width, height, radius);

  if (amount >= 1) return lines;

  const out = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) {
    out[i] = plane[i] * (1 - amount) + lines[i] * amount;
  }
  return out;
}
