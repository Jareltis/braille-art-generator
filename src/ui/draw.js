// SPDX-License-Identifier: GPL-3.0-or-later
// A sketch pad as a source.
//
// White on black, which is the polarity the encoder reads as "dot here" without
// inversion, and the canvas itself is the source -- so a stroke turns into
// braille as it is drawn.

const WIDTH = 640;
const HEIGHT = 480;
const BACKGROUND = '#000000';
const INK = '#ffffff';

export function createSketchPad(canvas, onChange, cursor) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let brush = 18;
  let erasing = false;
  let drawing = false;
  let last = null;

  // Where the keyboard is. Freehand is a pointer gesture by nature, but leaving
  // a whole source reachable only by mouse is not an option, so arrows move a
  // point and Enter puts the pen down.
  const pen = { x: WIDTH / 2, y: HEIGHT / 2 };
  let penDown = false;

  function clear() {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  clear();

  /**
   * Pointer position in canvas pixels.
   *
   * The element is laid out with object-fit: contain, so it is generally larger
   * than the bitmap in one axis; measuring against the element box would put
   * the stroke somewhere other than under the cursor.
   */
  function at(event) {
    const box = canvas.getBoundingClientRect();
    const ratio = WIDTH / HEIGHT;
    const shown = box.width / box.height > ratio
      ? { w: box.height * ratio, h: box.height }
      : { w: box.width, h: box.width / ratio };
    const left = box.left + (box.width - shown.w) / 2;
    const top = box.top + (box.height - shown.h) / 2;
    return {
      x: ((event.clientX - left) / shown.w) * WIDTH,
      y: ((event.clientY - top) / shown.h) * HEIGHT,
    };
  }

  function stroke(from, to) {
    ctx.strokeStyle = erasing ? BACKGROUND : INK;
    ctx.lineWidth = brush;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  /** Show the keyboard point over the canvas, in element pixels. */
  function paintCursor() {
    if (!cursor) return;
    const box = canvas.getBoundingClientRect();
    const host = (cursor.offsetParent ?? canvas).getBoundingClientRect();
    const ratio = WIDTH / HEIGHT;
    const shown = box.width / box.height > ratio
      ? { w: box.height * ratio, h: box.height }
      : { w: box.width, h: box.width / ratio };
    const scale = shown.w / WIDTH;

    cursor.hidden = false;
    cursor.dataset.pen = penDown ? 'down' : 'up';
    cursor.style.width = `${Math.max(6, brush * scale)}px`;
    cursor.style.height = `${Math.max(6, brush * scale)}px`;
    cursor.style.left = `${box.left - host.left + (box.width - shown.w) / 2 + pen.x * scale - Math.max(6, brush * scale) / 2}px`;
    cursor.style.top = `${box.top - host.top + (box.height - shown.h) / 2 + pen.y * scale - Math.max(6, brush * scale) / 2}px`;
  }

  function onKeyDown(event) {
    const step = event.shiftKey ? brush : Math.max(2, Math.round(brush / 3));
    const from = { ...pen };

    switch (event.key) {
      case 'ArrowLeft': pen.x = Math.max(0, pen.x - step); break;
      case 'ArrowRight': pen.x = Math.min(WIDTH, pen.x + step); break;
      case 'ArrowUp': pen.y = Math.max(0, pen.y - step); break;
      case 'ArrowDown': pen.y = Math.min(HEIGHT, pen.y + step); break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        penDown = !penDown;
        if (penDown) {
          stroke(pen, pen);
          onChange();
        }
        paintCursor();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (penDown) {
      stroke(from, pen);
      onChange();
    }
    paintCursor();
  }

  canvas.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', paintCursor);

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    drawing = true;
    last = at(event);
    // A tap should leave a dot, not nothing.
    stroke(last, last);
    onChange();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    event.preventDefault();
    const next = at(event);
    stroke(last, next);
    last = next;
    onChange();
  });

  const finish = (event) => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* never captured */ }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  return {
    canvas,
    refresh: paintCursor,
    setBrush(size) {
      brush = size;
      paintCursor();
    },
    setErasing(on) { erasing = on; },
    isErasing: () => erasing,
    clear() {
      clear();
      penDown = false;
      paintCursor();
      onChange();
    },
  };
}
