// SPDX-License-Identifier: GPL-3.0-or-later
// Saving and copying the finished art.

import { createCanvas } from './canvas.js';
import { cellHex, colourRuns } from '../core/colour.js';

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
export function renderTextToCanvas(text, { fontFamily, fontSize, lineHeight, foreground, background, colours }) {
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
  ctx.font = font;
  ctx.textBaseline = 'top';
  const advance = probe.measureText(String.fromCharCode(0x28FF)).width;

  for (let i = 0; i < lines.length; i++) {
    if (!colours) {
      ctx.fillStyle = foreground;
      ctx.fillText(lines[i], 0, i * rowHeight);
      continue;
    }
    for (const { start, end, index } of colourRuns(colours, i, lines[i].length)) {
      ctx.fillStyle = cellHex(colours, index);
      ctx.fillText(lines[i].slice(start, end), start * advance, i * rowHeight);
    }
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
    throw Object.assign(new Error('no clipboard'), { i18n: 'status.clipboardUnavailable' });
  }
  await navigator.clipboard.writeText(text);
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/**
 * The art as SVG: one <text> per line, not one shape per dot.
 *
 * A 400x400 grid holds up to 1.28 million dots; drawn individually that is a
 * file nobody can open. As text it is a few kilobytes and stays selectable and
 * editable. The cost is that it renders in whatever monospace font the viewer
 * has, so the font stack is written out in full.
 */
export function brailleToSvg(text, { fontFamily, fontSize, lineHeight, foreground, background, colours }) {
  const lines = text.split('\n');
  const rowHeight = fontSize * lineHeight;

  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = `${fontSize}px ${fontFamily}`;
  let width = 0;
  for (const line of lines) width = Math.max(width, probe.measureText(line).width);
  width = Math.max(1, Math.ceil(width));
  const height = Math.max(1, Math.ceil(lines.length * rowHeight));

  const advance = probe.measureText(String.fromCharCode(0x28FF)).width;
  const body = lines.map((line, i) => {
    const y = (i * rowHeight).toFixed(2);
    if (!colours) {
      return `<text x="0" y="${y}" xml:space="preserve">${escapeXml(line)}</text>`;
    }
    // One element per run of equal colour, not per cell.
    return colourRuns(colours, i, line.length).map(({ start, end, index }) =>
      `<text x="${(start * advance).toFixed(2)}" y="${y}" fill="${cellHex(colours, index)}"`
      + ` xml:space="preserve">${escapeXml(line.slice(start, end))}</text>`).join('\n  ');
  }).join('\n  ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect width="100%" height="100%" fill="${escapeXml(background)}"/>`,
    `  <g font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${escapeXml(foreground)}" dominant-baseline="text-before-edge">`,
    `  ${body}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

export function downloadSvg(svg, filename) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- *
 * Colour
 *
 * A cell is one glyph and carries one colour, so every coloured format below
 * works the same way: walk each row in runs of near-enough equal colour and
 * emit one span, one escape or one draw call per run. Per cell would mean
 * 160,000 of them on a full-size grid.
 * -------------------------------------------------------------------------- */

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/**
 * A standalone page. Braille needs a font that has it, so the stack is written
 * out, and the background travels with the art -- light dots on a light page
 * would be invisible.
 */
export function brailleToHtml(text, colours, cols, { fontFamily, fontSize, lineHeight, foreground, background }) {
  const lines = text.split('\n');
  const body = lines.map((line, row) => {
    if (!colours) return escapeHtml(line);
    return colourRuns(colours, row, line.length)
      .map(({ start, end, index }) =>
        `<span style="color:${cellHex(colours, index)}">${escapeHtml(line.slice(start, end))}</span>`)
      .join('');
  }).join('\n');

  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Braille art</title>',
    `<pre style="margin:0;padding:16px;background:${background};color:${foreground};`
    + `font-family:${fontFamily};font-size:${fontSize}px;line-height:${lineHeight};`
    + 'white-space:pre;display:inline-block">',
    body,
    '</pre>',
    '',
  ].join('\n');
}

/**
 * Escapes for a terminal, 24-bit colour.
 *
 * Reset at the end of every line rather than only at the end: a truncated paste
 * then cannot leave the terminal stuck in the last colour it saw.
 */
export function brailleToAnsi(text, colours, cols) {
  const lines = text.split('\n');
  return lines.map((line, row) => {
    if (!colours) return line;
    const painted = colourRuns(colours, row, line.length).map(({ start, end, index }) => {
      const at = index * 3;
      return `${ESC}[38;2;${colours[at]};${colours[at + 1]};${colours[at + 2]}m${line.slice(start, end)}`;
    }).join('');
    return painted + RESET;
  }).join('\n') + '\n';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);

export function downloadHtml(html, filename) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}
