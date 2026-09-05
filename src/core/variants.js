// SPDX-License-Identifier: GPL-3.0-or-later
// Four ways this picture could be drawn, and which of them is worth offering.
//
// The controls span more combinations than anyone will sit and try, and which
// one suits a given picture is not obvious even to someone who knows what every
// control does. So a spread is rendered, each is scored against the original,
// and the best few are put on the table.
//
// The spread is drawn rather than listed. A fixed list answers the same way
// every time, which makes the button something you press once; drawing it makes
// pressing again worth doing. But drawing freely from the whole parameter space
// mostly produces rubbish -- most combinations suit no picture at all -- so the
// draw happens inside families. A family is a way of working: carry the
// half-tones, lay an even grain, cut hard for contrast, draw the lines. Which
// family a tile comes from is settled first and only its dials are random, so
// every offer is a sensible thing to have tried.
//
// Quality is then held twice over: everything is scored against the picture and
// ranked, and a candidate too far behind the best is dropped rather than shown
// to fill a square.
//
// The local threshold used to be a family here and is not any more. Its purpose
// is to throw the illumination away so the content stays legible, which is the
// opposite of reproducing the picture -- so neither measure rewards it, and
// measured over 48 draws it took a square exactly never, including on pictures
// deliberately lit from one side. A family that cannot be offered is a promise
// the list does not keep. Sauvola is still there to be chosen by hand.

import { encode, toLightness, toLuminance } from './braille.js';
import { lineMap } from './edges.js';
import { reduceMax } from './sample.js';
import { seededRandom } from './bluenoise.js';
import { CELL_W, CELL_H } from './pixels.js';
import { reduceStats } from './sample.js';
import { contourAgreement, scoreArt } from './score.js';

const between = (random, low, high) => low + random() * (high - low);
const pick = (random, list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
const step = (random, low, high) => Math.round(between(random, low, high));
const oneDecimal = (value) => Number(value.toFixed(1));

/**
 * How far a draw may move the threshold, in the units of the control.
 *
 * Another axis of real variety: the same method a few levels darker is a
 * visibly different picture, not a different grain. It cannot run away with
 * things, because moving the threshold away from what the picture wants is
 * exactly what the score punishes.
 */
const THRESHOLD_SWING = 22;
const nudge = (random, base) =>
  Math.round(Math.max(0, Math.min(255, base + between(random, -THRESHOLD_SWING, THRESHOLD_SWING))));

/**
 * The ways of working. Each draws its own dials; the key names the tile, and
 * the words for it live in the dictionaries.
 *
 * Detail is in the units of the control, as in the presets, so that applying a
 * recipe is a matter of copying numbers onto the panel. `encodeOptions` is the
 * one place that converts.
 */
export const VARIANT_FAMILIES = Object.freeze([
  {
    key: 'tone',
    judge: 'tone',
    draw: (random, base) => ({
      threshold: nudge(random, base),
      // Floyd-Steinberg twice over, so the draw leans towards the one that
      // measured best across every test picture rather than treating the two
      // as equals.
      method: pick(random, ['ostromoukhov', 'ostromoukhov', 'floyd-steinberg', 'atkinson']),
      detail: step(random, 20, 60),
      edge: { mode: 'none' },
    }),
  },
  {
    key: 'grain',
    judge: 'tone',
    draw: (random, base) => ({
      threshold: nudge(random, base),
      method: pick(random, ['bluenoise', 'bayer4']),
      detail: step(random, 20, 60),
      edge: { mode: 'none' },
    }),
  },
  {
    key: 'contrast',
    judge: 'tone',
    draw: (random, base) => ({
      threshold: nudge(random, base),
      method: pick(random, ['atkinson', 'threshold']),
      detail: step(random, 40, 85),
      edge: { mode: 'none' },
    }),
  },
  {
    key: 'lines',
    // Judged on where its ink landed, not on how much light it emits. A line
    // drawing does not reproduce light and never claimed to.
    judge: 'contour',
    draw: (random, base) => ({
      threshold: base,
      method: 'threshold',
      detail: step(random, 50, 90),
      edge: {
        mode: 'xdog',
        amount: between(random, 0.85, 1),
        radius: oneDecimal(between(random, 0.6, 1.6)),
        clean: between(random, 0.5, 1),
      },
    }),
  },
  {
    key: 'mixed',
    judge: 'tone',
    draw: (random, base) => ({
      threshold: nudge(random, base),
      method: pick(random, ['floyd-steinberg', 'bluenoise']),
      detail: step(random, 30, 70),
      edge: {
        mode: pick(random, ['xdog', 'sobel']),
        amount: between(random, 0.25, 0.6),
        radius: oneDecimal(between(random, 0.7, 1.4)),
        clean: between(random, 0.5, 1),
      },
    }),
  },
]);

/** How many draws each family gets. More finds better dials; every one costs an encode. */
export const DRAWS_PER_FAMILY = 3;

/**
 * A recipe in the units the encoder wants.
 *
 * Recipes are written in the units of the controls, the way presets are. The
 * encoder wants detail as a fraction, and the panel holds it as a percentage.
 * Getting that wrong renders the offer at a strength of 35 instead of 0.35, so
 * the tile shows one picture and choosing it produces another -- which is what
 * happened, and why the conversion lives in exactly one place.
 */
export const encodeOptions = (recipe) => ({
  method: recipe.method,
  detail: recipe.detail / 100,
  threshold: recipe.threshold,
  edge: recipe.edge,
});

/**
 * How different two candidates have to be to both be worth showing.
 *
 * As a fraction of the dots. Below this they are the same picture with a
 * different grain, and offering both spends a place on the table for nothing.
 */
export const DISTINCT = 0.04;

/**
 * How far behind the best a candidate may be and still be offered.
 *
 * Variety is worth something, but not a square spent on a picture nobody would
 * pick. Relative to the best found rather than absolute, because what a good
 * score looks like depends on the picture: a line drawing reaches 0.94, and a
 * forest in poor light never will.
 */
export const QUALITY_FLOOR = 0.55;

/** The share of dots where two arts disagree. */
export function difference(a, b) {
  if (a.length !== b.length) return 1;
  let apart = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) apart++;
  return apart / a.length;
}

