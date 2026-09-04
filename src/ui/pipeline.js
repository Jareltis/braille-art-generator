// SPDX-License-Identifier: GPL-3.0-or-later
// One interface over "in a worker" and "right here".

import { applyAdjustments } from '../core/adjust.js';
import { encode, tonePlane } from '../core/braille.js';
import { otsuThreshold } from '../core/otsu.js';
import { variantsOf } from '../core/variants.js';
import { linearToThreshold } from '../core/gamma.js';
import { pack, transferOf, unpack } from '../worker/protocol.js';

function workerPipeline(worker) {
  const pending = new Map();
  let nextId = 0;

  worker.addEventListener('message', ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === 'error') entry.reject(new Error(data.message));
    else entry.resolve(data);
  });

  // A worker that dies mid-flight must not leave callers awaiting forever.
  worker.addEventListener('error', (event) => {
    const failure = new Error(event.message || 'сбой фонового потока');
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  });

  const send = (type, payload, transfer = []) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });

  return {
    offThread: true,
    setPreview(imageData) {
      const image = pack(imageData);
      return send('setPreview', { image }, transferOf(image));
    },
    async preview(params) {
      const { image } = await send('preview', { params });
      return image ? unpack(image) : null;
    },
    async generate(imageData, params, options) {
      const image = pack(imageData);
      const result = await send('generate', { image, params, options }, transferOf(image));
      return {
        text: result.text,
        pixels: unpack(result.image),
        colours: result.colours ?? null,
        cols: result.cols,
        rows: result.rows,
      };
    },
    async otsu(imageData, params, options) {
      const image = pack(imageData);
      const { threshold } = await send('otsu', { image, params, options }, transferOf(image));
      return threshold;
    },
    async variants(imageData, params, options, want) {
      const image = pack(imageData);
      const result = await send('variants', { image, params, options, want }, transferOf(image));
      return result.variants;
    },
  };
}

function inlinePipeline() {
  let previewSource = null;
  return {
    offThread: false,
    async setPreview(imageData) {
      previewSource = imageData;
    },
    async preview(params) {
      return previewSource ? applyAdjustments(previewSource, params) : null;
    },
    async generate(imageData, params, options) {
      const { text, colours, cols, rows, plane } = encode(applyAdjustments(imageData, params), options);
      const preview = new ImageData(cols * 2, rows * 4);
      for (let i = 0, at = 0; i < plane.length; i++, at += 4) {
        const value = plane[i] < 0 ? 0 : plane[i] > 255 ? 255 : plane[i];
        preview.data[at] = preview.data[at + 1] = preview.data[at + 2] = value;
        preview.data[at + 3] = 255;
      }
      return { text, pixels: preview, colours, cols, rows };
    },
    async otsu(imageData, params, options) {
      // Same measurement and the same crossing back as the worker does.
      const { plane, linear } = tonePlane(applyAdjustments(imageData, params), options);
      const chosen = otsuThreshold(plane);
      return Math.round(linear ? linearToThreshold(chosen) : chosen);
    },
    async variants(imageData, params, options, want) {
      return variantsOf(applyAdjustments(imageData, params), options, want);
    },
  };
}

/**
 * Off the main thread where the browser allows it, inline where it does not --
 * module workers need a real origin, so a page opened straight off disk falls
 * back rather than breaking. Callers cannot tell the difference apart from
 * `offThread`, which only exists so the UI can say which one is running.
 */
export function createPipeline() {
  try {
    const worker = new Worker(new URL('../worker/pipeline.worker.js', import.meta.url), { type: 'module' });
    return workerPipeline(worker);
  } catch {
    return inlinePipeline();
  }
}
