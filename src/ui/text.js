// SPDX-License-Identifier: GPL-3.0-or-later
// Text as a source image.
//
// Rather than carrying a bitmap font, the text is drawn to a canvas with the
// fonts the machine already has and then handed to the ordinary pipeline. A
// canvas is an acceptable drawImage source, so everything downstream -- edges,
// dithering, cropping, the exports, dot editing -- works on lettering exactly
// as it does on a photograph.

import { createCanvas, context2d } from './canvas.js';

/**
 * Drawn far larger than any output grid, then reduced by the same box filter
 * everything else goes through. Rendering near the target size instead would
 * hand the encoder the browser's own hinting and anti-aliasing decisions.
 */
const RENDER_SIZE = 200;
const LINE_SPACING = 1.15;
const PADDING = 0.18;      // of RENDER_SIZE, so strokes never touch the edge

export const TEXT_FONTS = Object.freeze({
  sans: { label: 'Без засечек', stack: 'Inter, "Segoe UI", system-ui, sans-serif' },
  serif: { label: 'С засечками', stack: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Моноширинный', stack: '"Cascadia Mono", "DejaVu Sans Mono", monospace' },
  display: { label: 'Плакатный', stack: 'Impact, "Arial Black", "Segoe UI", sans-serif' },
});

export const DEFAULT_TEXT_FONT = 'display';

/**
 * Render `text` to an opaque canvas: white letters on black, which is the
 * polarity the encoder already reads as "dot here" without inversion.
 */
export function renderText(text, { font = DEFAULT_TEXT_FONT, bold = true, italic = false } = {}) {
  const lines = String(text ?? '').split('\n');
  const stack = (TEXT_FONTS[font] ?? TEXT_FONTS[DEFAULT_TEXT_FONT]).stack;
  const css = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${RENDER_SIZE}px ${stack}`;

  const probe = context2d(createCanvas(1, 1));
  probe.font = css;

  let widest = 0;
  for (const line of lines) widest = Math.max(widest, probe.measureText(line).width);

  const padding = RENDER_SIZE * PADDING;
  const lineHeight = RENDER_SIZE * LINE_SPACING;
  const canvas = createCanvas(
    Math.max(1, Math.ceil(widest + padding * 2)),
    Math.max(1, Math.ceil(lines.length * lineHeight + padding * 2)),
  );

  const ctx = context2d(canvas);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = css;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padding, padding + i * lineHeight);
  }
  return canvas;
}
