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
 * `crop` selects a region, given in fractions of the source so it does not have
 * to be recomputed when the preview is drawn at a different size. It is cut at
 * full resolution before anything is scaled, so cropping costs no detail.
 *
 * `smooth: false` skips both the halving chain and interpolation. Pixel art
 * needs that: averaging neighbouring pixels is exactly what destroys a grid
 * that was drawn one pixel at a time.
 */
export function drawScaled(source, w, h, background, { smooth = true, crop = null } = {}) {
  const sourceW = source.naturalWidth || source.width;
  const sourceH = source.naturalHeight || source.height;

  let current = source;
  let cw = sourceW;
  let ch = sourceH;

  if (crop) {
    cw = Math.max(1, Math.round(crop.w * sourceW));
    ch = Math.max(1, Math.round(crop.h * sourceH));
    const cut = createCanvas(cw, ch);
    context2d(cut).drawImage(
      source,
      crop.x * sourceW, crop.y * sourceH, crop.w * sourceW, crop.h * sourceH,
      0, 0, cw, ch,
    );
    current = cut;
  }

  if (!smooth) {
    const out = createCanvas(w, h);
    const ctx = context2d(out);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(current, 0, 0, cw, ch, 0, 0, w, h);
    return out;
  }

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


/**
 * Whether this machine can actually draw a character.
 *
 * Not "is the character in Unicode" -- it always is -- but "does the font in
 * front of the user have a glyph for it". A missing glyph is drawn as the
 * font's own notdef box, so the test is to draw the character and the one code
 * point guaranteed to have no glyph anywhere, and compare the pixels. Blank is
 * compared too, or a space would pass as a drawn character.
 *
 * Needed because the octant blocks are new enough (Unicode 16, 2024) that
 * offering them blind would put boxes in someone's picture.
 */
export function canDraw(codePoint, fontFamily, size = 28) {
  const canvas = createCanvas(size * 2, size * 2);
  const ctx = context2d(canvas);
  const paint = (text) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${size}px ${fontFamily}`;
    ctx.fillStyle = '#000000';
    ctx.fillText(text, size * 0.2, size * 1.2);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data.join(',');
  };

  // U+10FFFF is a noncharacter: nothing has a glyph for it, so whatever comes
  // back is this font's way of saying "I cannot draw that".
  const notdef = paint(String.fromCodePoint(0x10FFFF));
  const blank = paint(' ');
  const wanted = paint(String.fromCodePoint(codePoint));
  return wanted !== notdef && wanted !== blank;
}
