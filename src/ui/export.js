// SPDX-License-Identifier: GPL-3.0-or-later
// Saving and copying the finished art.

import { TERMINAL_PALETTES, ansiBackground, ansiForeground, nearest } from '../core/palette.js';
import { createCanvas } from './canvas.js';
import { cellHex, colourRuns } from '../core/colour.js';
import { drawLattice } from './lattice.js';
import { cellsOf } from '../core/glyphs.js';

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
export function renderDotsToCanvas(text, {
  advancePx, lineHeightPx, foreground, background, colours, ground = null, fill = 'dots',
}) {
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

  drawLattice(ctx, lines, { cellW, cellH, cols: widest, foreground, colours, ground, fill });

  return { canvas, scale };
}

/**
 * Hand the art to another app.
 *
 * Sharing is the phone's version of copying: the chat is not on the clipboard
 * there, it is behind the share sheet. What travels is the picture, because the
 * text is already one button away and a picture is the thing a room with its own
 * line height cannot squash. A browser that shares text but not files still gets
 * the art, as text -- and the caller is told which of the two went, because
 * saying "shared" about the wrong one would be a lie.
 *
 * Dismissing the sheet is not a failure and is not reported as one.
 */
export function canShare() {
  return typeof navigator.share === 'function';
}

async function handOver(payload) {
  try {
    await navigator.share(payload);
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') return false;
    throw Object.assign(new Error('share refused'), { i18n: 'status.shareRefused' });
  }
}

/**
 * The picture, built without waiting for anything.
 *
 * `toBlob` is the tidier call and the wrong one here: sharing needs the tap it
 * was started by, and on iOS an await between the two loses it. `toDataURL` is
 * synchronous, so the sheet opens while the tap still counts. The base64 detour
 * costs a third more memory for the moment it takes to unpack.
 */
function pictureOf(canvas, filename) {
  const url = canvas.toDataURL('image/png');
  // A canvas too large to encode comes back as "data:," rather than as an
  // error, and sharing that would hand another app an empty file.
  if (!url.startsWith('data:image/png')) return null;
  const encoded = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
  return new File([bytes], filename, { type: 'image/png' });
}

export function shareArt(canvas, text, { filename, title }) {
  if (!canShare()) {
    throw Object.assign(new Error('no share'), { i18n: 'status.shareUnavailable' });
  }

  const file = pictureOf(canvas, filename);
  const takesFiles = file
    && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));
  const payload = takesFiles ? { files: [file], title } : { text, title };

  return handOver(payload).then((went) => (went ? (takesFiles ? 'picture' : 'text') : 'cancelled'));
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
export function brailleToSvg(text, {
  fontFamily, fontSize, lineHeight, foreground, background, colours, ground = null, glyphs = 'braille',
}) {
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
    const cells = cellsOf(line, glyphs);
    if (!colours) {
      return `<text x="0" y="${y}" xml:space="preserve">${escapeXml(cells.join(''))}</text>`;
    }
    // One element per run of equal colour, not per cell -- and a rectangle
    // under it wherever the cells carry a background of their own.
    return colourRuns(colours, i, line.length, 8, ground).map(({ start, end, index }) => {
      const x = (start * advance).toFixed(2);
      const painted = `<text x="${x}" y="${y}" fill="${cellHex(colours, index)}"`
        + ` xml:space="preserve">${escapeXml(cells.slice(start, end).join(''))}</text>`;
      if (!ground) return painted;
      const behind = `<rect x="${x}" y="${y}" width="${((end - start) * advance).toFixed(2)}"`
        + ` height="${rowHeight.toFixed(2)}" fill="${cellHex(ground, index)}"/>`;
      return `${behind}\n  ${painted}`;
    }).join('\n  ');
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
export function brailleToHtml(text, colours, cols, {
  fontFamily, fontSize, lineHeight, foreground, background, ground = null, glyphs = 'braille',
}) {
  const lines = text.split('\n');
  // Runs are cut over the grid the colours were built on, not over the row:
  // the two agree today because every row is the same length, and the colour
  // array would silently shift by a cell the day one is not.
  const stride = cols || Math.max(...lines.map((line) => line.length));
  const body = lines.map((line, row) => {
    const cells = cellsOf(line, glyphs);
    if (!colours) return escapeHtml(cells.join(''));
    return colourRuns(colours, row, stride, 8, ground)
      .map(({ start, end, index }) => {
        const paint = ground
          ? `color:${cellHex(colours, index)};background:${cellHex(ground, index)}`
          : `color:${cellHex(colours, index)}`;
        return `<span style="${paint}">${escapeHtml(cells.slice(start, end).join(''))}</span>`;
      })
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
export function brailleToAnsi(text, colours, cols, palette = 'full', ground = null, glyphs = 'braille') {
  const fixed = TERMINAL_PALETTES[palette] ?? null;
  const known = fixed ? new Map() : null;
  const lines = text.split('\n');
  const stride = cols || Math.max(...lines.map((line) => line.length));
  return lines.map((line, row) => {
    const cells = cellsOf(line, glyphs);
    if (!colours) return cells.join('');
    const painted = colourRuns(colours, row, stride, 8, ground).map(({ start, end, index }) => {
      const at = index * 3;
      const select = fixed
        ? ansiForeground(palette, nearest(fixed, colours[at], colours[at + 1], colours[at + 2], known))
        : `38;2;${colours[at]};${colours[at + 1]};${colours[at + 2]}`;
      if (!ground) return `${ESC}[${select}m${line.slice(start, end)}`;
      const behind = fixed
        ? ansiBackground(palette, nearest(fixed, ground[at], ground[at + 1], ground[at + 2], known))
        : `48;2;${ground[at]};${ground[at + 1]};${ground[at + 2]}`;
      return `${ESC}[${select};${behind}m${cells.slice(start, end).join('')}`;
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
