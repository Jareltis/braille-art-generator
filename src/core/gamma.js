// SPDX-License-Identifier: GPL-3.0-or-later
// sRGB is not linear in light, and dot coverage is.
//
// Half the dots in a cell lit emits half the light, so the fraction of raised
// dots that reproduces a tone is that tone's *linear* luminance. Diffusing
// error over gamma-encoded values -- which is what almost every converter of
// this kind does, and what this one did until 0.9 -- preserves the average of
// the wrong quantity and comes out systematically too light.
//
// Everything here works on 0..255 integers, so the transfer function is a
// lookup rather than a pow() per channel per pixel.

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const channel = i / 255;
  SRGB_TO_LINEAR[i] = channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** One sRGB channel, 0..255, to linear light, 0..1. */
export const srgbToLinear = (value) => SRGB_TO_LINEAR[value < 0 ? 0 : value > 255 ? 255 : Math.round(value)];

/** Linear light, 0..1, back to an sRGB channel, 0..255. */
export function linearToSrgb(linear) {
  const clamped = linear < 0 ? 0 : linear > 1 ? 1 : linear;
  const channel = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return channel * 255;
}

/**
 * Relative luminance in linear light, scaled to 0..255.
 *
 * BT.709 coefficients, which belong with linear values -- the BT.601 set this
 * used before is for gamma-encoded ones, and applying either to the wrong space
 * misjudges saturated colours badly. Pure blue came out at 29 of 255 where its
 * luminance is closer to 18, and its *lightness* to 82.
 */
export function luminance(r, g, b) {
  return (0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b]) * 255;
}

/**
 * The same colour in L*a*b*, where distance means roughly what the eye means.
 *
 * Nothing in the tone pipeline needs this -- coverage answers to light, not to
 * hue -- but choosing between palette entries does: straight distance between
 * sRGB numbers treats a step in dark green as the same size as a step in pale
 * yellow, and the eye does not. D65, which is what sRGB is defined against.
 *
 * L* here is on its own 0..100 scale rather than the 0..255 the tone path uses,
 * because a and b have no such scaling and mixing the two would make the
 * distance mean nothing.
 */
const WHITE = [0.95047, 1, 1.08883];
const fold = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function lab(r, g, b) {
  // srgbToLinear already answers in 0..1; dividing again is how white came out
  // at L* 3.5 the first time this was written.
  const red = srgbToLinear(r);
  const green = srgbToLinear(g);
  const blue = srgbToLinear(b);

  const x = fold((0.4124 * red + 0.3576 * green + 0.1805 * blue) / WHITE[0]);
  const y = fold((0.2126 * red + 0.7152 * green + 0.0722 * blue) / WHITE[1]);
  const z = fold((0.0193 * red + 0.1192 * green + 0.9505 * blue) / WHITE[2]);

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * And back out of L*a*b* again, to sRGB channels.
 *
 * Only one caller needs this -- choosing where a palette entry should sit, once
 * the colours it has to cover are known -- but that caller measures distance in
 * L*a*b*, so the middle of what it caught is the mean in L*a*b* too, and the
 * mean has to be turned back into a colour that can be shown.
 *
 * Out-of-gamut answers are possible and are simply clamped: the mean of two
 * real colours can sit outside what a screen can make, and the nearest thing it
 * can make is the honest reply.
 */
const unfold = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);

export function fromLab(l, a, b) {
  const fy = (l + 16) / 116;
  const x = unfold(fy + a / 500) * WHITE[0];
  const y = unfold(fy) * WHITE[1];
  const z = unfold(fy - b / 200) * WHITE[2];
  return [
    Math.round(linearToSrgb(3.2406 * x - 1.5372 * y - 0.4986 * z)),
    Math.round(linearToSrgb(-0.9689 * x + 1.8758 * y + 0.0415 * z)),
    Math.round(linearToSrgb(0.0557 * x - 0.2040 * y + 1.0570 * z)),
  ];
}

/**
 * Perceptual lightness (CIE L*), scaled to 0..255.
 *
 * Edge detection belongs here, not in linear light. A difference of Gaussians
 * answers to curvature, and the linear luminance of a smooth visual ramp is
 * strongly convex -- run in linear light, XDoG reports an edge across an entire
 * gradient. In lightness that same ramp is nearly straight and the response is
 * correctly nothing.
 */
export function lightness(r, g, b) {
  const y = luminance(r, g, b) / 255;
  const l = y <= 0.008856 ? 903.3 * y : 116 * Math.cbrt(y) - 16;
  return l * 2.55;
}

/**
 * The threshold control stays in sRGB, where 128 is the middle of the ramp the
 * user sees, and is converted here for comparison against linear samples.
 * Without this the same slider position would suddenly mean something far
 * brighter and every existing setting would shift.
 */
export const thresholdToLinear = (value) => srgbToLinear(value) * 255;

/** The inverse, for reporting a computed threshold back to the control. */
export const linearToThreshold = (value) => linearToSrgb(value / 255);
