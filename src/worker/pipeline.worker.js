// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the pixel work off the main thread.
//
// It imports the same core modules the page does -- that is what core/ being
// free of document was for.

import { applyAdjustments } from '../core/adjust.js';
import { imageDataToBraille, toLuma } from '../core/braille.js';
import { otsuThreshold } from '../core/otsu.js';
import { pack, transferOf, unpack } from './protocol.js';

/** The adjusted-preview source, kept here so dragging a slider sends only the
 *  slider values rather than the whole image. */
let previewSource = null;

const handlers = {
  setPreview({ image }) {
    previewSource = unpack(image);
    return { payload: {} };
  },

  preview({ params }) {
    if (!previewSource) return { payload: {} };
    const image = pack(applyAdjustments(previewSource, params));
    return { payload: { image }, transfer: transferOf(image) };
  },

  generate({ image, params, options }) {
    const pixels = applyAdjustments(unpack(image), params);
    const text = imageDataToBraille(pixels, options);
    const out = pack(pixels);
    return { payload: { text, image: out }, transfer: transferOf(out) };
  },

  otsu({ image, params }) {
    const pixels = applyAdjustments(unpack(image), params);
    return { payload: { threshold: otsuThreshold(toLuma(pixels)) } };
  },
};

self.addEventListener('message', ({ data: request }) => {
  const handler = handlers[request.type];
  if (!handler) return;
  try {
    const { payload, transfer = [] } = handler(request);
    self.postMessage({ id: request.id, type: request.type, ...payload }, transfer);
  } catch (error) {
    self.postMessage({ id: request.id, type: 'error', message: String(error?.message ?? error) });
  }
});
