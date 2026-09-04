// SPDX-License-Identifier: GPL-3.0-or-later
// Wiring: reads the controls, drives the core, paints the previews.
// All pixel work lives in ./core; this and ./ui are the only files touching the DOM.

import { CELL_W, CELL_H, imageDataToBraille, rowsForAspect } from './core/braille.js';
import { applyAdjustments } from './core/adjust.js';
import { fitWithin } from './core/pixels.js';
import { createCanvas, drawScaled, putImageData, readImageData } from './ui/canvas.js';
import { bindRange, clampInt, coalesce } from './ui/controls.js';
import { copyText, downloadCanvas, downloadText, renderTextToCanvas } from './ui/export.js';

const MAX_COLS = 400;
const MAX_ROWS = 400;
const PREVIEW_LIMIT = { w: 900, h: 700 };

const el = (id) => document.getElementById(id);

const dom = {
  file: el('file'),
  cols: el('outWidth'),
  rows: el('outHeight'),
  keepAspect: el('keepAspect'),
  fontSize: el('fontSize'),
  invert: el('invert'),
  generate: el('generate'),
  reset: el('resetEdits'),
  output: el('output'),
  status: el('status'),
  meta: el('meta'),
  srcCanvas: el('srcCanvas'),
  editCanvas: el('editCanvas'),
  resCanvas: el('resCanvas'),
  downloadTxt: el('downloadTxt'),
  copy: el('copy'),
  downloadPng: el('downloadPng'),
};

let source = null;            // the original image, at full resolution
let sourceUrl = null;         // object URL backing `source`
let previewBase = null;       // un-adjusted ImageData at preview size
let previewBackground = null; // background `previewBase` was composited over
let artText = '';

const controls = {};

function setStatus(message, kind = 'info') {
  dom.status.textContent = message;
  dom.status.dataset.kind = kind;
}

const isInverted = () => dom.invert.value === '1';

/**
 * The colour that means "no dot".
 *
 * Transparent pixels used to read as black, which filled every uncovered area
 * with solid blocks as soon as the output was inverted. Compositing onto the
 * "off" colour instead leaves those areas empty in both directions.
 */
const backgroundFor = (invert) => (invert ? '#ffffff' : '#000000');

/**
 * Type metrics of the element the art renders in.
 *
 * cellAspect -- advance width over line height -- is the single number that
 * decides proportions. The row count, the on-screen layout and the PNG export
 * all read it from here, so they can no longer disagree with one another.
 */
function outputMetrics() {
  const style = getComputedStyle(dom.output);
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeightPx = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize;

  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = `${fontSize}px ${style.fontFamily}`;
  const advance = probe.measureText('\u28FF').width || fontSize * 0.6;

  return {
    fontFamily: style.fontFamily,
    fontSize,
    lineHeight: lineHeightPx / fontSize,
    cellAspect: advance / lineHeightPx,
  };
}

const readAdjustments = () => ({
  brightness: controls.brightness.value,
  contrast: controls.contrast.value,
  saturation: controls.saturation.value,
  sharpness: controls.sharpness.value,
});

function buildPreviewBase() {
  const background = backgroundFor(isInverted());
  const { w, h } = fitWithin(source.naturalWidth, source.naturalHeight, PREVIEW_LIMIT.w, PREVIEW_LIMIT.h);
  const scaled = drawScaled(source, w, h, background);
  previewBase = readImageData(scaled);
  previewBackground = background;
  putImageData(dom.srcCanvas, previewBase);
}

/**
 * Coalesced to one pass per frame. Dragging a slider used to run a full pixel
 * pass plus a convolution on every input event, which stalled the tab.
 */
const renderPreview = coalesce(() => {
  if (!source) return;
  if (previewBackground !== backgroundFor(isInverted())) buildPreviewBase();
  putImageData(dom.editCanvas, applyAdjustments(previewBase, readAdjustments()));
});

function rowsFor(cols) {
  return Math.min(
    MAX_ROWS,
    rowsForAspect(cols, source.naturalWidth, source.naturalHeight, outputMetrics().cellAspect),
  );
}

/**
 * With "keep proportions" on the row count is derived, so the field is filled
 * in and disabled rather than being overwritten behind the user.
 */
function syncRows() {
  const linked = dom.keepAspect.checked;
  dom.rows.disabled = linked;
  if (!linked || !source) return;
  dom.rows.value = rowsFor(clampInt(dom.cols.value, 1, MAX_COLS, 80));
}

