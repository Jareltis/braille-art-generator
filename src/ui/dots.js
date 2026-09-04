// SPDX-License-Identifier: GPL-3.0-or-later
// Touching up the finished art, one dot at a time.
//
// The art stays plain text: a click is resolved to a cell and a dot by the same
// type metrics the layout and the exporters use, rather than by rendering the
// grid as elements. Nothing downstream has to know the text was hand-edited.

import { BRAILLE_BLANK, CELL_H, CELL_W, DOT_BITS } from '../core/braille.js';

const UNDO_DEPTH = 60;

/**
 * Rewrite one cell of the art. Returns null when nothing would change, so a
 * drag across already-set dots does not fill the undo stack with copies.
 */
function withDot(text, row, column, bit, on) {
  const lines = text.split('\n');
  if (row < 0 || row >= lines.length) return null;

  const line = lines[row];
  if (column < 0 || column >= line.length) return null;

  const mask = line.charCodeAt(column) - BRAILLE_BLANK;
  if (mask < 0 || mask > 255) return null; // not a braille cell

  const next = on ? mask | (1 << bit) : mask & ~(1 << bit);
  if (next === mask) return null;

  lines[row] = line.slice(0, column) + String.fromCharCode(BRAILLE_BLANK + next) + line.slice(column + 1);
  return lines.join('\n');
}

/**
 * Attaches dot editing to the element the art is rendered in.
 *
 * `metrics()` must report the advance width and line height in pixels of the
 * font actually on screen -- the same pair the row count and the exports are
 * derived from, so a click lands where the glyph looks like it is.
 */
