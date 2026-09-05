// SPDX-License-Identifier: GPL-3.0-or-later
// Saving and copying the finished art.

import { TERMINAL_PALETTES, ansiForeground, nearest } from '../core/palette.js';
import { createCanvas } from './canvas.js';
import { cellHex, colourRuns } from '../core/colour.js';
import { drawLattice } from './lattice.js';

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
 * Render the art by drawing its dots, rather than by setting its text.
 *
 * An exported image is ours from end to end, so it is drawn rather than
 * typeset: an even lattice, no font in the chain, and the same picture on every
 * machine that opens it. The reasoning is in `lattice.js`, along with the
 * drawing itself -- the screen shows the art the same way, and one function
 * keeps the two from drifting apart.
 *
 * The cell keeps the proportions the art was laid out for -- the advance and
 * the line height measured from the page -- so the exported picture has the
 * shape the screen promised.
 */
export function renderDotsToCanvas(text, { advancePx, lineHeightPx, foreground, background, colours }) {
  const lines = text.split('\n');
  const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const cellW = Math.max(2, advancePx);
  const cellH = Math.max(4, lineHeightPx);

  const width = Math.max(1, Math.ceil(widest * cellW));
  const height = Math.max(1, Math.ceil(lines.length * cellH));
  const scale = Math.min(1, MAX_PNG_SIDE / width, MAX_PNG_SIDE / height);

  const canvas = createCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  drawLattice(ctx, lines, { cellW, cellH, cols: widest, foreground, colours });

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
  await refused(navigator.clipboard.writeText(text));
}

/**
 * A clipboard the browser refuses is not an error worth quoting.
 *
 * Permission can be denied, or the page can have lost focus between the click
 * and the write, and what comes back is an English sentence from the engine.
 * Showing that raw is the one place this app would speak in a language it does
 * not have a dictionary for.
 */
function refused(writing) {
  return writing.catch(() => {
    throw Object.assign(new Error('clipboard refused'), { i18n: 'status.clipboardRefused' });
  });
}

/**
 * Copy the art as a picture rather than as text.
 *
 * Braille survives most chats intact, but not all of them: line height is set
 * by the room, and a picture cannot be squashed by it. This is the escape hatch
 * for the places where the text arrives stretched.
 *
 * The write has to be started from the click itself -- a clipboard write that
 * arrives after an await of its own is refused as untrusted in some browsers --
 * so the blob is handed over as a promise and the browser waits for it.
 */
export async function copyCanvas(canvas) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw Object.assign(new Error('no image clipboard'), { i18n: 'status.clipboardNoImage' });
  }
  const png = new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no blob'))), 'image/png');
  });
  await refused(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]));
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
/**
 * The art with colour, for a terminal.
 *
 * `palette` says what the receiving end can read. Twenty-four-bit codes are the
 * default and the best answer where they work, but a terminal that has only 256
 * colours -- or sixteen -- does not ignore the rest: it prints them, and the art
 * arrives buried in escape sequences. So when the colours have been snapped to
 * one of those palettes, the entry is named by its index instead.
 */
export function brailleToAnsi(text, colours, cols, palette = 'full') {
  const fixed = TERMINAL_PALETTES[palette] ?? null;
  const known = fixed ? new Map() : null;
  const lines = text.split('\n');
  return lines.map((line, row) => {
    if (!colours) return line;
    const painted = colourRuns(colours, row, line.length).map(({ start, end, index }) => {
      const at = index * 3;
      const select = fixed
        ? ansiForeground(palette, nearest(fixed, colours[at], colours[at + 1], colours[at + 2], known))
        : `38;2;${colours[at]};${colours[at + 1]};${colours[at + 2]}`;
      return `${ESC}[${select}m${line.slice(start, end)}`;
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
