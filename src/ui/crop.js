// SPDX-License-Identifier: GPL-3.0-or-later
// Choosing a region of the source image.
//
// The selection is kept in fractions of the image rather than pixels, so it
// survives the preview being redrawn at a different size and can be applied to
// the full-resolution original at generation time.

const MIN_FRACTION = 0.02;   // a selection smaller than this is a stray click
const STEP = 0.02;           // one arrow press, as a fraction of the frame
const FINE_STEP = 0.005;     // the same with Alt held
const HANDLE_GRAB = 14;      // px of slop around a corner, for touch as much as mice

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const FULL_FRAME = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

export const isWholeImage = (rect) =>
  !rect || (rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999);

/**
 * Where the bitmap actually sits inside its element.
 *
 * The preview canvases are laid out with object-fit: contain, so the element
 * box is generally larger than the picture in one axis. Pointer positions have
 * to be measured against the picture, not the box, or the selection drifts by
 * the size of the letterbox.
 */
function contentRect(canvas) {
  const box = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return { left: box.left, top: box.top, width: box.width, height: box.height };

  const imageRatio = canvas.width / canvas.height;
  const boxRatio = box.width / box.height;
  const width = boxRatio > imageRatio ? box.height * imageRatio : box.width;
  const height = boxRatio > imageRatio ? box.height : box.width / imageRatio;

  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

const CORNERS = [
  ['nw', 0, 0],
  ['ne', 1, 0],
  ['sw', 0, 1],
  ['se', 1, 1],
];

/**
 * Attaches a draggable selection to a preview canvas.
 *
 * Drag on empty space to draw a new region, drag inside to move it, drag a
 * corner to resize. Returns a handle rather than exposing the DOM it builds.
 */
export function createCropper(overlay, canvas, onChange) {
  let rect = { ...FULL_FRAME };
  let active = false;

  const frame = document.createElement('div');
  frame.className = 'crop-frame';
  overlay.append(frame);

  for (const [name] of CORNERS) {
    const handle = document.createElement('span');
    handle.className = `crop-handle crop-${name}`;
    frame.append(handle);
  }

  function paint() {
    const area = contentRect(canvas);
    const box = overlay.getBoundingClientRect();
    frame.style.left = `${area.left - box.left + rect.x * area.width}px`;
    frame.style.top = `${area.top - box.top + rect.y * area.height}px`;
    frame.style.width = `${rect.w * area.width}px`;
    frame.style.height = `${rect.h * area.height}px`;
  }

  /** Pointer position as a fraction of the picture. */
  function toFraction(event) {
    const area = contentRect(canvas);
    return {
      x: clamp01((event.clientX - area.left) / area.width),
      y: clamp01((event.clientY - area.top) / area.height),
    };
  }

  function cornerUnder(event) {
    const area = contentRect(canvas);
    for (const [name, cx, cy] of CORNERS) {
      const px = area.left + (rect.x + rect.w * cx) * area.width;
      const py = area.top + (rect.y + rect.h * cy) * area.height;
      if (Math.abs(event.clientX - px) <= HANDLE_GRAB && Math.abs(event.clientY - py) <= HANDLE_GRAB) {
        return name;
      }
    }
    return null;
  }

  const inside = (point) =>
    point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;

  /** Normalise a pair of opposite corners into a positive-sized rect. */
  function fromCorners(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  let gesture = null;

  function onPointerDown(event) {
    if (!active || event.button !== 0) return;
    event.preventDefault();
    // A synthetic pointer has no active id to capture, and a real one can have
    // been released already; neither is a reason to abandon the gesture.
    try { overlay.setPointerCapture(event.pointerId); } catch { /* not capturable */ }

    const point = toFraction(event);
    const corner = cornerUnder(event);

    if (corner) {
      // Anchor on the corner diagonally opposite the one being dragged.
      const anchor = {
        x: corner.includes('w') ? rect.x + rect.w : rect.x,
        y: corner.includes('n') ? rect.y + rect.h : rect.y,
      };
      gesture = { kind: 'resize', anchor };
    } else if (!isWholeImage(rect) && inside(point)) {
      gesture = { kind: 'move', grab: { x: point.x - rect.x, y: point.y - rect.y }, size: { w: rect.w, h: rect.h } };
    } else {
      // With nothing selected the frame covers everything, so every point is
      // "inside" it. Dragging then has to mean draw, or a first selection could
      // never be made -- the full frame has nowhere to move to.
      gesture = { kind: 'draw', anchor: point };
      rect = { x: point.x, y: point.y, w: 0, h: 0 };
    }
    paint();
  }

  function onPointerMove(event) {
    if (!gesture) return;
    event.preventDefault();
    const point = toFraction(event);

    if (gesture.kind === 'move') {
      rect = {
        x: clamp01(Math.min(point.x - gesture.grab.x, 1 - gesture.size.w)),
        y: clamp01(Math.min(point.y - gesture.grab.y, 1 - gesture.size.h)),
        w: gesture.size.w,
        h: gesture.size.h,
      };
    } else {
      rect = fromCorners(gesture.anchor, point);
    }
    paint();
  }

  function onPointerUp(event) {
    if (!gesture) return;
    gesture = null;
    try { overlay.releasePointerCapture(event.pointerId); } catch { /* never captured */ }

    // A click rather than a drag means "start over", not "select nothing".
    if (rect.w < MIN_FRACTION || rect.h < MIN_FRACTION) rect = { ...FULL_FRAME };
    paint();
    onChange(isWholeImage(rect) ? null : { ...rect });
  }

  /**
   * The same gestures, from the keyboard.
   *
   * Arrows move the selection, Shift resizes it from the far corner, Alt makes
   * either finer, and Escape gives the whole frame back. Without this the crop
   * is a mouse-only feature, which is to say no feature at all for some people.
   */
  function onKeyDown(event) {
    if (!active) return;
    const step = event.altKey ? FINE_STEP : STEP;
    const move = { x: 0, y: 0 };

    switch (event.key) {
      case 'ArrowLeft': move.x = -step; break;
      case 'ArrowRight': move.x = step; break;
      case 'ArrowUp': move.y = -step; break;
      case 'ArrowDown': move.y = step; break;
      case 'Escape':
        event.preventDefault();
        rect = { ...FULL_FRAME };
        paint();
        onChange(null);
        return;
      default:
        return;
    }
    event.preventDefault();

    if (event.shiftKey) {
      // Resize by the far corner, never below the size a drag would discard.
      rect = {
        ...rect,
        w: clamp01(Math.max(MIN_FRACTION, Math.min(1 - rect.x, rect.w + move.x))),
        h: clamp01(Math.max(MIN_FRACTION, Math.min(1 - rect.y, rect.h + move.y))),
      };
    } else {
      rect = {
        ...rect,
        x: clamp01(Math.min(rect.x + move.x, 1 - rect.w)),
        y: clamp01(Math.min(rect.y + move.y, 1 - rect.h)),
      };
    }
    paint();
    onChange(isWholeImage(rect) ? null : { ...rect });
  }

  overlay.addEventListener('keydown', onKeyDown);
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', () => { if (active) paint(); });

  return {
    setActive(on) {
      active = on;
      overlay.hidden = !on;
      // Focusable only while it does something, so tabbing does not stop on an
      // invisible layer.
      if (on) {
        overlay.tabIndex = 0;
        paint();
        overlay.focus();
      } else {
        overlay.removeAttribute('tabindex');
      }
    },
    isActive: () => active,
    get: () => (isWholeImage(rect) ? null : { ...rect }),
    set(next) {
      rect = next ? { ...next } : { ...FULL_FRAME };
      if (active) paint();
    },
    reset() {
      rect = { ...FULL_FRAME };
      if (active) paint();
      onChange(null);
    },
    refresh: paint,
  };
}