export function createDotEditor(view, { metrics, getText, setText, cursor }) {
  let enabled = false;
  let stroke = null;      // { on } while the pointer is down
  const undo = [];

  // The keyboard needs somewhere to be. Dots, not cells, are the unit: it is
  // the thing being edited, and moving a whole cell at a time would make four
  // of every eight positions unreachable.
  const at = { x: 0, y: 0 };

  /** Where the pointer is, in dot coordinates. */
  function locate(event) {
    const style = getComputedStyle(view);
    const box = view.getBoundingClientRect();
    const { advancePx, lineHeightPx } = metrics();
    if (!(advancePx > 0) || !(lineHeightPx > 0)) return null;

    const x = event.clientX - box.left - Number.parseFloat(style.paddingLeft) + view.scrollLeft;
    const y = event.clientY - box.top - Number.parseFloat(style.paddingTop) + view.scrollTop;
    if (x < 0 || y < 0) return null;

    return {
      x: Math.floor((x / advancePx) * CELL_W),
      y: Math.floor((y / lineHeightPx) * CELL_H),
    };
  }

  /** Cell and bit for a dot position. */
  const spotAt = (x, y) => ({
    row: Math.floor(y / CELL_H),
    column: Math.floor(x / CELL_W),
    bit: DOT_BITS[x % CELL_W][y % CELL_H],
  });

  const isRaised = (x, y) => {
    const spot = spotAt(x, y);
    const line = getText().split('\n')[spot.row];
    if (!line || spot.column >= line.length) return false;
    return ((line.charCodeAt(spot.column) - BRAILLE_BLANK) & (1 << spot.bit)) !== 0;
  };

  /** Set or clear the dot at a position, remembering the state before it. */
  function paint(x, y, on) {
    const spot = spotAt(x, y);
    const before = getText();
    const after = withDot(before, spot.row, spot.column, spot.bit, on);
    if (after === null) return false;

    undo.push(before);
    if (undo.length > UNDO_DEPTH) undo.shift();
    setText(after);
    return true;
  }

  const gridSize = () => {
    const lines = getText().split('\n');
    return { cols: (lines[0]?.length ?? 0) * CELL_W, rows: lines.length * CELL_H };
  };

  /** Put the marker over the dot, and bring it into view if it has left. */
  function paintCursor() {
    if (!cursor) return;
    if (!enabled) {
      cursor.hidden = true;
      return;
    }
    const style = getComputedStyle(view);
    const { advancePx, lineHeightPx } = metrics();
    const box = view.getBoundingClientRect();
    const host = (cursor.offsetParent ?? view).getBoundingClientRect();

    const dotW = advancePx / CELL_W;
    const dotH = lineHeightPx / CELL_H;
    const x = Number.parseFloat(style.paddingLeft) + at.x * dotW;
    const y = Number.parseFloat(style.paddingTop) + at.y * dotH;

    cursor.hidden = false;
    cursor.style.width = `${dotW}px`;
    cursor.style.height = `${dotH}px`;
    cursor.style.left = `${box.left - host.left + x - view.scrollLeft}px`;
    cursor.style.top = `${box.top - host.top + y - view.scrollTop}px`;
  }

  function moveTo(x, y) {
    const { cols, rows } = gridSize();
    at.x = Math.max(0, Math.min(cols - 1, x));
    at.y = Math.max(0, Math.min(rows - 1, y));

    // Keep the marker on screen without yanking the whole page about.
    const { advancePx, lineHeightPx } = metrics();
    const left = (at.x / CELL_W) * advancePx;
    const top = (at.y / CELL_H) * lineHeightPx;
    if (left < view.scrollLeft) view.scrollLeft = left;
    if (left + advancePx > view.scrollLeft + view.clientWidth) {
      view.scrollLeft = left + advancePx - view.clientWidth;
    }
    if (top < view.scrollTop) view.scrollTop = top;
    if (top + lineHeightPx > view.scrollTop + view.clientHeight) {
      view.scrollTop = top + lineHeightPx - view.clientHeight;
    }
    paintCursor();
  }

  /**
   * Everything the pointer can do, from the keyboard.
   *
   * Without this the whole feature is unreachable without a mouse -- which for
   * a project named after braille would be a poor joke.
   */
  function onKeyDown(event) {
    if (!enabled) return;
    const step = event.shiftKey ? { x: CELL_W, y: CELL_H } : { x: 1, y: 1 };

    switch (event.key) {
      case 'ArrowLeft': moveTo(at.x - step.x, at.y); break;
      case 'ArrowRight': moveTo(at.x + step.x, at.y); break;
      case 'ArrowUp': moveTo(at.x, at.y - step.y); break;
      case 'ArrowDown': moveTo(at.x, at.y + step.y); break;
      case 'Home': moveTo(0, at.y); break;
      case 'End': moveTo(gridSize().cols - 1, at.y); break;
      case ' ':
      case 'Enter': paint(at.x, at.y, !isRaised(at.x, at.y)); break;
      default: return;
    }
    event.preventDefault();
  }

  function onPointerDown(event) {
    if (!enabled || event.button !== 0) return;
    event.preventDefault();
    try { view.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }

    // A stroke decides its direction once, from the first dot touched, and
    // then paints only that way -- otherwise dragging flickers dots on and off
    // as it crosses them.
    const spot = locate(event);
    if (!spot) return;

    // The keyboard cursor follows the pointer, so the two never disagree about
    // where "here" is.
    moveTo(spot.x, spot.y);
    stroke = { on: !isRaised(spot.x, spot.y) };
    paint(spot.x, spot.y, stroke.on);
  }

  function onPointerMove(event) {
    if (!stroke) return;
    event.preventDefault();
    const spot = locate(event);
    if (spot) paint(spot.x, spot.y, stroke.on);
  }

  function onPointerUp(event) {
    if (!stroke) return;
    stroke = null;
    try { view.releasePointerCapture(event.pointerId); } catch { /* never captured */ }
  }

  view.addEventListener('keydown', onKeyDown);
  view.addEventListener('scroll', paintCursor);
  window.addEventListener('resize', paintCursor);
  view.addEventListener('pointerdown', onPointerDown);
  view.addEventListener('pointermove', onPointerMove);
  view.addEventListener('pointerup', onPointerUp);
  view.addEventListener('pointercancel', onPointerUp);

  return {
    setEnabled(on) {
      enabled = on;
      stroke = null;
      if (on) {
        moveTo(at.x, at.y);
        view.focus();
      }
      paintCursor();
    },
    refresh: paintCursor,
    isEnabled: () => enabled,
    canUndo: () => undo.length > 0,
    undo() {
      const previous = undo.pop();
      if (previous === undefined) return false;
      setText(previous);
      return true;
    },
    /** Called whenever the art is regenerated: old states no longer apply. */
    forget() {
      undo.length = 0;
    },
  };
}

export const CELL = Object.freeze({ w: CELL_W, h: CELL_H });
