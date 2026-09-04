// SPDX-License-Identifier: GPL-3.0-or-later
// Turning tone into line.
//
// Both detectors return a plane in the same 0..255 units as luma, where a high
// value means "there is a line here". That matches the polarity of the tone
// path -- bright becomes a dot -- so the rest of the pipeline needs no special
// case, and the two can simply be mixed.

import { gaussianBlur } from './blur.js';

export const EDGE_MODES = Object.freeze(['none', 'sobel', 'xdog']);

/**
 * Sobel gradient: magnitude, and the two components it was built from.
 *
 * The components are kept because thinning needs to know which way the slope
 * runs, and recomputing them afterwards would mean convolving the image twice.
 */
export function gradient(plane, width, height) {
  const magnitude = new Float32Array(plane.length);
  const gx = new Float32Array(plane.length);
  const gy = new Float32Array(plane.length);
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
    const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
    return plane[cy * width + cx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const horizontal = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const vertical = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const i = y * width + x;
      // Peak magnitude of either axis is 4*255, so a quarter puts it back in range.
      const strength = Math.hypot(horizontal, vertical) / 4;
      magnitude[i] = strength > 255 ? 255 : strength;
      gx[i] = horizontal;
      gy[i] = vertical;
    }
  }
  return { magnitude, gx, gy };
}

/**
 * Sobel gradient magnitude.
 *
 * Fast and predictable, but it answers "how steep is it here", so a soft edge
 * comes back as a wide band rather than a line. `thin` is what turns the band
 * back into a line; on its own this is the map of where slope lives, which is
 * what the structure gate wants.
 */
export function sobel(plane, width, height) {
  return gradient(plane, width, height).magnitude;
}

/**
 * Keep only the crest of each ridge: non-maximum suppression.
 *
 * A gradient answers across the whole width of a slope, so a soft edge arrives
 * as a band -- measured, four pixels for a hard step and eleven for one that
 * fades over eight. That mattered little when the map was averaged down, but
 * line maps are now reduced by taking the strongest value, which hands the
 * band's peak to every dot it touches: an eleven-pixel band becomes three dots
 * of solid ink where one line belongs.
 *
 * A point survives only if it is at least as strong as the two points either
 * side of it *along the slope* -- across the ridge, never down its length.
 * Those two neighbours rarely land on whole pixels, so they are interpolated
 * from the four around them; quantising the direction to eight compass points
 * instead would make diagonal lines climb in steps.
 *
 * The comparison is >= on one side and > on the other. On a ridge of even width
 * the two crest pixels are exactly equal, and a symmetric test would either
 * keep both or, worse, discard both and erase the edge.
 */
export function thin({ magnitude, gx, gy }, width, height) {
  const out = new Float32Array(magnitude.length);

  // Bilinear read, clamped at the border like the gradient itself.
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
    const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = cx - x0, fy = cy - y0;
    const top = magnitude[y0 * width + x0] * (1 - fx) + magnitude[y0 * width + x1] * fx;
    const bottom = magnitude[y1 * width + x0] * (1 - fx) + magnitude[y1 * width + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const here = magnitude[i];
      if (here <= 0) continue;

      // Step one full pixel along the longer component, so the neighbours are
      // always on the next row or column rather than somewhere inside this one.
      const reach = Math.max(Math.abs(gx[i]), Math.abs(gy[i]));
      if (reach === 0) { out[i] = here; continue; }
      const dx = gx[i] / reach, dy = gy[i] / reach;

      if (here >= at(x + dx, y + dy) && here > at(x - dx, y - dy)) out[i] = here;
    }
  }
  return out;
}

