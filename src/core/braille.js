// SPDX-License-Identifier: GPL-3.0-or-later
// The encoder. No DOM, no canvas: ImageData in, text out.

import { lab, lightness, luminance, thresholdToLinear } from './gamma.js';
import { CELL_H, CELL_W } from './pixels.js';
import { cellColours, colourPattern } from './colour.js';
import { DIFFUSING, DITHER_METHODS, DEFAULT_DITHER, edgeBias } from './dither.js';
import { lineMap, mixLines, structureMap } from './edges.js';
import { reduceMax, reduceStats, withDetail } from './sample.js';

/**
 * U+2800 BRAILLE PATTERN BLANK. An empty cell is still a braille glyph rather
 * than an ASCII space, so chat clients cannot collapse or trim it and the art
 * keeps its alignment when pasted.
 */
export const BRAILLE_BLANK = 0x2800;

export { CELL_W, CELL_H } from './pixels.js';

/**
 * Bit index of each dot, addressed as DOT_BITS[column][row].
 *
 * Unicode numbers the dots of a cell
 *
 *     1  4
 *     2  5
 *     3  6
 *     7  8
 *
 * and places dot N at bit N-1 of the offset from U+2800.
 */
export const DOT_BITS = Object.freeze([
  Object.freeze([0, 1, 2, 6]), // dots 1, 2, 3, 7
  Object.freeze([3, 4, 5, 7]), // dots 4, 5, 6, 8
]);

function samplePlane(imageData, convert) {
  const { data } = imageData;
  const plane = new Float32Array(imageData.width * imageData.height);
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    plane[p] = convert(data[i], data[i + 1], data[i + 2]);
  }
  return plane;
}

/**
 * Linear light, which is what dot coverage reproduces: half the dots lit emits
 * half the light, so the fraction that renders a tone is its linear luminance.
 */
export const toLuminance = (imageData) => samplePlane(imageData, luminance);

/** Perceptual lightness, which is where edge detection belongs -- see ./gamma.js. */
export const toLightness = (imageData) => samplePlane(imageData, lightness);

/**
 * The two colour axes, in the units the lightness plane uses.
 *
 * A boundary between two hues of the same brightness -- red against green, at
 * the extreme -- is invisible to every plane above: measured, such a join moves
 * the lightness by 1 of 255 and gets no ink at all, and a whole shape can
 * disappear from a picture that plainly has one. What marks it is a and b.
 *
 * L* is scaled to 0..255 by 2.55, so a and b are scaled by the same 2.55 and
 * nothing else: in L*a*b* a step of one along any axis is meant to look about
 * as big as a step of one along any other, and keeping the scale shared is what
 * lets a detector treat them the same way.
 */
export function toChroma(imageData) {
  const { data } = imageData;
  const a = new Float32Array(imageData.width * imageData.height);
  const b = new Float32Array(a.length);
  for (let p = 0, i = 0; p < a.length; p++, i += 4) {
    const colour = lab(data[i], data[i + 1], data[i + 2]);
    a[p] = colour[1] * 2.55;
    b[p] = colour[2] * 2.55;
  }
  return { a, b };
}

/**
 * The plane the encoder will actually threshold, and the units it is in.
 *
 * The image handed in may be larger than the grid -- that is the point. Lines
 * are found and detail is judged where the structure still exists, and only
 * then reduced to one value per dot. Reducing first and asking afterwards is
 * what made a one-pixel line vanish outright.
 *
 * Tone and line want different spaces, and the choice decides how the threshold
 * control has to be read, so both are settled in one place.
 */
