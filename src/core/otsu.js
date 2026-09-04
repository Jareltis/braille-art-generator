// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Otsu's method: the threshold that maximises the variance *between* the two
 * groups it splits the histogram into, which is the same as minimising the
 * variance inside them.
 *
 * Returns 0..255. Works on the same luma plane the dithering methods consume,
 * so "pick for me" lands on the value the image is actually asking for instead
 * of leaving the user to hunt for it on the slider.
 */
export function otsuThreshold(plane) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < plane.length; i++) {
    const v = Math.round(plane[i]);
    histogram[v < 0 ? 0 : v > 255 ? 255 : v]++;
  }

  const total = plane.length;
  let weightedSum = 0;
  for (let v = 0; v < 256; v++) weightedSum += v * histogram[v];

  let belowWeight = 0;
  let belowSum = 0;
  let best = 128;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    belowWeight += histogram[t];
    if (belowWeight === 0) continue;
    const aboveWeight = total - belowWeight;
    if (aboveWeight === 0) break;

    belowSum += t * histogram[t];
    const meanBelow = belowSum / belowWeight;
    const meanAbove = (weightedSum - belowSum) / aboveWeight;
    const between = belowWeight * aboveWeight * (meanBelow - meanAbove) ** 2;

    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}
