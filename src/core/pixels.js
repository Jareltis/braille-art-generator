// SPDX-License-Identifier: GPL-3.0-or-later
// Pure pixel maths. No document, no canvas -- only ImageData, which exists in
// workers too, so everything under core/ can be moved off the main thread as-is.

/** BT.601 luma over gamma-encoded sRGB. */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Largest size inside maxW x maxH that keeps the source ratio. Never upscales. */
export function fitWithin(srcW, srcH, maxW, maxH) {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}
