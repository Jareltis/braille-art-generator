// SPDX-License-Identifier: GPL-3.0-or-later
// Four ways this picture could be drawn, and which of them is worth offering.
//
// The controls span more combinations than anyone will try by hand, and which
// one suits a given picture is not obvious even to someone who knows what every
// control does. So a spread of recipes is rendered, each is scored against the
// original, and the best few are put on the table.
//
// The recipes are a fixed spread rather than a search over the whole space.
// Scoring is honest but not free -- every candidate is a full encode -- and a
// dozen well-separated points say more about a picture than a hundred crowded
// ones. Names are keys: the words live in the dictionaries.

import { encode, toLuminance } from './braille.js';
import { CELL_W, CELL_H } from './pixels.js';
import { reduceStats } from './sample.js';
import { scoreArt } from './score.js';

/**
 * The spread. Chosen to differ from one another in kind, not in degree: two
 * recipes that produce nearly the same picture waste one of the four places.
 */
export const VARIANT_RECIPES = Object.freeze([
  { key: 'smooth',    method: 'floyd-steinberg', detail: 35, edge: { mode: 'none' } },
  { key: 'detailed',  method: 'floyd-steinberg', detail: 70, edge: { mode: 'none' } },
  { key: 'crisp',     method: 'atkinson',        detail: 35, edge: { mode: 'none' } },
  { key: 'grain',     method: 'bluenoise',       detail: 35, edge: { mode: 'none' } },
  { key: 'weave',     method: 'bayer4',          detail: 35, edge: { mode: 'none' } },
  { key: 'flat',      method: 'threshold',       detail: 35, edge: { mode: 'none' } },
  { key: 'local',     method: 'sauvola',         detail: 35, edge: { mode: 'none' } },
  { key: 'lines',     method: 'threshold',       detail: 70, edge: { mode: 'xdog', amount: 1, radius: 1, clean: 0.9 } },
  { key: 'linesTone', method: 'floyd-steinberg', detail: 50, edge: { mode: 'xdog', amount: 0.5, radius: 1, clean: 0.9 } },
  { key: 'outline',   method: 'floyd-steinberg', detail: 50, edge: { mode: 'sobel', amount: 0.5, radius: 1, clean: 0.9 } },
]);

/**
 * How different two candidates have to be to both be worth showing.
 *
 * As a fraction of the dots. Below this they are the same picture with a
 * different grain, and offering both spends a place on the table for nothing.
 */
export const DISTINCT = 0.04;

/** The share of dots where two arts disagree. */
export function difference(a, b) {
  if (a.length !== b.length) return 1;
  let apart = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) apart++;
  return apart / a.length;
}

/**
 * Render every recipe, score it, and return the best few that are not each
 * other.
 *
 * `reference` is what the picture asks for -- linear light at dot resolution,
 * no edges, no adjustments -- so that every candidate is judged against the
 * same thing rather than against its own version of the image.
 *
 * The chosen ones keep their order by score, so the first is the best rather
 * than merely the first that fitted.
 */
export function chooseVariants(pixels, options, reference, want = 4, onProgress = null) {
  const scored = [];
  const gridW = options.grid.cols * 2;
  const gridH = options.grid.rows * 4;

  VARIANT_RECIPES.forEach((recipe, index) => {
    const art = encode(pixels, {
      ...options,
      method: recipe.method,
      detail: recipe.detail,
      edge: recipe.edge,
    });
    scored.push({
      key: recipe.key,
      recipe,
      text: art.text,
      bits: art.bits,
      score: scoreArt(art.bits, gridW, gridH, reference),
    });
    onProgress?.(index + 1, VARIANT_RECIPES.length);
  });

  scored.sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const candidate of scored) {
    if (chosen.length >= want) break;
    if (chosen.every((taken) => difference(taken.bits, candidate.bits) >= DISTINCT)) chosen.push(candidate);
  }

  // If everything looked alike -- a nearly blank picture will do that -- fill
  // the table by score rather than handing back one lonely tile.
  for (const candidate of scored) {
    if (chosen.length >= want) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }

  return chosen;
}

/**
 * What the picture asks for: plain linear light at dot resolution.
 *
 * No edges and no detail blending, because this is the thing every candidate is
 * measured against and it must not be any candidate's own idea of the image.
 */
export function referenceFor(pixels, cols, rows) {
  return reduceStats(
    toLuminance(pixels), pixels.width, pixels.height, cols * CELL_W, rows * CELL_H,
  ).mean;
}

/** Everything a caller needs, from pixels to a table of offers. */
export function variantsOf(pixels, options, want = 4) {
  const { cols, rows } = options.grid;
  return chooseVariants(pixels, options, referenceFor(pixels, cols, rows), want)
    .map(({ key, recipe, text, score }) => ({ key, recipe, text, score }));
}
