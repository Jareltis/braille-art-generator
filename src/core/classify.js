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

import { applyLocalTone } from './adjust.js';
import { CELL_H, CELL_W, encode } from './braille.js';
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

/**
 * How dark a lift the picture is asking for, if any.
 *
 * The question is not how dark the picture is -- a drawing on a white ground is
 * mostly one value and wants nothing done to it. The question is how much of
 * what the picture holds is being thrown away: cells the art renders as nothing
 * at all, every dot down or every dot up, where the picture had visible texture
 * to show. A clean white background has no texture and is not counted, which is
 * what stops this from flattening one.
 *
 * The lift is chosen by trying a few and measuring, not by a rule about
 * brightness. Measured on six pictures, the loss falls all the way to the top
 * of the slider -- there is no knee to find -- so the choice is the smallest
 * setting that is as good as the best, and the whole thing only fires when
 * there is a fifth of the loss to win back. On the six that means it lifts the
 * dark forest and the landscape and leaves the other four alone.
 */
export const LIFT_STEPS = Object.freeze([0, 40, 70, 100]);

/** Below this, in L*, a cell has nothing in it worth keeping. One unit is
 *  roughly the smallest difference the eye can tell. */
const TEXTURE = 2;

/**
 * How much has to be going missing before the question is worth asking at all.
 *
 * One textured cell in twenty. The relative test below is the one that tells
 * the pictures apart -- on six real ones the lift won back 7 to 17 percent of
 * the loss on four of them and 40 and 48 on the two that needed it -- but a
 * ratio on a loss of two percent is a ratio on noise, and it fired.
 */
const WORTH_ASKING = 0.05;

/** How much of the loss a lift has to win back before it is worth applying. */
const WORTH_IT = 0.2;

/** And how close to the best a smaller setting may be and still be taken. */
const NEAR_ENOUGH = 0.01;

function textureOf(imageData, cols, rows) {
  const blockW = imageData.width / cols;
  const blockH = imageData.height / rows;
  const out = new Float32Array(cols * rows);
  for (let cell = 0; cell < cols * rows; cell++) {
    const fromX = Math.floor((cell % cols) * blockW);
    const fromY = Math.floor(Math.floor(cell / cols) * blockH);
    const toX = Math.min(imageData.width, Math.ceil(fromX + blockW));
    const toY = Math.min(imageData.height, Math.ceil(fromY + blockH));
    let sum = 0;
    let squares = 0;
    let seen = 0;
    for (let y = fromY; y < toY; y++) {
      for (let x = fromX; x < toX; x++) {
        const at = (y * imageData.width + x) * 4;
        const l = lightness(imageData.data[at], imageData.data[at + 1], imageData.data[at + 2]) / 2.55;
        sum += l;
        squares += l * l;
        seen++;
      }
    }
    const mean = sum / (seen || 1);
    out[cell] = Math.sqrt(Math.max(0, squares / (seen || 1) - mean * mean));
  }
  return out;
}

/** The share of cells that had something to show and show nothing. */
function lostTexture(bits, texture, cols, rows) {
  const dotsW = cols * CELL_W;
  let lost = 0;
  let had = 0;
  for (let cell = 0; cell < cols * rows; cell++) {
    if (texture[cell] <= TEXTURE) continue;
    had++;
    const fromX = (cell % cols) * CELL_W;
    const fromY = Math.floor(cell / cols) * CELL_H;
    let lit = 0;
    for (let dy = 0; dy < CELL_H; dy++) {
      for (let dx = 0; dx < CELL_W; dx++) lit += bits[(fromY + dy) * dotsW + (fromX + dx)] ? 1 : 0;
    }
    if (lit === 0 || lit === CELL_W * CELL_H) lost++;
  }
  return had ? lost / had : 0;
}

export function shadowLiftFor(imageData, options = {}) {
  const cols = options.grid?.cols;
  const rows = options.grid?.rows;
  if (!cols || !rows) return { shadows: 0, lost: 0, without: 0 };

  const texture = textureOf(imageData, cols, rows);
  const tried = LIFT_STEPS.map((shadows) => {
    const pixels = shadows ? applyLocalTone(imageData, { shadows, highlights: 0 }) : imageData;
    const { bits } = encode(pixels, options);
    return { shadows, lost: lostTexture(bits, texture, cols, rows) };
  });

  const without = tried[0].lost;
  const best = Math.min(...tried.map((one) => one.lost));
  if (without < WORTH_ASKING || (without - best) / without < WORTH_IT) {
    return { shadows: 0, lost: without, without };
  }

  const taken = tried.find((one) => one.lost <= best + NEAR_ENOUGH) ?? tried[0];
  return { shadows: taken.shadows, lost: taken.lost, without };
}
