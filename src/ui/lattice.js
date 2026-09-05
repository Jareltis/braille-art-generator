// SPDX-License-Identifier: GPL-3.0-or-later
// Drawing the art as dots instead of as text.
//
// A braille glyph does not fill the cell it is given. Measured in this app's
// own font stack, a fully lit cell inks 26 pixels of a 37.5 pixel advance:
// nearly a third of every cell is blank, and the picture arrives ruled with
// vertical gutters that belong to the font rather than to the art. Some fonts
// are worse than padded -- they draw the unraised dots as hollow rings, and
// fill the picture with holes.
//
// The obvious fix is the wrong one. Pulling the letters together with a
// negative letter-spacing would even out the lattice, but it would also make
// the cell narrower than a cell actually is: the gutter is missing ink, not a
// narrower character, and every terminal that draws these glyphs well -- kitty,
// iTerm2, Ghostty, Konsole, VS Code -- fills the cell without changing its
// width. Squeezing the text would hide a cosmetic flaw by introducing a real
// one, and the aspect ratio the whole layout is built on would start lying.
//
// So the cell keeps the width the font gives it and the dots are drawn inside
// it. Same advance, same line height, same picture -- only the ink is placed on
// an even lattice, as the machines that render braille properly place it. The
// exported PNG has always been drawn this way; this is the screen catching up,
// out of the same function, so the two cannot drift apart.

import { BRAILLE_BLANK, CELL_H, CELL_W, DOT_BITS } from '../core/braille.js';
import { cellHex } from '../core/colour.js';

const TAU = Math.PI * 2;

/**
 * Under this radius a dot is drawn as a square instead of a circle.
 *
 * Not because a square is crisper -- measured, an equal-area square peaks at
 * the same value a circle does. Because at a radius near a pixel a circle has
 * almost nothing left that is not its own anti-aliased edge: in a cell four
 * pixels by eight, eight round dots lay down 4016 of ink where eight squares
 * lay down 5760, and the art at small type sizes goes visibly grey. The square
 * is the shape that keeps the ink.
 */
const ROUND_ABOVE_PX = 1.1;

/** How much of its quarter-cell a dot fills. */
const DOT_FILL = 0.42;

/**
 * Paint braille text as dots into a 2D context.
 *
 * The caller owns the canvas and its transform: this draws in CSS pixels from
 * the top left, and `offsetX`/`offsetY` scroll the art under a fixed window so
 * the screen can draw only what is visible. `width`/`height` bound that window;
 * without them the whole art is drawn, which is what the exports want.
 */
export function drawLattice(ctx, lines, {
  cellW,
  cellH,
  cols,
  foreground = '#ffffff',
  colours = null,
  ground = null,
  fill = 'dots',
  offsetX = 0,
  offsetY = 0,
  width,
  height,
}) {
  // Colour indices are laid out over the full grid, so a ragged line must not
  // be allowed to shift them: the widest row is the stride, not this row.
  const stride = cols ?? lines.reduce((most, line) => Math.max(most, line.length), 0);
  const viewW = width ?? stride * cellW;
  const viewH = height ?? lines.length * cellH;

  // Two dots across a cell and four down it, each in the middle of its own
  // quarter -- so the spacing inside a cell and the spacing between cells are
  // the same number, which is the whole point of drawing this by hand.
  const pitchX = cellW / CELL_W;
  const pitchY = cellH / CELL_H;
  const radius = Math.min(pitchX, pitchY) * DOT_FILL;
  const round = radius >= ROUND_ABOVE_PX;
  const side = radius * 2;

  const firstRow = Math.max(0, Math.floor(offsetY / cellH));
  const afterRow = Math.min(lines.length, Math.ceil((offsetY + viewH) / cellH));
  const firstCol = Math.max(0, Math.floor(offsetX / cellW));
  const afterColAt = Math.ceil((offsetX + viewW) / cellW);

  // Where the cells carry a colour behind them, that goes down first: the
  // unraised dots stop being whatever the page is and become part of the
  // picture. Whole cells, in one pass, so the dots are not drawn over twice.
  if (ground) {
    for (let row = firstRow; row < afterRow; row++) {
      const line = lines[row];
      const top = row * cellH - offsetY;
      const afterCol = Math.min(line.length, afterColAt);
      // Snapped to whole pixels, and to the *next* cell's edge rather than to a
      // width: at a fractional advance two neighbours otherwise land either
      // side of a pixel boundary and the seam between them shows as a line.
      const bottom = Math.round(top + cellH);
      const snappedTop = Math.round(top);
      for (let cell = firstCol; cell < afterCol; cell++) {
        const left = Math.round(cell * cellW - offsetX);
        const right = Math.round((cell + 1) * cellW - offsetX);
        ctx.fillStyle = cellHex(ground, row * stride + cell);
        ctx.fillRect(left, snappedTop, right - left, bottom - snappedTop);
      }
    }
  }

  if (!colours) ctx.fillStyle = foreground;

  for (let row = firstRow; row < afterRow; row++) {
    const line = lines[row];
    const top = row * cellH - offsetY;
    const afterCol = Math.min(line.length, afterColAt);

    for (let cell = firstCol; cell < afterCol; cell++) {
      // Anything that is not a braille glyph -- a space, a stray newline in a
      // hand-edited string -- lands outside the block and is skipped.
      const pattern = line.charCodeAt(cell) - BRAILLE_BLANK;
      if (pattern <= 0 || pattern > 255) continue;

      if (colours) ctx.fillStyle = cellHex(colours, row * stride + cell);
      const left = cell * cellW - offsetX;

      for (let dx = 0; dx < CELL_W; dx++) {
        for (let dy = 0; dy < CELL_H; dy++) {
          if (!(pattern & (1 << DOT_BITS[dx][dy]))) continue;
          if (fill === 'blocks') {
            // Solid quarters, snapped like the grounds: this is what the octant
            // characters look like, and the drawn copy has to agree with the
            // text under it.
            const x0 = Math.round(left + dx * pitchX);
            const x1 = Math.round(left + (dx + 1) * pitchX);
            const y0 = Math.round(top + dy * pitchY);
            const y1 = Math.round(top + (dy + 1) * pitchY);
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            continue;
          }
          const cx = left + (dx + 0.5) * pitchX;
          const cy = top + (dy + 0.5) * pitchY;
          if (round) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, TAU);
            ctx.fill();
          } else {
            ctx.fillRect(cx - radius, cy - radius, side, side);
          }
        }
      }
    }
  }
}

