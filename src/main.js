// SPDX-License-Identifier: GPL-3.0-or-later
// Wiring: reads the controls, drives the pipeline, paints the previews.
// All pixel work lives in ./core; this and ./ui are the only files touching the DOM.

import { CELL_W, CELL_H, rowsForAspect } from './core/braille.js';
import { DEFAULT_DITHER } from './core/dither.js';
import { fitWithin } from './core/pixels.js';
import { createCanvas, drawScaled, putImageData, readImageData } from './ui/canvas.js';
import { bindRange, clampInt, coalesce } from './ui/controls.js';
import { copyText, downloadCanvas, downloadText, renderTextToCanvas } from './ui/export.js';
import { createPipeline } from './ui/pipeline.js';

const MAX_COLS = 400;
const MAX_ROWS = 400;
const PREVIEW_LIMIT = { w: 900, h: 700 };

/**
 * Above this many cells the art stops following the controls by itself and
 * waits for the button. Dithering is a serial pass over every pixel, so the
 * largest grids are past the point where a slider can stay responsive even off
 * the main thread.
 */
const LIVE_CELL_LIMIT = 200 * 200;

const el = (id) => document.getElementById(id);

const dom = {
  file: el('file'),
  cols: el('outWidth'),
  rows: el('outHeight'),
  keepAspect: el('keepAspect'),
  fontSize: el('fontSize'),
  invert: el('invert'),
  dither: el('dither'),
  autoThreshold: el('autoThreshold'),
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

const pipeline = createPipeline();
const controls = {};

let source = null;            // the original image, at full resolution
let sourceUrl = null;         // object URL backing `source`
let previewReady = false;
let previewBackground = null; // background the preview source was composited over
let artText = '';

// Requests are answered out of order once they are asynchronous; a reply is
// only applied while it is still the newest of its kind.
let previewToken = 0;
let generateToken = 0;

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

const readOptions = () => ({
  threshold: controls.threshold.value,
  invert: isInverted(),
  method: dom.dither.value || DEFAULT_DITHER,
});

function rowsFor(cols) {
  return Math.min(
    MAX_ROWS,
    rowsForAspect(cols, source.naturalWidth, source.naturalHeight, outputMetrics().cellAspect),
  );
}

function resolveGrid() {
  const cols = clampInt(dom.cols.value, 1, MAX_COLS, 80);
  const rows = dom.keepAspect.checked && source ? rowsFor(cols) : clampInt(dom.rows.value, 1, MAX_ROWS, 30);
  return { cols, rows };
}

/**
 * Rebuild what the preview is derived from. Handing the pixels to the pipeline
 * detaches them here, so the visible copy is drawn from the canvas first.
 */
async function buildPreviewSource() {
  const background = backgroundFor(isInverted());
  const { w, h } = fitWithin(source.naturalWidth, source.naturalHeight, PREVIEW_LIMIT.w, PREVIEW_LIMIT.h);
  const scaled = drawScaled(source, w, h, background);

  dom.srcCanvas.width = w;
  dom.srcCanvas.height = h;
  dom.srcCanvas.getContext('2d').drawImage(scaled, 0, 0);

  await pipeline.setPreview(readImageData(scaled));
  previewBackground = background;
  previewReady = true;
}

async function renderPreview() {
  if (!source) return;
  if (!previewReady || previewBackground !== backgroundFor(isInverted())) {
    await buildPreviewSource();
  }
  const token = ++previewToken;
  const image = await pipeline.preview(readAdjustments());
  if (token !== previewToken || !image) return; // a newer request has overtaken this one
  putImageData(dom.editCanvas, image);
}

async function render() {
  if (!source) {
    setStatus('Сначала загрузите изображение.', 'warn');
    return;
  }

  const { cols, rows } = resolveGrid();
  // Write the clamped numbers back before rendering, so the fields can never
  // advertise a size the output does not actually have.
  dom.cols.value = cols;
  dom.rows.value = rows;

  // Sample the ORIGINAL straight to the grid size. Generation used to run off
  // the <=800x600 preview, so anything larger was upscaled from detail that had
  // already been thrown away.
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()));

  const token = ++generateToken;
  const { text, pixels } = await pipeline.generate(readImageData(target), readAdjustments(), readOptions());
  if (token !== generateToken) return;

  artText = text;
  dom.output.textContent = text;
  applyFontSize();
  putImageData(dom.resCanvas, pixels);
  dom.meta.textContent =
    `${cols}\u00d7${rows} символов \u00b7 ${text.length.toLocaleString('ru-RU')} знаков с переносами`;
}