// Difference-of-Gaussians with a soft threshold, after Winnemoeller. Only sigma
// is worth exposing; the rest behave for line art as they are.
const K = 1.6;    // ratio between the two blurs
const TAU = 1;    // how much of the wider blur is subtracted
const PHI = 60;   // steepness of the ink ramp
//
// TAU is deliberately 1 rather than the ~0.98 the paper uses for stylisation.
// Below 1 the flat-field response is l*(1-TAU) -- proportional to brightness --
// so an even mid-grey answers with ink and dark areas silt up with strokes that
// are not edges. At exactly 1 a flat region cancels to zero at any level, and
// the detector reports lines and nothing else. Tone comes back through the
// fill/line mix instead, where it can be dialled.

/**
 * XDoG: the difference between two Gaussians, run through a soft threshold.
 *
 * Where Sobel reports a slope, this reports a *stroke* -- the difference goes
 * negative only on the dark side of an edge, so the result is a one-sided line
 * of varying weight rather than a band straddling the boundary. That variation
 * is what the 2x4 cell grid renders well, and it is why this suits line art,
 * comics and drawings.
 */
export function xdog(plane, width, height, sigma) {
  const near = gaussianBlur(plane, width, height, sigma);
  const far = gaussianBlur(plane, width, height, sigma * K);
  const out = new Float32Array(plane.length);

  for (let i = 0; i < plane.length; i++) {
    const difference = (near[i] - TAU * far[i]) / 255; // work in 0..1
    // Only the dark side of an edge goes negative, and that is where ink lands.
    // The ramp is soft rather than a hard cut so stroke weight varies with edge
    // strength, which is the part a 2x4 cell grid can actually show.
    const ink = difference >= 0 ? 0 : -Math.tanh(PHI * difference);
    out[i] = ink > 1 ? 255 : ink * 255;
  }
  return out;
}

/**
 * How much organised structure sits at each point.
 *
 * Gradient after a light blur, which is what separates a real feature from
 * noise: measured on a one-pixel line the response is about 66 and on noise
 * 24-30, against 115 for a genuine boundary.
 */
export const structureMap = (plane, width, height) => sobel(gaussianBlur(plane, width, height, 1), width, height);

/**
 * The line map alone, at whatever resolution it is handed.
 *
 * Separate from the mixing because the two now happen in different places:
 * lines are found on the detailed raster, where the structure still exists, and
 * mixed with tone afterwards, at the size of the cell grid.
 */
export function lineMap(plane, width, height, { mode = 'none', radius = 1, clean = 0 } = {}) {
  if (mode === 'none') return null;
  if (!EDGE_MODES.includes(mode)) throw new RangeError(`unknown edge mode: ${mode}`);

  // Both detectors amplify noise, so smooth first. For xdog this same radius is
  // the stroke width; for sobel it is purely denoising.
  const found = mode === 'sobel'
    ? thin(gradient(gaussianBlur(plane, width, height, radius), width, height), width, height)
    : xdog(plane, width, height, radius);

  // Cleaning comes last, after thinning: seeds should be crests, not the
  // shoulders of a band that is about to be thrown away.
  if (!(clean > 0)) return found;
  const amount = Math.min(1, clean);

  // Two questions, asked in this order. First, is this ink pointing the same
  // way as its neighbours -- which is what tells a contour from texture at all.
  // Then, given what survived that, is it strong or at least joined to
  // something strong. Weighting first means the seeds are chosen from ink that
  // has already been judged, rather than from whatever happened to be brightest.
  const directed = weighByCoherence(found, coherenceMap(plane, width, height), amount);
  const { high, low } = cleanThresholds(directed, amount);
  const kept = hysteresis(directed, width, height, high, low);

  // The weighting decided what to keep; the ink itself goes back to the weight
  // the detector gave it, so a surviving stroke is as dark as it earned.
  const out = new Float32Array(kept.length);
  for (let i = 0; i < kept.length; i++) out[i] = kept[i] > 0 ? found[i] : 0;
  return out;
}