/**
 * Keep a canvas showing the art that a `<pre>` is holding.
 *
 * The text stays where it is -- it is what gets selected, copied, edited a dot
 * at a time and read out by a screen reader -- and only its colour is dropped
 * while the canvas is up. Nothing downstream learns that the art is being
 * painted rather than typeset.
 *
 * Only the visible window is drawn. The art can be two hundred cells across
 * and hundreds of rows down, and redrawing all of it on every scroll would cost
 * more than the gutters are worth. A full 900 by 700 window measures 3.6 ms,
 * which is a scroll's worth of work rather than a render's.
 */
export function createLatticeView(canvas, view, { metrics, getArt }) {
  const ctx = canvas.getContext('2d');
  let enabled = true;
  let selecting = false;
  let pending = 0;

  function hide() {
    canvas.hidden = true;
    view.classList.remove('lattice-on');
  }

  function paint() {
    if (!enabled || selecting) return hide();

    const { text, colours, ground, cols, fill } = getArt();
    if (!text) return hide();

    const { advancePx, lineHeightPx } = metrics();
    if (!(advancePx > 0) || !(lineHeightPx > 0)) return hide();

    const style = getComputedStyle(view);
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const padTop = Number.parseFloat(style.paddingTop) || 0;
    const boxW = view.clientWidth;
    const boxH = view.clientHeight;
    if (boxW < 1 || boxH < 1) return hide();

    // The ink comes from the custom property rather than from `color`, because
    // `color` is the thing being turned transparent to make room for this.
    const ink = style.getPropertyValue('--ink').trim() || '#ffffff';
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));

    const pixelW = Math.max(1, Math.round(boxW * ratio));
    const pixelH = Math.max(1, Math.round(boxH * ratio));
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    canvas.style.width = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    canvas.style.left = `${view.offsetLeft + view.clientLeft}px`;
    canvas.style.top = `${view.offsetTop + view.clientTop}px`;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);

    drawLattice(ctx, text.split('\n'), {
      cellW: advancePx,
      cellH: lineHeightPx,
      cols: cols || undefined,
      foreground: ink,
      colours,
      ground,
      fill,
      // Content sits at the padding edge and slides under the box as it
      // scrolls, so the two together are where the first cell has got to.
      offsetX: view.scrollLeft - padLeft,
      offsetY: view.scrollTop - padTop,
      width: boxW,
      height: boxH,
    });

    canvas.hidden = false;
    view.classList.add('lattice-on');
  }

  /** Coalesced, because scrolling and resizing both arrive in bursts. */
  function redraw() {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      paint();
    });
  }

  view.addEventListener('scroll', redraw, { passive: true });
  window.addEventListener('resize', redraw);
  if (typeof ResizeObserver === 'function') new ResizeObserver(redraw).observe(view);

  // A selection under an opaque canvas looks like a selection that failed, so
  // while there is one the text shows itself and the canvas steps aside.
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    const inside = selection
      && !selection.isCollapsed
      && selection.anchorNode
      && view.contains(selection.anchorNode);
    selecting = Boolean(inside);
    redraw();
  });

  return {
    redraw,
    get enabled() {
      return enabled;
    },
    set enabled(on) {
      enabled = Boolean(on);
      redraw();
    },
  };
}