export function tonePlane(imageData, options = {}) {
  const { width, height } = imageData;
  const cols = options.grid?.cols ?? width / CELL_W;
  const rows = options.grid?.rows ?? height / CELL_H;
  const gridW = cols * CELL_W;
  const gridH = rows * CELL_H;

  const edge = options.edge;
  const drawingLines = Boolean(edge && edge.mode && edge.mode !== 'none' && (edge.amount ?? 1) > 0);
  const strength = Number(options.detail ?? 0);

  const blend = (plane) => {
    const stats = reduceStats(plane, width, height, gridW, gridH);
    if (!(strength > 0)) return stats.mean;
    const structure = reduceMax(structureMap(plane, width, height), width, height, gridW, gridH);
    return withDetail(stats, structure, strength);
  };

  if (!drawingLines) {
    return { plane: blend(toLuminance(imageData)), linear: true };
  }

  // Line strength is not a light measurement, so no gamma applies to it, and
  // the tone it is mixed with is perceptual for the same reason.
  const lightness = toLightness(imageData);
  const chroma = edge.colour ? toChroma(imageData) : null;
  const lines = reduceMax(
    lineMap(lightness, width, height, { ...edge, chroma }), width, height, gridW, gridH,
  );
  return { plane: mixLines(blend(lightness), lines, edge.amount ?? 1), linear: false };
}

/** The threshold control is in sRGB; a linear plane needs it converted. */
export const thresholdFor = (threshold, linear) =>
  (linear ? thresholdToLinear(threshold) : threshold);

/**
 * Luma plane to one bit per pixel, 1 meaning "dot raised".
 *
 * The chosen method decides which pixels land on the bright side; inversion is
 * applied here afterwards, so no dithering method has to know about it.
 */
export function binarize(plane, width, height, { threshold = 128, neutral = threshold, invert = false, method = DEFAULT_DITHER, emphasis = 0 } = {}) {
  const dither = DITHER_METHODS[method];
  if (!dither) throw new RangeError(`unknown dither method: ${method}`);

  // Only where the error is handed on: elsewhere a moved threshold moves the
  // tone with it, and there is nothing to put it back.
  const bias = DIFFUSING.has(method) ? edgeBias(plane, width, height, emphasis) : null;
  const bits = dither(plane, width, height, threshold, neutral, bias);
  if (invert) {
    for (let i = 0; i < bits.length; i++) bits[i] ^= 1;
  }
  return bits;
}

/** Bit plane of (cols*2 by rows*4) to braille text, rows joined by newlines. */
export function bitsToBraille(bits, cols, rows) {
  const stride = cols * CELL_W;
  const lines = new Array(rows);
  for (let cy = 0; cy < rows; cy++) {
    let line = '';
    for (let cx = 0; cx < cols; cx++) {
      let mask = 0;
      for (let c = 0; c < CELL_W; c++) {
        for (let r = 0; r < CELL_H; r++) {
          if (bits[(cy * CELL_H + r) * stride + (cx * CELL_W + c)]) {
            mask |= 1 << DOT_BITS[c][r];
          }
        }
      }
      line += String.fromCharCode(BRAILLE_BLANK + mask);
    }
    lines[cy] = line;
  }
  return lines.join('\n');
}

/**
 * ImageData sized exactly (cols*2 by rows*4) to braille text.
 *
 * The caller produces that exact size; refusing anything else keeps the cell
 * grid unambiguous and stops silent cropping of a trailing partial row.
 */
