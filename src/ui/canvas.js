// SPDX-License-Identifier: GPL-3.0-or-later
// Canvas plumbing. Separated from core/ so the encoder stays DOM-free.

export function createCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function context2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * Draw `source` into an opaque w x h canvas, halving each axis while it is
 * still more than twice the target so large reductions do not alias.
 *
 * The background is laid down first, so transparent pixels composite onto it
 * instead of reading as black.
 *
 * `smooth: false` skips both the halving chain and interpolation. Pixel art
 * needs that: averaging neighbouring pixels is exactly what destroys a grid
 * that was drawn one pixel at a time.
 */
export function drawScaled(source, w, h, background, { smooth = true } = {}) {
  if (!smooth) {
    const out = createCanvas(w, h);
    const ctx = context2d(out);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, w, h);
    return out;
  }

  let current = source;
  let cw = source.naturalWidth || source.width;
  let ch = source.naturalHeight || source.height;

  // Bounded: every pass halves at least one axis, so it cannot spin.
  for (let guard = 0; guard < 16 && (cw > w * 2 || ch > h * 2); guard++) {
    const nw = cw > w * 2 ? Math.max(w, cw >> 1) : cw;
    const nh = ch > h * 2 ? Math.max(h, ch >> 1) : ch;
    const step = createCanvas(nw, nh);
    const stepCtx = step.getContext('2d');
    stepCtx.imageSmoothingEnabled = true;
    stepCtx.imageSmoothingQuality = 'high';
    stepCtx.drawImage(current, 0, 0, cw, ch, 0, 0, nw, nh);
    current = step;
    cw = nw;
    ch = nh;
  }

  const out = createCanvas(w, h);
  const ctx = context2d(out);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, cw, ch, 0, 0, w, h);
  return out;
}

/** Read a whole canvas back as ImageData. */
export function readImageData(canvas) {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

/** Paint ImageData onto a canvas, resizing the canvas to match. */
export function putImageData(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  context2d(canvas).putImageData(imageData, 0, 0);
}
