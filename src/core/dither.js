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

import { BLUE_NOISE_SIZE, blueNoiseMatrix, seededRandom } from './bluenoise.js';
import { gaussianBlur } from './blur.js';
import { sobel } from './edges.js';
import { STRUCTURE_FULL } from './sample.js';

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
export const DIFFUSING = Object.freeze(new Set(['floyd-steinberg', 'atkinson', 'ostromoukhov', 'zhoufang']));

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
 *
 * Most of that cost is paid where there was nothing to sharpen. A high-pass
 * answers to noise and to fine texture exactly as it answers to an edge, so at
 * full strength the technique pushes the threshold about all over a hillside
 * for no gain. Scaling it by how much structure is actually there -- the same
 * gradient-after-a-blur the detail blend leans on -- keeps the sharpening and
 * drops most of the damage: measured over six pictures at forty and sixty
 * columns, gated beats flat at full strength on ten of the twelve, by up to
 * 0.019, and the two are level at half strength. Cheap at this size: the plane
 * is already down at one value per dot.
 */
/**
 * What the gate costs at an edge, and is given back.
 *
 * Even at a clean step the structure map answers about half of full, so gating
 * halves the lean where it was wanted as well: measured on a step buried in
 * speckle, the response fell from 21.6 to 11.0 while the speckle fell from 5.5
 * to 0.1. Two puts the top of the slider back where it was for edges and leaves
 * the flat areas fifty times quieter. Measured over six pictures, it scores at
 * or above the ungated form on five of the six.
 */
const EDGE_GATE_GAIN = 2;

export function edgeBias(plane, width, height, strength) {
  if (!(strength > 0)) return null;
  const soft = gaussianBlur(plane, width, height, 1.2);
  const structure = sobel(gaussianBlur(plane, width, height, 1), width, height);
  const bias = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) {
    const much = Math.min(1, structure[i] / STRUCTURE_FULL);
    bias[i] = -strength * EDGE_GATE_GAIN * much * (plane[i] - soft[i]);
  }
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


/**
 * Zhou and Fang's coefficients, and the strength of their threshold noise.
 *
 * The same shape as Ostromoukhov's -- one set of three weights per input level,
 * mirrored above the midpoint -- refitted, and paired with a second table that
 * says how hard to jog the threshold at each level. The jog is what the paper
 * is named for: variable coefficients alone leave regular patterns in the
 * mid-tones, and a level-dependent random push at the threshold breaks them
 * without moving the tone, because error diffusion still measures its error
 * against the true value.
 *
 * The numbers are the paper's, taken from the authors' own reference
 * implementation (SIGGRAPH 2003; github.com/cczbf/TMED) rather than typed from
 * a figure. Weights are already fractions of one, so nothing here has to be
 * normalised the way the Ostromoukhov table does.
 */
