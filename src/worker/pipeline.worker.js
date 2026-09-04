// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the pixel work off the main thread.
//
// It imports the same core modules the page does -- that is what core/ being
// free of document was for.

import { applyAdjustments } from '../core/adjust.js';
import { encode, tonePlane } from '../core/braille.js';
import { otsuThreshold } from '../core/otsu.js';
import { linearToThreshold } from '../core/gamma.js';
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
    const { text, colours, cols, rows } = encode(pixels, options);
    const out = pack(pixels);
    const transfer = transferOf(out);
    if (colours) transfer.push(colours.buffer);
    return { payload: { text, colours, cols, rows, image: out }, transfer };
  },

  otsu({ image, params, options }) {
    const pixels = applyAdjustments(unpack(image), params);
    // Measured on the plane the encoder will actually threshold, so the answer
    // suits line mode as well as tone, and reported back in the slider's units.
    const { plane, linear } = tonePlane(pixels, options);
    const chosen = otsuThreshold(plane);
    return { payload: { threshold: Math.round(linear ? linearToThreshold(chosen) : chosen) } };
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
