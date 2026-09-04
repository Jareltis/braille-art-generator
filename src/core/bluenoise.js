// SPDX-License-Identifier: GPL-3.0-or-later
// A blue-noise threshold matrix, built by void-and-cluster (Ulichney, 1993).
//
// Ordered dithering is attractive because no error travels between pixels: the
// result depends only on position, so nothing shifts when the image is re-cropped
// or re-rendered. The cost is the pattern. A Bayer matrix is regular enough to
// read as crosshatch, which on a grid this coarse is very visible.
//
// Blue noise keeps the position-only property but distributes its thresholds so
// that no scale carries a repeating structure -- the points are evenly spread
// without ever lining up. The result looks like error diffusion and behaves like
// an ordered matrix.
//
// The matrix is generated once at load rather than shipped as a constant: at
// 32x32 that is a few milliseconds, against about twelve kilobytes of source.

const SIZE = 32;
const CELLS = SIZE * SIZE;
const SIGMA = 1.5;
const RADIUS = 3;
const INITIAL_FRACTION = 0.1;

/** Deterministic, so the pattern is identical in every session and in tests. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG; the top bits are the usable ones.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const KERNEL = (() => {
  const span = RADIUS * 2 + 1;
  const weights = new Float64Array(span * span);
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      weights[(dy + RADIUS) * span + (dx + RADIUS)] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
    }
  }
  return weights;
})();

const wrap = (v) => ((v % SIZE) + SIZE) % SIZE;

/** Add or remove one point's contribution to the filtered field. */
function stamp(energy, index, sign) {
  const cx = index % SIZE;
  const cy = (index / SIZE) | 0;
  const span = RADIUS * 2 + 1;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    const y = wrap(cy + dy) * SIZE;
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      energy[y + wrap(cx + dx)] += sign * KERNEL[(dy + RADIUS) * span + (dx + RADIUS)];
    }
  }
}

/** The 1 sitting in the densest company. */
function tightestCluster(pattern, energy) {
  let best = -1;
  let peak = -Infinity;
  for (let i = 0; i < CELLS; i++) {
    if (pattern[i] === 1 && energy[i] > peak) {
      peak = energy[i];
      best = i;
    }
  }
  return best;
}

/** The 0 furthest from any 1. */
function largestVoid(pattern, energy) {
  let best = -1;
  let lowest = Infinity;
  for (let i = 0; i < CELLS; i++) {
    if (pattern[i] === 0 && energy[i] < lowest) {
      lowest = energy[i];
      best = i;
    }
  }
  return best;
}

function buildMatrix() {
  const random = seededRandom(0x5eed);
  const pattern = new Uint8Array(CELLS);
  const energy = new Float64Array(CELLS);

  const initial = Math.round(CELLS * INITIAL_FRACTION);
  let placed = 0;
  while (placed < initial) {
    const spot = Math.floor(random() * CELLS);
    if (pattern[spot] === 1) continue;
    pattern[spot] = 1;
    stamp(energy, spot, 1);
    placed++;
  }

  // Loosen the initial scatter until moving the tightest point can no longer
  // find a better hole: that fixed point is the prototype pattern.
  for (let guard = 0; guard < CELLS * 4; guard++) {
    const cluster = tightestCluster(pattern, energy);
    pattern[cluster] = 0;
    stamp(energy, cluster, -1);

    const hole = largestVoid(pattern, energy);
    if (hole === cluster) {
      pattern[cluster] = 1;
      stamp(energy, cluster, 1);
      break;
    }
    pattern[hole] = 1;
    stamp(energy, hole, 1);
  }

  const prototype = pattern.slice();
  const ranks = new Int32Array(CELLS).fill(-1);

  // Ranks below the prototype's population: strip it back point by point,
  // always taking the one in the densest company.
  const working = prototype.slice();
  const field = energy.slice();
  for (let rank = initial - 1; rank >= 0; rank--) {
    const cluster = tightestCluster(working, field);
    working[cluster] = 0;
    stamp(field, cluster, -1);
    ranks[cluster] = rank;
  }

  // Ranks above it: fill the emptiest hole each time. The classic formulation
  // splits this in two and switches to the complement halfway, but for a
  // symmetric linear filter the tightest cluster of zeros is exactly the
  // largest void, so the two halves are the same operation.
  working.set(prototype);
  field.set(energy);
  for (let rank = initial; rank < CELLS; rank++) {
    const hole = largestVoid(working, field);
    working[hole] = 1;
    stamp(field, hole, 1);
    ranks[hole] = rank;
  }

  // Ranks to thresholds, offset by half a step so neither 0 nor 1 is reachable.
  const matrix = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++) matrix[i] = (ranks[i] + 0.5) / CELLS;
  return matrix;
}

let cached = null;

/** The threshold tile, 0..1, one value per cell. Built once. */
export function blueNoiseMatrix() {
  if (cached === null) cached = buildMatrix();
  return cached;
}

export const BLUE_NOISE_SIZE = SIZE;
