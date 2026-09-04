// SPDX-License-Identifier: GPL-3.0-or-later
// Touching up the finished art, one dot at a time.
//
// The art stays plain text: a click is resolved to a cell and a dot by the same
// type metrics the layout and the exporters use, rather than by rendering the
// grid as elements. Nothing downstream has to know the text was hand-edited.

import { BRAILLE_BLANK, CELL_H, CELL_W, DOT_BITS } from '../core/braille.js';

const UNDO_DEPTH = 60;

/** Which bit a point inside a cell belongs to. */
function bitAt(fractionX, fractionY) {
  const column = fractionX < 0.5 ? 0 : 1;
  const row = Math.min(CELL_H - 1, Math.max(0, Math.floor(fractionY * CELL_H)));
  return DOT_BITS[column][row];
}

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
export function createDotEditor(view, { metrics, getText, setText }) {
  let enabled = false;
  let stroke = null;      // { on } while the pointer is down
  const undo = [];

  /** Cell and dot under the pointer, in art coordinates. */
  function locate(event) {
    const style = getComputedStyle(view);
    const box = view.getBoundingClientRect();
    const { advancePx, lineHeightPx } = metrics();
    if (!(advancePx > 0) || !(lineHeightPx > 0)) return null;

    const x = event.clientX - box.left - Number.parseFloat(style.paddingLeft) + view.scrollLeft;
    const y = event.clientY - box.top - Number.parseFloat(style.paddingTop) + view.scrollTop;
    if (x < 0 || y < 0) return null;

    const column = Math.floor(x / advancePx);
    const row = Math.floor(y / lineHeightPx);
    return {
      row,
      column,
      bit: bitAt(x / advancePx - column, y / lineHeightPx - row),
    };
  }

  function apply(event, on) {
    const spot = locate(event);
    if (!spot) return false;

    const before = getText();
    const after = withDot(before, spot.row, spot.column, spot.bit, on);
    if (after === null) return false;

    undo.push(before);
    if (undo.length > UNDO_DEPTH) undo.shift();
    setText(after);
    return true;
  }

  /** Whether the dot under the pointer is currently raised. */
  function isRaised(event) {
    const spot = locate(event);
    if (!spot) return false;
    const line = getText().split('\n')[spot.row];
    if (!line || spot.column >= line.length) return false;
    return ((line.charCodeAt(spot.column) - BRAILLE_BLANK) & (1 << spot.bit)) !== 0;
  }

  function onPointerDown(event) {
    if (!enabled || event.button !== 0) return;
    event.preventDefault();
    try { view.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }

    // A stroke decides its direction once, from the first dot touched, and
    // then paints only that way -- otherwise dragging flickers dots on and off
    // as it crosses them.
    stroke = { on: !isRaised(event) };
    apply(event, stroke.on);
  }

  function onPointerMove(event) {
    if (!stroke) return;
    event.preventDefault();
    apply(event, stroke.on);
  }

  function onPointerUp(event) {
    if (!stroke) return;
    stroke = null;
    try { view.releasePointerCapture(event.pointerId); } catch { /* never captured */ }
  }

  view.addEventListener('pointerdown', onPointerDown);
  view.addEventListener('pointermove', onPointerMove);
  view.addEventListener('pointerup', onPointerUp);
  view.addEventListener('pointercancel', onPointerUp);

  return {
    setEnabled(on) {
      enabled = on;
      stroke = null;
    },
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
