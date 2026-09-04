// SPDX-License-Identifier: GPL-3.0-or-later
// Saving and copying the finished art.

import { createCanvas } from './canvas.js';

/** Canvas dimension browsers can be relied on to allocate. */
const MAX_PNG_SIDE = 8192;

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

export function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/**
 * Render braille text onto a canvas.
 *
 * Width comes from the widest line measured in the *same* font the page shows,
 * not from line 0 times a guessed 0.6em -- the old guess clipped output in any
 * font with a wider advance. If the result would exceed MAX_PNG_SIDE the whole
 * image is scaled down; it used to be cropped silently instead.
 *
 * Returns the canvas plus the scale that was applied, so the caller can tell
 * the user when the export was shrunk.
 */
export function renderTextToCanvas(text, { fontFamily, fontSize, lineHeight, foreground, background }) {
  const lines = text.split('\n');
  const font = `${fontSize}px ${fontFamily}`;

  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = font;
  let textWidth = 0;
  for (const line of lines) {
    textWidth = Math.max(textWidth, probe.measureText(line).width);
  }

  const rowHeight = fontSize * lineHeight;
  const width = Math.max(1, Math.ceil(textWidth));
  const height = Math.max(1, Math.ceil(lines.length * rowHeight));
  const scale = Math.min(1, MAX_PNG_SIDE / width, MAX_PNG_SIDE / height);

  const canvas = createCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = foreground;
  ctx.font = font;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 0, i * rowHeight);
  }
  return { canvas, scale };
}

/**
 * Copy to the clipboard, reporting why it failed when it does.
 * The async API needs a secure context, so this is one of the things that stops
 * working if the page is opened straight off the filesystem.
 */
export async function copyText(text) {
  if (!navigator.clipboard) {
    throw new Error('Буфер обмена недоступен — откройте страницу по http(s), а не как файл.');
  }
  await navigator.clipboard.writeText(text);
}