/** Every family, drawn a few times each. */
export function sampleRecipes(random, base = 128, draws = DRAWS_PER_FAMILY) {
  const recipes = [];
  for (const family of VARIANT_FAMILIES) {
    for (let n = 0; n < draws; n++) {
      recipes.push({ key: family.key, judge: family.judge, ...family.draw(random, base) });
    }
  }
  return recipes;
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

/**
 * Where the picture's contours are, at dot resolution.
 *
 * The same detector the drawing families use, run on the picture itself, so
 * what a line variant is measured against is the thing it was trying to find
 * rather than some other idea of an edge.
 */
export function contourFor(pixels, cols, rows) {
  const { width, height } = pixels;
  return reduceMax(
    lineMap(toLightness(pixels), width, height, { mode: 'xdog', radius: 1, clean: 0.9 }),
    width, height, cols * CELL_W, rows * CELL_H,
  );
}

/**
 * Render the drawn spread, score it, and return the best few that are neither
 * each other nor a wasted square.
 *
 * Three passes, each relaxing one rule, so the table still fills for a picture
 * where everything comes out looking alike:
 *
 *   1. the best of each family, above the floor and visibly different
 *   2. any family again, still above the floor and different
 *   3. whatever is left, by score
 */
export function chooseVariants(pixels, options, reference, want = 4, random = Math.random, contour = null) {
  const gridW = options.grid.cols * CELL_W;
  const gridH = options.grid.rows * CELL_H;

  const scored = sampleRecipes(random, options.threshold ?? 128).map((recipe) => {
    const art = encode(pixels, { ...options, ...encodeOptions(recipe) });
    return {
      key: recipe.key,
      judge: recipe.judge ?? 'tone',
      recipe,
      text: art.text,
      bits: art.bits,
      score: recipe.judge === 'contour' && contour
        ? contourAgreement(art.bits, contour, gridW, gridH)
        : scoreArt(art.bits, gridW, gridH, reference),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const chosen = [];
  const families = new Set();
  const take = (candidate) => {
    chosen.push(candidate);
    families.add(candidate.key);
  };
  const distinct = (candidate) => chosen.every((taken) => difference(taken.bits, candidate.bits) >= DISTINCT);

  // A drawing gets a place of its own, and takes it on its own measure.
  //
  // The two numbers answer different questions -- how much light came out right,
  // and where the ink landed -- so they are not raced against one another.
  // Ranking on light stays the house rule, and it is what most people bringing a
  // photograph want. But before this a line variant could never appear at all,
  // on any picture: light is the one thing it does not try to reproduce, so it
  // scored zero every time and the floor threw it out. Measured over 48 draws
  // across four pictures, it was offered exactly never.
  const drawings = scored.filter((candidate) => candidate.judge === 'contour');
  const tonal = scored.filter((candidate) => candidate.judge !== 'contour');

  // The place is earned, not reserved. A drawing takes it only by finding the
  // contours better than the best tonal candidate already does -- which is the
  // real question about that tile: does it add anything. No new constant is
  // needed for that, and it settles the case of a picture with nothing much to
  // draw: on a smooth gradient the best drawing scored 0.03 and would otherwise
  // have taken a square from something worth looking at.
  const bestTonal = tonal[0];
  const alreadyDrawn = bestTonal && contour
    ? contourAgreement(bestTonal.bits, contour, gridW, gridH)
    : 0;
  const bestDrawing = drawings.find((candidate) => candidate.score > alreadyDrawn);

  const floor = (tonal[0]?.score ?? 0) * QUALITY_FLOOR;
  const room = bestDrawing ? want - 1 : want;

  for (const candidate of tonal) {
    if (chosen.length >= room) break;
    if (candidate.score < floor || families.has(candidate.key) || !distinct(candidate)) continue;
    take(candidate);
  }
  for (const candidate of tonal) {
    if (chosen.length >= room) break;
    if (chosen.includes(candidate) || candidate.score < floor || !distinct(candidate)) continue;
    take(candidate);
  }
  if (bestDrawing) take(bestDrawing);
  for (const candidate of scored) {
    if (chosen.length >= want) break;
    if (!chosen.includes(candidate)) take(candidate);
  }

  return chosen;
}

export function variantsOf(pixels, options, want = 4, seed = null) {
  const { cols, rows } = options.grid;
  const random = seed === null ? Math.random : seededRandom(seed);
  return chooseVariants(
    pixels, options, referenceFor(pixels, cols, rows), want, random, contourFor(pixels, cols, rows),
  ).map(({ key, judge, recipe, text, score }) => ({ key, judge, recipe, text, score }));
}