export function encode(imageData, options = {}) {
  const cols = options.grid?.cols ?? imageData.width / CELL_W;
  const rows = options.grid?.rows ?? imageData.height / CELL_H;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new RangeError(
      `image must be a multiple of ${CELL_W}x${CELL_H}, got ${imageData.width}x${imageData.height}`,
    );
  }
  // The one mode where colour decides the dots rather than tinting them. It
  // answers a different question -- which two colours is this cell made of --
  // so none of the tone machinery below applies to it.
  if (options.pattern === 'colour') {
    const { bits: chosen, ink, ground } = colourPattern(imageData, cols, rows, options);
    return {
      text: bitsToBraille(chosen, cols, rows),
      bits: chosen,
      plane: tonePlane(imageData, options).plane,
      colours: ink,
      background: ground,
      cols,
      rows,
    };
  }

  const { plane, linear } = tonePlane(imageData, options);
  const threshold = thresholdFor(options.threshold ?? 128, linear);
  // Where the control sits when centred, so a method that picks its own
  // threshold knows what "no adjustment" means in the plane's units.
  const neutral = thresholdFor(128, linear);
  const bits = binarize(plane, cols * CELL_W, rows * CELL_H, { ...options, threshold, neutral });

  return {
    text: bitsToBraille(bits, cols, rows),
    // The raised dots themselves, for anything that has to weigh this art
    // against another: text would have to be taken apart again to get here.
    bits,
    // The very values the dots were decided from, at grid size: that is what
    // the sampled-pixels pane should be showing.
    plane,
    // Colour takes no part in choosing the dots; it only tints them afterwards.
    // With `ground` asked for, the unraised dots get a colour of their own --
    // still after the fact, and still no say in which dots those are.
    ...colourFor(imageData, bits, cols, rows, options),
    cols,
    rows,
  };
}

/** Ink alone, or ink and ground, depending on what was asked for. */
function colourFor(imageData, bits, cols, rows, options) {
  if (!options.colour) return { colours: null, background: null };
  if (!options.ground) return { colours: cellColours(imageData, bits, cols, rows), background: null };
  const { ink, ground } = cellColours(imageData, bits, cols, rows, true);
  return { colours: ink, background: ground };
}

/** The text alone, which is what most callers want. */
export const imageDataToBraille = (imageData, options = {}) => encode(imageData, options).text;

/**
 * Drop rows and columns of empty cells from the edges.
 *
 * Centring an image inside a grid leaves a border of blanks, and a blank cell
 * costs a character like any other. The message limit is counted in characters,
 * not in picture, so trimming is the cheapest way to make art fit -- it removes
 * nothing anyone can see.
 *
 * A column only goes if it is empty in every row, so nothing shifts sideways.
 */
export function trimBounds(text) {
  const blank = String.fromCharCode(BRAILLE_BLANK);
  const lines = text.split('\n');

  let top = 0;
  let bottom = lines.length - 1;
  while (top <= bottom && [...lines[top]].every((cell) => cell === blank)) top++;
  while (bottom >= top && [...lines[bottom]].every((cell) => cell === blank)) bottom--;
  if (top > bottom) return null;

  const kept = lines.slice(top, bottom + 1);
  const width = Math.max(...kept.map((line) => line.length));

  let left = 0;
  let right = width - 1;
  const columnIsBlank = (column) => kept.every((line) => (line[column] ?? blank) === blank);
  while (left <= right && columnIsBlank(left)) left++;
  while (right >= left && columnIsBlank(right)) right--;
  if (left > right) return null;

  return { left, top, right, bottom };
}

export function trimBlank(text) {
  const bounds = trimBounds(text);
  if (!bounds) return '';
  return text.split('\n')
    .slice(bounds.top, bounds.bottom + 1)
    .map((line) => line.slice(bounds.left, bounds.right + 1))
    .join('\n');
}

/** Crop a colour array to the same bounds, so cells and colours stay paired. */
export function trimColours(colours, cols, bounds) {
  if (!bounds || !colours) return colours;
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const out = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((y + bounds.top) * cols + (x + bounds.left)) * 3;
      const to = (y * width + x) * 3;
      out[to] = colours[from];
      out[to + 1] = colours[from + 1];
      out[to + 2] = colours[from + 2];
    }
  }
  return out;
}

/**
 * How many rows keep the source proportions on screen.
 *
 * `cellAspect` is a glyph's rendered advance width divided by its line height.
 * Measure it from the element the art will live in rather than assuming a
 * value, or the output comes out stretched.
 */
export function rowsForAspect(cols, srcW, srcH, cellAspect) {
  return Math.max(1, Math.round(cols * (srcH / srcW) * cellAspect));
}