function applyFontSize() {
  dom.output.style.fontSize = `${clampInt(dom.fontSize.value, 6, 48, 12)}px`;
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

const fail = (error) => setStatus(String(error?.message ?? error), 'error');

const schedulePreview = coalesce(() => { renderPreview().catch(fail); });
const scheduleRender = coalesce(() => {
  render().then(() => setStatus('Готово.', 'ok')).catch(fail);
});

const isLive = () => {
  const { cols, rows } = resolveGrid();
  return cols * rows <= LIVE_CELL_LIMIT;
};

/**
 * Something changed. Redraw the preview, and redraw the art too while the grid
 * is small enough to keep up.
 */
function changed({ affectsPreview = true } = {}) {
  if (affectsPreview) schedulePreview();
  if (!source) return;
  if (isLive()) {
    scheduleRender();
  } else if (artText) {
    setStatus('Размер великоват для авто-обновления — нажмите «Сгенерировать».', 'warn');
  }
}

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();

  image.addEventListener('load', () => {
    // Release the previous URL only once the replacement has decoded.
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    source = image;
    sourceUrl = url;
    previewReady = false;
    syncRows();
    setStatus(`Загружено ${image.naturalWidth}\u00d7${image.naturalHeight} px, считаю\u2026`);
    schedulePreview();
    scheduleRender();
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

async function autoThreshold() {
  if (!source) {
    setStatus('Сначала загрузите изображение.', 'warn');
    return;
  }
  const { cols, rows } = resolveGrid();
  // Measure the histogram of the pixels that will actually be encoded, not of
  // the preview -- downscaling changes the distribution.
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()));
  const threshold = await pipeline.otsu(readImageData(target), readAdjustments());
  controls.threshold.set(threshold);
  setStatus(`Порог подобран: ${threshold}.`, 'ok');
  changed({ affectsPreview: false });
}

function init() {
  controls.threshold = bindRange(el('threshold'), el('thresholdVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.brightness = bindRange(el('brightness'), el('brightnessVal'), { onChange: changed });
  controls.contrast = bindRange(el('contrast'), el('contrastVal'), { onChange: changed });
  controls.saturation = bindRange(el('saturation'), el('saturationVal'), { onChange: changed });
  controls.sharpness = bindRange(el('sharpness'), el('sharpnessVal'), { decimals: 1, onChange: changed });

  dom.file.addEventListener('change', () => {
    const file = dom.file.files?.[0];
    if (file) loadFile(file);
  });

  dom.cols.addEventListener('input', () => { syncRows(); changed({ affectsPreview: false }); });
  dom.rows.addEventListener('input', () => changed({ affectsPreview: false }));
  dom.keepAspect.addEventListener('change', () => { syncRows(); changed({ affectsPreview: false }); });
  dom.dither.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.invert.addEventListener('change', () => changed());
  dom.fontSize.addEventListener('input', () => {
    applyFontSize();
    syncRows();
  });

  dom.autoThreshold.addEventListener('click', () => { autoThreshold().catch(fail); });
  dom.generate.addEventListener('click', () => {
    setStatus('Считаю\u2026');
    scheduleRender();
  });

  dom.reset.addEventListener('click', () => {
    for (const name of ['brightness', 'contrast', 'saturation', 'sharpness']) {
      controls[name].reset();
    }
    changed();
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
      fail(error);
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
  setStatus(
    pipeline.offThread
      ? 'Загрузите изображение. Вычисления идут в фоновом потоке.'
      : 'Загрузите изображение. Фоновый поток недоступен — считаем в основном.',
  );
}

init();