const ZHOU_FANG_SHARE = new Float32Array([
  0.722222, 0.000000, 0.277778, 0.722562, 0.000000, 0.277438, 0.682418, 0.000915, 0.316668, 0.637626, 0.000000, 0.362374,   // 0-3
  0.619999, 0.000000, 0.380001, 0.606570, 0.037983, 0.355447, 0.593141, 0.075967, 0.330892, 0.579712, 0.113951, 0.306337,   // 4-7
  0.566283, 0.151934, 0.281783, 0.552854, 0.189918, 0.257228, 0.539424, 0.227902, 0.232674, 0.533317, 0.235508, 0.231175,   // 8-11
  0.527210, 0.243114, 0.229676, 0.521102, 0.250720, 0.228178, 0.514995, 0.258326, 0.226679, 0.508887, 0.265932, 0.225181,   // 12-15
  0.502780, 0.273538, 0.223682, 0.496672, 0.281144, 0.222184, 0.490564, 0.288749, 0.220686, 0.484457, 0.296356, 0.219187,   // 16-19
  0.478349, 0.303961, 0.217689, 0.472242, 0.311567, 0.216190, 0.466135, 0.319173, 0.214692, 0.467003, 0.317873, 0.215123,   // 20-23
  0.467872, 0.316573, 0.215554, 0.468741, 0.315273, 0.215985, 0.469610, 0.313973, 0.216416, 0.470479, 0.312673, 0.216847,   // 24-27
  0.471348, 0.311373, 0.217278, 0.472217, 0.310073, 0.217709, 0.473086, 0.308773, 0.218140, 0.473955, 0.307473, 0.218571,   // 28-31
  0.474825, 0.306173, 0.219002, 0.472921, 0.298013, 0.229065, 0.471018, 0.289853, 0.239128, 0.469115, 0.281693, 0.249191,   // 32-35
  0.467212, 0.273534, 0.259255, 0.465308, 0.265374, 0.269317, 0.463405, 0.257214, 0.279380, 0.461502, 0.249054, 0.289443,   // 36-39
  0.459599, 0.240895, 0.299506, 0.452280, 0.286019, 0.261702, 0.444960, 0.331142, 0.223897, 0.437641, 0.376266, 0.186092,   // 40-43
  0.430322, 0.421390, 0.148288, 0.427011, 0.421930, 0.151058, 0.423701, 0.422471, 0.153828, 0.420391, 0.423011, 0.156598,   // 44-47
  0.417081, 0.423551, 0.159368, 0.413769, 0.424091, 0.162139, 0.410459, 0.424631, 0.164909, 0.407149, 0.425172, 0.167679,   // 48-51
  0.403839, 0.425712, 0.170449, 0.400529, 0.426252, 0.173219, 0.397217, 0.426792, 0.175990, 0.393907, 0.427332, 0.178760,   // 52-55
  0.390597, 0.427873, 0.181530, 0.387287, 0.428413, 0.184300, 0.383976, 0.428953, 0.187070, 0.380665, 0.429493, 0.189841,   // 56-59
  0.377355, 0.430033, 0.192611, 0.374045, 0.430574, 0.195381, 0.370735, 0.431114, 0.198151, 0.367424, 0.431654, 0.200921,   // 60-63
  0.364114, 0.432194, 0.203692, 0.366696, 0.445475, 0.187828, 0.369280, 0.458756, 0.171964, 0.371863, 0.472037, 0.156100,   // 64-67
  0.374446, 0.485318, 0.140236, 0.377029, 0.498599, 0.124372, 0.379611, 0.511880, 0.108509, 0.382195, 0.525160, 0.092645,   // 68-71
  0.384778, 0.538441, 0.076782, 0.388830, 0.533849, 0.077321, 0.392882, 0.529257, 0.077861, 0.396934, 0.524665, 0.078401,   // 72-75
  0.400986, 0.520073, 0.078941, 0.405038, 0.515480, 0.079482, 0.399240, 0.493681, 0.107078, 0.393442, 0.471884, 0.134674,   // 76-79
  0.387644, 0.450085, 0.162272, 0.381846, 0.428285, 0.189869, 0.376047, 0.406484, 0.217468, 0.370250, 0.384684, 0.245066,   // 80-83
  0.364452, 0.362884, 0.272665, 0.358654, 0.341083, 0.300263, 0.356906, 0.343875, 0.299220, 0.355158, 0.346666, 0.298177,   // 84-87
  0.353410, 0.349457, 0.297134, 0.351662, 0.352248, 0.296091, 0.349914, 0.355039, 0.295048, 0.348166, 0.357830, 0.294005,   // 88-91
  0.346418, 0.360621, 0.292962, 0.344670, 0.363412, 0.291919, 0.342922, 0.366203, 0.290876, 0.341173, 0.368994, 0.289833,   // 92-95
  0.342624, 0.367795, 0.289582, 0.344075, 0.366595, 0.289331, 0.345525, 0.365396, 0.289080, 0.346976, 0.364196, 0.288829,   // 96-99
  0.348426, 0.362997, 0.288578, 0.349877, 0.361797, 0.288327, 0.351327, 0.360597, 0.288076, 0.346971, 0.363720, 0.289310,   // 100-103
  0.342615, 0.366842, 0.290544, 0.338259, 0.369964, 0.291778, 0.333903, 0.373086, 0.293012, 0.329547, 0.376208, 0.294246,   // 104-107
  0.330358, 0.376875, 0.292768, 0.331169, 0.377542, 0.291288, 0.331980, 0.378209, 0.289810, 0.332792, 0.378877, 0.288332,   // 108-111
  0.333603, 0.379544, 0.286853, 0.334876, 0.378285, 0.286838, 0.336149, 0.377027, 0.286825, 0.337422, 0.375768, 0.286811,   // 112-115
  0.338694, 0.374509, 0.286796, 0.339967, 0.373251, 0.286783, 0.341240, 0.371992, 0.286769, 0.342512, 0.370733, 0.286754,   // 116-119
  0.343785, 0.369475, 0.286741, 0.345058, 0.368216, 0.286727, 0.346330, 0.366957, 0.286712, 0.347603, 0.365699, 0.286699,   // 120-123
  0.348876, 0.364440, 0.286685, 0.350149, 0.363181, 0.286671, 0.351421, 0.361923, 0.286657, 0.352694, 0.360664, 0.286643,   // 124-127
]);

