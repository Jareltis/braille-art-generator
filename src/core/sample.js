// SPDX-License-Identifier: GPL-3.0-or-later
// Reducing a detailed raster to one value per dot.
//
// The order used to be: shrink the picture, then decide each dot from what
// survived. That throws the evidence away before the question is asked. A
// one-pixel line in a photograph becomes a tenth of a level of grey and the
// threshold never sees it -- measured, it disappeared completely.
//
// Here the reduction and the decision meet: every source pixel that falls under
// a dot is visited, and what the dot learns is not only the average but the
// extremes as well. Visiting them costs nothing extra -- the average already
// had to touch every one.

/**
 * Which output cell a source column or row belongs to.
 *
 * floor(i * out / in) partitions exactly: every source pixel lands in one cell
 * and none is counted twice, even when the ratio is not a whole number.
 */
const cellOf = (i, inSize, outSize) => Math.min(outSize - 1, Math.floor((i * outSize) / inSize));

/**
 * Mean, and the darkest and lightest value, for every cell.
 *
 * The mean is what reproduces tone; the extremes are what a thin feature lives
 * in. Which of them should speak is decided later, per cell, by how much
 * structure is there.
 */
export function reduceStats(plane, width, height, outWidth, outHeight) {
  const cells = outWidth * outHeight;
  const total = new Float64Array(cells);
  const count = new Uint32Array(cells);
  const low = new Float32Array(cells).fill(Infinity);
  const high = new Float32Array(cells).fill(-Infinity);

  const columnOf = new Uint32Array(width);
  for (let x = 0; x < width; x++) columnOf[x] = cellOf(x, width, outWidth);

  for (let y = 0; y < height; y++) {
    const row = cellOf(y, height, outHeight) * outWidth;
    const source = y * width;
    for (let x = 0; x < width; x++) {
      const value = plane[source + x];
      const cell = row + columnOf[x];
      total[cell] += value;
      count[cell] += 1;
      if (value < low[cell]) low[cell] = value;
      if (value > high[cell]) high[cell] = value;
    }
  }

  const mean = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    mean[i] = count[i] ? total[i] / count[i] : 0;
    if (!Number.isFinite(low[i])) low[i] = mean[i];
    if (!Number.isFinite(high[i])) high[i] = mean[i];
  }
  return { mean, low, high };
}

/**
 * The strongest value in each cell.
 *
 * Lines are reduced this way rather than averaged: a stroke one pixel wide is
 * the whole point of the map it came from, and averaging is precisely what
 * would erase it again.
 */
export function reduceMax(plane, width, height, outWidth, outHeight) {
  const out = new Float32Array(outWidth * outHeight);
  const columnOf = new Uint32Array(width);
  for (let x = 0; x < width; x++) columnOf[x] = cellOf(x, width, outWidth);

  for (let y = 0; y < height; y++) {
    const row = cellOf(y, height, outHeight) * outWidth;
    const source = y * width;
    for (let x = 0; x < width; x++) {
      const cell = row + columnOf[x];
      if (plane[source + x] > out[cell]) out[cell] = plane[source + x];
    }
  }
  return out;
}

/**
 * How far the gradient response has to reach before a cell counts as fully
 * structured.
 *
 * Measured rather than guessed: after a sigma-1 blur, a cell holding a
 * one-pixel line answers at about 66 and one holding nothing but noise at
 * 24-30, while a real boundary reaches 115. The separation is a factor of
 * roughly 2.4, which is enough to lean on but not enough to switch on -- hence
 * a gradual blend rather than a threshold.
 */
export const STRUCTURE_FULL = 110;

/**
 * Blend the average with the extreme, in proportion to how structured the cell
 * is.
 *
 * Where nothing is going on the mean survives untouched, so flat and noisy
 * areas keep their tone exactly. Where a feature crosses, the value is pulled
 * toward whichever extreme is further from the average -- the dark of a line on
 * white, the light of a highlight on dark.
 */
export function withDetail({ mean, low, high }, structure, strength) {
  if (!(strength > 0)) return mean;

  const out = new Float32Array(mean.length);
  for (let i = 0; i < mean.length; i++) {
    const average = mean[i];
    const coherence = Math.min(1, structure[i] / STRUCTURE_FULL);
    const darker = average - low[i];
    const lighter = high[i] - average;
    const extreme = darker > lighter ? low[i] : high[i];
    out[i] = average + strength * coherence * (extreme - average);
  }
  return out;
}
