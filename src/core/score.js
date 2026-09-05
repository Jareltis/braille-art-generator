// SPDX-License-Identifier: GPL-3.0-or-later
// How much does this art still look like the picture?
//
// The question a person answers by leaning back from the screen. Up close the
// art is a field of dots; at a distance the dots merge and either the picture
// is there or it is not. So the comparison is made the same way: turn the dots
// back into light, blur both sides by about what the eye does at reading
// distance, and ask how alike they are.
//
// Coverage is the bridge. Half the dots raised emits half the light, which is
// why the whole pipeline reasons in linear light -- so a blurred field of dots
// and a blurred photograph are directly comparable quantities, not two things
// that merely correlate.

import { gaussianBlur } from './blur.js';

/**
 * The dots as light: raised is full, clear is none.
 *
 * No aspect correction. A dot is a dot to the comparison, and both sides are
 * measured on the same grid, so the cell being taller than it is wide cancels
 * out rather than needing a factor that could be wrong.
 */
export function coverage(bits) {
  const light = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) light[i] = bits[i] ? 255 : 0;
  return light;
}

/**
 * How far back the viewer stands, in dots.
 *
 * Below about one dot the comparison sees individual dots and rewards whichever
 * method happens to line its dots up with the pixels; above about three it sees
 * only average brightness and stops caring whether the picture is in there at
 * all. Both ends were measured before this was settled.
 */
export const VIEWING_BLUR = 1.6;

// SSIM's stabilisers, on a 0..255 scale: the standard constants, which keep the
// ratio from bolting when a window is flat and both variances are near zero.
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/**
 * Structural similarity between two planes of the same size, in 8x8 windows.
 *
 * A plain error measure would rank a grey wash above a drawing that is right
 * everywhere but half a level off, because it only ever asks about level. SSIM
 * asks three things per window -- is the average right, is the amount of
 * variation right, do they vary together -- and the third is the one that
 * notices whether the picture is actually present.
 *
 * Returns 1 for identical planes and near 0 for unrelated ones.
 */
export function similarity(a, b, width, height, window = 8) {
  let total = 0;
  let windows = 0;

  for (let top = 0; top < height; top += window) {
    for (let left = 0; left < width; left += window) {
      const right = Math.min(left + window, width);
      const bottom = Math.min(top + window, height);
      const count = (right - left) * (bottom - top);
      if (count < 4) continue;

      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = y * width + x;
          const va = a[i], vb = b[i];
          sumA += va; sumB += vb;
          sumAA += va * va; sumBB += vb * vb; sumAB += va * vb;
        }
      }

      const meanA = sumA / count, meanB = sumB / count;
      const varA = Math.max(0, sumAA / count - meanA * meanA);
      const varB = Math.max(0, sumBB / count - meanB * meanB);
      const covariance = sumAB / count - meanA * meanB;

      total += ((2 * meanA * meanB + C1) * (2 * covariance + C2))
        / ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      windows++;
    }
  }

  return windows ? total / windows : 0;
}

/**
 * How far the light is off, on average, once both sides are blurred.
 *
 * Structure alone is not enough, and the reason is worth stating: on a flat
 * region SSIM rewards having no structure, and something that gets the level
 * badly wrong but is uniformly wrong has no structure either. Measured, a hard
 * threshold turns flat mid-grey into a solid field -- 57 percentage points of
 * coverage out -- and SSIM still called it 0.73, which is why it kept winning
 * before this was added.
 */
export function toneAgreement(seen, wanted) {
  let error = 0;
  for (let i = 0; i < seen.length; i++) error += Math.abs(seen[i] - wanted[i]);
  return Math.max(0, 1 - error / (seen.length * 255));
}

/**
 * How well the ink landed on the contours: precision and recall, as one number.
 *
 * A line drawing is not trying to reproduce light, so measuring it against light
 * says nothing -- literally nothing, as it turned out: every line variant scored
 * 0.00 and none was ever offered, on any picture, while the version before this
 * one had just spent its whole length making those lines good.
 *
 * The question a drawing should be asked is different: is the ink where the
 * contours are, and are the contours all drawn. That is precision and recall,
 * and the harmonic mean of the two is the usual way to say both at once. Both
 * sides are blurred first, so a dot half a cell out still counts -- the question
 * is whether the drawing is of the right thing, not whether it is exact.
 *
 * The two measures come out on comparable scales, which was checked rather than
 * hoped for: line variants reach 0.92-0.94 here where tonal ones reach 0.84-0.94
 * on their own measure.
 */
export function contourAgreement(bits, contour, width, height, blur = VIEWING_BLUR) {
  const ink = gaussianBlur(coverage(bits), width, height, blur);
  const wanted = gaussianBlur(contour, width, height, blur);

  let together = 0;
  let drawn = 0;
  let asked = 0;
  for (let i = 0; i < ink.length; i++) {
    const has = ink[i] / 255;
    const needs = Math.min(1, wanted[i] / 255);
    together += Math.min(has, needs);
    drawn += has;
    asked += needs;
  }
  // Nothing drawn, or nothing to draw, is nothing -- and so is ink that misses
  // the contours entirely, where precision and recall are both zero and the
  // harmonic mean would otherwise be 0/0.
  if (!drawn || !asked || !together) return 0;

  const precision = together / drawn;
  const recall = together / asked;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * What a candidate is worth: 0 is nothing like the picture, 1 is the picture.
 *
 * `reference` is the light the picture asks for, at dot resolution and in
 * linear units -- the same plane the encoder would have thresholded with no
 * edges and no adjustments, so every candidate is judged against the same
 * thing rather than against its own idea of the image.
 *
 * The two halves multiply rather than average, so neither can carry a candidate
 * on its own: being the right brightness everywhere is worth nothing if the
 * picture is not in there, and having the shape right is worth nothing if it is
 * three levels too dark.
 */
export function scoreArt(bits, width, height, reference, blur = VIEWING_BLUR) {
  const seen = gaussianBlur(coverage(bits), width, height, blur);
  const wanted = gaussianBlur(reference, width, height, blur);
  const structure = Math.max(0, similarity(seen, wanted, width, height));
  return structure * toneAgreement(seen, wanted);
}