/** Percent of a half-range jog to allow at each level, again mirrored. */
const ZHOU_FANG_JOG = new Uint8Array([
0, 0, 1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11,
  12, 12, 13, 14, 15, 15, 16, 17, 18, 18, 19, 20, 21, 21, 22, 23,
  24, 24, 25, 26, 27, 27, 28, 29, 30, 31, 32, 33, 34, 34, 35, 36,
  37, 38, 38, 39, 40, 41, 42, 42, 43, 44, 45, 46, 46, 47, 48, 49,
  50, 53, 56, 59, 62, 65, 68, 71, 75, 78, 81, 84, 87, 90, 93, 96,
  100, 100, 100, 100, 100, 100, 91, 83, 75, 66, 58, 50, 41, 33, 25, 17,
  21, 26, 31, 35, 40, 45, 50, 54, 58, 62, 66, 70, 71, 73, 75, 77,
  79, 80, 81, 83, 84, 86, 87, 88, 90, 91, 93, 94, 95, 97, 98, 100,
]);

/** Half the range, which is how far the paper's jog reaches at full strength. */
const JOG_RANGE = 128;

/**
 * Variable coefficients with threshold modulation.
 *
 * Seeded rather than left to chance: two runs of the same picture have to give
 * the same art, or the tile that offered a recipe would not be showing what
 * choosing it produces.
 */
function zhouFang(plane, width, height, threshold, neutral = threshold, bias = null) {
  const buf = Float32Array.from(plane);
  const bits = new Uint8Array(plane.length);
  const random = seededRandom(1);

  for (let y = 0; y < height; y++) {
    const ahead = y & 1 ? -1 : 1;
    for (let step = 0; step < width; step++) {
      const x = ahead > 0 ? step : width - 1 - step;
      const i = y * width + x;

      const level = plane[i] < 0 ? 0 : plane[i] > 255 ? 255 : Math.round(plane[i]);
      const mirrored = level < 128 ? level : 255 - level;
      const jog = random() * JOG_RANGE * (ZHOU_FANG_JOG[mirrored] / 100);

      const lit = buf[i] > threshold + jog + (bias ? bias[i] : 0);
      bits[i] = lit ? 1 : 0;
      const err = buf[i] - (lit ? 255 : 0);

      const at = mirrored * 3;
      const nextTo = x + ahead;
      const behind = x - ahead;
      if (nextTo >= 0 && nextTo < width) buf[i + ahead] += err * ZHOU_FANG_SHARE[at];
      if (y + 1 < height) {
        if (behind >= 0 && behind < width) buf[i + width - ahead] += err * ZHOU_FANG_SHARE[at + 1];
        buf[i + width] += err * ZHOU_FANG_SHARE[at + 2];
      }
    }
  }
  return bits;
}

/** Registry. Keys are the values stored in the UI and in saved settings. */
export const DITHER_METHODS = Object.freeze({
  'floyd-steinberg': floydSteinberg,
  ostromoukhov,
  zhoufang: zhouFang,
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