/**
 * How far the directions in a neighbourhood must agree to count as one.
 *
 * Measured across three pictures at 2, 4 and 8: the spread between the most and
 * least coherent tenth of the ink grows with it -- about ten times at 2, sixteen
 * at 8 on a landscape -- but so does the smearing of small features. Four is
 * where the contours came out whole and the texture had already collapsed.
 */
const COHERENCE_RADIUS = 4;

/**
 * Whether the gradient round here agrees with itself.
 *
 * Magnitude says how much is happening; this says whether it is all one thing.
 * The products of the gradient components are smoothed into a little matrix per
 * point -- the structure tensor -- and what comes back is how far apart its two
 * eigenvalues are. A boundary pushes all its energy one way and answers near 1.
 * Texture pushes it every way at once and answers near 0.
 *
 * This is the measure that finally separates the two. A single threshold cannot,
 * because a blade of grass is a genuinely sharp edge; hysteresis cannot either,
 * for the same reason. Measured over the ink XDoG lays on a photograph, the most
 * coherent tenth stands about twelve times above the least -- against a factor
 * of 2.4 for the plain gradient, which was too little to lean on.
 */
/**
 * The cost of this is the three blurs, and it is the largest single cost in the
 * whole edge path: 744ms of about 800 on a two-megapixel raster, against 21ms
 * for the hysteresis that follows it. Two ways out were measured and both
 * damage the answer, so neither was taken.
 *
 * Computing it at half resolution and sampling back up is four times cheaper
 * and moves 30% of the lit dots on a photograph -- the map is smooth, but the
 * thresholds after it are percentiles, so a small shift in value moves a great
 * many borderline pixels across the line. Three box passes in place of the
 * Gaussian is twice as cheap and shifts the coherence itself by 0.07 to 0.14 on
 * a scale of one, which is a large fraction of the thing being measured.
 *
 * So the cost stands, and what carries it is the pacing: a redraw that grows too
 * slow to follow the controls stops following them and says so, which is what
 * that mechanism is for. At sixty columns the whole redraw is around 310ms and
 * still live; the price appears on large grids with lines turned on.
 */
export function coherenceMap(plane, width, height, radius = COHERENCE_RADIUS) {
  const { gx, gy } = gradient(plane, width, height);
  const xx = new Float32Array(gx.length);
  const yy = new Float32Array(gx.length);
  const xy = new Float32Array(gx.length);
  for (let i = 0; i < gx.length; i++) {
    xx[i] = gx[i] * gx[i];
    yy[i] = gy[i] * gy[i];
    xy[i] = gx[i] * gy[i];
  }

  const sxx = gaussianBlur(xx, width, height, radius);
  const syy = gaussianBlur(yy, width, height, radius);
  const sxy = gaussianBlur(xy, width, height, radius);

  const out = new Float32Array(gx.length);
  for (let i = 0; i < out.length; i++) {
    const trace = sxx[i] + syy[i];
    if (trace <= 1e-6) continue;
    const difference = sxx[i] - syy[i];
    const apart = Math.sqrt(difference * difference + 4 * sxy[i] * sxy[i]);
    // Squared, which is the usual form: it pushes the merely-somewhat-directed
    // down towards the texture where they belong.
    out[i] = (apart / trace) ** 2;
  }
  return out;
}

/**
 * Dim whatever the neighbourhood does not agree about.
 *
 * Doubling before the clamp is measured, not decorative: past a coherence of
 * about a half a feature is as directed as it is going to get, and anything
 * stronger only starts eating the ends of real strokes, where a line meets
 * another and the directions genuinely disagree.
 */
export function weighByCoherence(lines, coherence, amount) {
  if (!(amount > 0)) return lines;
  const out = new Float32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const directed = Math.min(1, coherence[i] * 2);
    out[i] = lines[i] * (1 - amount * (1 - directed));
  }
  return out;
}

