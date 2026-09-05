// SPDX-License-Identifier: GPL-3.0-or-later
// Separable Gaussian blur over a luma plane.

/** Normalised 1-D Gaussian taps, truncated at three sigma. */
export function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const taps = new Float32Array(radius * 2 + 1);
  const denominator = 2 * sigma * sigma;

  let sum = 0;
  for (let i = 0; i < taps.length; i++) {
    const x = i - radius;
    taps[i] = Math.exp(-(x * x) / denominator);
    sum += taps[i];
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;

  return { taps, radius };
}

/**
 * Blur in two passes rather than one square kernel: a 2-D Gaussian is the
 * product of two 1-D ones, which turns O(r^2) work per pixel into O(r).
 *
 * Edges are handled by clamping, so a flat image stays exactly flat instead of
 * darkening at the border.
 */
export function gaussianBlur(plane, width, height, sigma) {
  if (!(sigma > 0)) return Float32Array.from(plane);

  const { taps, radius } = gaussianKernel(sigma);
  const horizontal = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k > width - 1 ? width - 1 : x + k;
        acc += plane[row + xx] * taps[k + radius];
      }
      horizontal[row + x] = acc;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k > height - 1 ? height - 1 : y + k;
        acc += horizontal[yy * width + x] * taps[k + radius];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