function applyFontSize() {
  dom.output.style.fontSize = `${clampInt(dom.fontSize.value, 6, 48, 12)}px`;
}

function generate() {
  if (!source) {
    setStatus('Сначала загрузите изображение.', 'warn');
    return;
  }

  const cols = clampInt(dom.cols.value, 1, MAX_COLS, 80);
  const rows = dom.keepAspect.checked ? rowsFor(cols) : clampInt(dom.rows.value, 1, MAX_ROWS, 30);

  // Write the clamped numbers back before rendering, so the fields can never
  // advertise a size the output does not actually have.
  dom.cols.value = cols;
  dom.rows.value = rows;

  const invert = isInverted();

  // Sample the ORIGINAL straight to the grid size. Generation used to run off
  // the <=800x600 preview, so anything larger was upscaled from detail that had
  // already been thrown away.
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(invert));
  const pixels = applyAdjustments(
    readImageData(target),
    readAdjustments(),
  );

  artText = imageDataToBraille(pixels, { threshold: controls.threshold.value, invert });
  dom.output.textContent = artText;
  applyFontSize();
  putImageData(dom.resCanvas, pixels);

  dom.meta.textContent =
    `${cols}\u00d7${rows} символов \u00b7 ${artText.length.toLocaleString('ru-RU')} знаков с переносами`;
  setStatus('Готово.', 'ok');
}

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();

  image.addEventListener('load', () => {
    // Release the previous URL only once the replacement has decoded.
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    source = image;
    sourceUrl = url;
    buildPreviewBase();
    renderPreview();
    syncRows();
    setStatus(`Загружено ${image.naturalWidth}\u00d7${image.naturalHeight} px.`, 'ok');
  }, { once: true });

  image.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    setStatus('Не удалось прочитать файл как изображение.', 'error');
  }, { once: true });

  image.src = url;
}

function requireArt() {
  if (artText) return true;
  setStatus('Сначала сгенерируйте арт.', 'warn');
  return false;
}

function init() {
  controls.threshold = bindRange(el('threshold'), el('thresholdVal'));
  controls.brightness = bindRange(el('brightness'), el('brightnessVal'), { onChange: renderPreview });
  controls.contrast = bindRange(el('contrast'), el('contrastVal'), { onChange: renderPreview });
  controls.saturation = bindRange(el('saturation'), el('saturationVal'), { onChange: renderPreview });
  controls.sharpness = bindRange(el('sharpness'), el('sharpnessVal'), { decimals: 1, onChange: renderPreview });

  dom.file.addEventListener('change', () => {
    const file = dom.file.files?.[0];
    if (file) loadFile(file);
  });

  dom.cols.addEventListener('input', syncRows);
  dom.keepAspect.addEventListener('change', syncRows);
  dom.invert.addEventListener('change', renderPreview);
  dom.fontSize.addEventListener('input', () => {
    applyFontSize();
    syncRows();
  });

  dom.generate.addEventListener('click', generate);

  dom.reset.addEventListener('click', () => {
    for (const name of ['brightness', 'contrast', 'saturation', 'sharpness']) {
      controls[name].reset();
    }
    renderPreview();
    setStatus('Параметры изображения сброшены.', 'info');
  });

  dom.downloadTxt.addEventListener('click', () => {
    if (requireArt()) downloadText(artText, 'braille.txt');
  });

  dom.copy.addEventListener('click', async () => {
    if (!requireArt()) return;
    try {
      await copyText(artText);
      setStatus('Скопировано в буфер обмена.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  dom.downloadPng.addEventListener('click', () => {
    if (!requireArt()) return;
    const style = getComputedStyle(dom.output);
    const { fontFamily, fontSize, lineHeight } = outputMetrics();
    const { canvas, scale } = renderTextToCanvas(artText, {
      fontFamily,
      fontSize,
      lineHeight,
      foreground: style.color,
      background: style.backgroundColor,
    });
    downloadCanvas(canvas, 'braille.png');
    setStatus(
      scale < 1
        ? `PNG сохранён, уменьшен до ${Math.round(scale * 100)}% — иначе он превысил бы 8192 px.`
        : 'PNG сохранён.',
      scale < 1 ? 'warn' : 'ok',
    );
  });

  applyFontSize();
  syncRows();
  setStatus('Загрузите изображение, чтобы начать.');
}

init();