/**
 * The value at a given percentile of everything that answered at all.
 *
 * Thresholds are taken from the picture rather than fixed, because the same
 * number means different things in different images: a drawing answers with a
 * few strong strokes, a photograph of a forest answers everywhere. A histogram
 * rather than a sort -- there can be two million values, and whole levels are
 * already the units the map lives in.
 */
export function responseAt(plane, fraction) {
  const bins = new Uint32Array(256);
  let lit = 0;
  for (let i = 0; i < plane.length; i++) {
    // Below 1 is silence rather than a faint line. Counting it would drag every
    // percentile to nothing on a frame that is mostly empty.
    if (plane[i] > 1) { bins[Math.min(255, Math.floor(plane[i]))]++; lit++; }
  }
  if (!lit) return Infinity;

  const wanted = lit * fraction;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += bins[value];
    // The floor of the bin, not its middle or its top: what comes back is used
    // as ">= this survives", and a threshold rounded upward sits above the very
    // values it was derived from. An even edge, every pixel of it answering
    // alike, was erased completely by that -- one bin, and a seed nobody met.
    if (seen > wanted) return value;
  }
  return 255;
}

/**
 * Keep what is strong, and what leads back to it.
 *
 * Both detectors answer to texture as readily as to a boundary, and no single
 * threshold tells them apart, because a blade of grass really is a sharp little
 * edge. What separates them is not strength but company: a contour is a faint
 * stretch continuing from a strong one, while texture is a speck whose
 * neighbours are specks too.
 *
 * So strong points are seeds, and merely plausible ones are kept only where
 * they can be traced back to a seed. Measured on a photograph of a hillside
 * this halves the ink -- 37% of the frame down to 18% -- while the median run
 * of connected ink grows from 12 pixels to 30: less of it, in longer strokes.
 * On a clean graphic the speckled background disappears completely and the
 * lettering is untouched.
 *
 * Surround inhibition was tried first and rejected on the numbers. Subtracting
 * a blurred copy eats strokes from the middle outward -- a strong stroke is its
 * own surround -- and the annulus form that avoids that removes almost nothing
 * from a photograph, where the ring is as busy under a contour as anywhere.
 */
export function hysteresis(plane, width, height, high, low) {
  const kept = new Float32Array(plane.length);
  const stack = [];
  for (let i = 0; i < plane.length; i++) {
    if (plane[i] >= high) { kept[i] = plane[i]; stack.push(i); }
  }

  // Eight-connected, so a diagonal continuation counts as touching. Four would
  // break every slanted line into dashes, which is what this is meant to undo.
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (kept[n] || plane[n] < low) continue;
        kept[n] = plane[n];
        stack.push(n);
      }
    }
  }
  return kept;
}

/**
 * Where the two thresholds sit for a given amount of cleaning.
 *
 * The seeding percentile was measured rather than guessed: the top tenth of
 * what answered, grown into everything above the median, is what halved the ink
 * on a photograph while leaving a graphic's lettering alone. The default lands
 * there. Zero is off, exactly as before, so a link saved by an earlier version
 * still renders what it rendered.
 */
export function cleanThresholds(plane, amount) {
  const seed = 0.5 + 0.45 * amount;
  return { high: responseAt(plane, seed), low: responseAt(plane, Math.max(0, seed - 0.4)) };
}

/** Blend a line map into a tone plane. Both must be the same size. */
export function mixLines(tone, lines, amount) {
  if (!lines || !(amount > 0)) return tone;
  if (amount >= 1) return lines;

  const out = new Float32Array(tone.length);
  for (let i = 0; i < tone.length; i++) {
    out[i] = tone[i] * (1 - amount) + lines[i] * amount;
  }
  return out;
}

/** Detect and mix at one resolution. Kept for callers that have only one. */
export function applyEdges(plane, width, height, { mode = 'none', amount = 1, radius = 1, clean = 0 } = {}) {
  if (mode === 'none' || !(amount > 0)) return plane;
  return mixLines(plane, lineMap(plane, width, height, { mode, radius, clean }), amount);
}
