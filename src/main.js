// SPDX-License-Identifier: GPL-3.0-or-later
// Wiring: reads the controls, drives the pipeline, paints the previews.
// All pixel work lives in ./core; this and ./ui are the only files touching the DOM.

import { CELL_W, CELL_H, rowsForAspect } from './core/braille.js';
import { DEFAULT_DITHER } from './core/dither.js';
import { CONTENT_PRESETS } from './core/presets.js';
import { fitWithin } from './core/pixels.js';
import { createCanvas, drawScaled, putImageData, readImageData } from './ui/canvas.js';
import { bindRange, clampInt, coalesce } from './ui/controls.js';
import { brailleToSvg, copyText, downloadCanvas, downloadSvg, downloadText, renderTextToCanvas } from './ui/export.js';
import {
  PLATFORMS, calibrationOf, clearCalibration, forPlatform, messageLength, ruler, saveCalibration,
} from './ui/platforms.js';
import { clearSettings, loadSettings, saveSettings } from './ui/settings.js';
import { createCropper } from './ui/crop.js';
import { createDotEditor } from './ui/dots.js';
import { DEFAULT_TEXT_FONT, TEXT_FONTS, renderText } from './ui/text.js';
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
  app: el('app'),
  modeSimple: el('modeSimple'),
  modeAdvanced: el('modeAdvanced'),
  layout: el('layout'),
  cropper: el('cropper'),
  cropToggle: el('cropToggle'),
  cropReset: el('cropReset'),
  dotEdit: el('dotEdit'),
  dotUndo: el('dotUndo'),
  dotHint: el('dotHint'),
  sourceKind: el('sourceKind'),
  textInput: el('textInput'),
  textFont: el('textFont'),
  textBold: el('textBold'),
  resetAll: el('resetAll'),
  srcMeta: el('srcMeta'),
  gridMeta: el('gridMeta'),
  file: el('file'),
  cols: el('outWidth'),
  rows: el('outHeight'),
  keepAspect: el('keepAspect'),
  fontSize: el('fontSize'),
  invert: el('invert'),
  dither: el('dither'),
  edgeMode: el('edgeMode'),
  preset: el('preset'),
  presetHint: el('presetHint'),
  platform: el('platform'),
  platformState: el('platformState'),
  calibrate: el('calibrate'),
  calibratePanel: el('calibratePanel'),
  rulerText: el('rulerText'),
  copyRuler: el('copyRuler'),
  calibratedWidth: el('calibratedWidth'),
  saveCalibration: el('saveCalibration'),
  resetCalibration: el('resetCalibration'),
  downloadSvg: el('downloadSvg'),
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

let source = null;            // whatever is being encoded: a photo or drawn lettering
let imageSource = null;       // the last loaded file, kept while text is in use
let sourceUrl = null;         // object URL backing `source`
let previewReady = false;
let previewBackground = null; // background the preview source was composited over
let artText = '';

/** Set by presets rather than by a control of its own: only pixel art wants it
 *  off, and the preset that needs it says so in its hint. */
let smoothScaling = true;

/** Selected region in fractions of the source, or null for the whole frame. */
let cropRect = null;
let cropper = null;
let dotEditor = null;

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
    advancePx: advance,
    lineHeightPx,
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
  edge: {
    mode: dom.edgeMode.value,
    amount: controls.edgeAmount.value / 100,
    radius: controls.edgeRadius.value,
  },
});

/** The line controls mean nothing until a detector is chosen. */
function syncEdgeControls() {
  const off = dom.edgeMode.value === 'none';
  controls.edgeAmount.input.disabled = off;
  controls.edgeRadius.input.disabled = off;
}

/** A loaded file reports naturalWidth; drawn lettering is a canvas and reports width. */
const sourceW = () => source.naturalWidth || source.width;
const sourceH = () => source.naturalHeight || source.height;

/** Dimensions of what is actually being encoded. */
function sourceSize() {
  const w = sourceW();
  const h = sourceH();
  return cropRect ? { w: w * cropRect.w, h: h * cropRect.h } : { w, h };
}

function rowsFor(cols) {
  const area = sourceSize();
  const onScreen = rowsForAspect(cols, area.w, area.h, outputMetrics().cellAspect);
  // Every chat client sets its own line height, so art that looks right here can
  // arrive stretched. The per-platform scale is the correction, and it is
  // measured by the person sending it rather than guessed here.
  const corrected = Math.round(onScreen * calibrationOf(dom.platform.value).scale);
  return Math.min(MAX_ROWS, Math.max(1, corrected));
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

  // The original pane always shows the whole frame: the crop rectangle needs
  // something to be drawn against.
  const whole = fitWithin(sourceW(), sourceH(), PREVIEW_LIMIT.w, PREVIEW_LIMIT.h);
  const full = drawScaled(source, whole.w, whole.h, background, { smooth: smoothScaling });
  dom.srcCanvas.width = whole.w;
  dom.srcCanvas.height = whole.h;
  dom.srcCanvas.getContext('2d').drawImage(full, 0, 0);
  cropper?.refresh();

  // Everything downstream works on the selection alone.
  const area = sourceSize();
  const fit = fitWithin(area.w, area.h, PREVIEW_LIMIT.w, PREVIEW_LIMIT.h);
  const selected = drawScaled(source, fit.w, fit.h, background, { smooth: smoothScaling, crop: cropRect });

  await pipeline.setPreview(readImageData(selected));
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
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()), { smooth: smoothScaling, crop: cropRect });

  const token = ++generateToken;
  const { text, pixels } = await pipeline.generate(readImageData(target), readAdjustments(), readOptions());
  if (token !== generateToken) return;

  artText = text;
  dom.output.textContent = text;
  dotEditor?.forget();
  dom.dotUndo.disabled = true;
  applyFontSize();
  putImageData(dom.resCanvas, pixels);
  dom.gridMeta.textContent = `${cols * CELL_W}×${rows * CELL_H}`;
  updateMeta(text);
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
  persist();
  if (affectsPreview) schedulePreview();
  if (!source) return;
  if (dotEditor?.isEnabled()) {
    setStatus('Правка точек включена — арт не пересчитывается, чтобы не стереть правки.', 'warn');
    return;
  }
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
    imageSource = image;
    sourceUrl = url;
    setSourceKind('image');
    previewReady = false;
    cropRect = null;
    cropper?.set(null);
    if (dotEditor?.isEnabled()) setEditing(false);
    syncRows();
    dom.srcMeta.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
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
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()), { smooth: smoothScaling, crop: cropRect });
  const threshold = await pipeline.otsu(readImageData(target), readAdjustments());
  controls.threshold.set(threshold);
  setStatus(`Порог подобран: ${threshold}.`, 'ok');
  changed({ affectsPreview: false });
}

/** The size line, plus how the art measures against the target's limit. */
function updateMeta(text) {
  const lines = text.split('\n');
  const rows = lines.length;
  const cols = lines[0]?.length ?? 0;
  const platform = dom.platform.value;
  const { limit, label } = PLATFORMS[platform];

  const parts = [
    `${cols}×${rows} символов`,
    `${text.length.toLocaleString('ru-RU')} знаков с переносами`,
  ];

  // Width is only half the problem: the message length limit is the wall that
  // actually stops a paste, and it is easy to sail past without noticing.
  let over = false;
  if (Number.isFinite(limit)) {
    const length = messageLength(text, platform);
    over = length > limit;
    parts.push(
      `${label}: ${length.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')}`
      + (over ? ' — в одно сообщение не поместится' : ''),
    );
  }

  dom.meta.textContent = parts.join(' · ');
  dom.meta.classList.toggle('over', over);
}

function fillPresets() {
  dom.preset.replaceChildren(new Option('— не менять —', ''));
  for (const [key, preset] of Object.entries(CONTENT_PRESETS)) {
    dom.preset.append(new Option(preset.label, key));
  }
}

/**
 * A preset writes every control it covers, so choosing one twice always lands
 * in the same place regardless of what was adjusted in between.
 */
function applyPreset(key) {
  const preset = CONTENT_PRESETS[key];
  dom.presetHint.textContent = preset?.hint ?? '';
  if (!preset) return;

  const chosen = preset.settings;
  dom.dither.value = chosen.method;
  dom.edgeMode.value = chosen.edgeMode;
  controls.threshold.set(chosen.threshold);
  controls.edgeAmount.set(chosen.edgeAmount);
  controls.edgeRadius.set(chosen.edgeRadius);
  controls.brightness.set(chosen.brightness);
  controls.contrast.set(chosen.contrast);
  controls.saturation.set(chosen.saturation);
  controls.sharpness.set(chosen.sharpness);
  smoothScaling = chosen.smooth;

  syncEdgeControls();
  changed();
}

function fillPlatforms() {
  dom.platform.replaceChildren(
    ...Object.entries(PLATFORMS).map(([key, platform]) => new Option(platform.label, key)),
  );
}

/** Show what has been measured for the chosen target, and apply it. */
function syncPlatform() {
  const key = dom.platform.value;
  const { width, scale } = calibrationOf(key);
  const measurable = key !== 'none';

  dom.calibrate.disabled = !measurable;
  if (!measurable) dom.calibratePanel.hidden = true;

  if (!measurable) {
    dom.platformState.textContent = '';
  } else if (width) {
    dom.platformState.textContent =
      `Измерено: ${width} символов, вертикальный масштаб ${scale.toFixed(2)}.`;
    dom.cols.value = width;
  } else {
    dom.platformState.textContent =
      'Ширина не измерена. Здесь нет заранее вбитых чисел: она зависит от устройства, '
      + 'масштаба и настроек шрифта в самом клиенте, так что снять её можно только у себя.';
  }

  dom.calibratedWidth.value = width ?? clampInt(dom.cols.value, 1, MAX_COLS, 80);
  controls.calibratedScale.set(scale);
  syncRows();
}

function exportSvg() {
  const style = getComputedStyle(dom.output);
  const { fontFamily, fontSize, lineHeight } = outputMetrics();
  downloadSvg(
    brailleToSvg(artText, {
      fontFamily,
      fontSize,
      lineHeight,
      foreground: style.color,
      background: style.backgroundColor,
    }),
    'braille.svg',
  );
  setStatus('SVG сохранён.', 'ok');
}

/* ------------------------------------------------------------------------ *
 * Interface mode
 *
 * One DOM tree, one attribute. The mode only decides what CSS shows, so there
 * is no second interface to keep in step and no control that can hold a
 * different value depending on which mode last touched it.
 * ------------------------------------------------------------------------ */
function setMode(mode) {
  const next = mode === 'advanced' ? 'advanced' : 'simple';
  dom.app.dataset.mode = next;
  dom.modeSimple.setAttribute('aria-pressed', String(next === 'simple'));
  dom.modeAdvanced.setAttribute('aria-pressed', String(next === 'advanced'));
}

const LAYOUTS = ['grid', 'strip', 'focus', 'row'];

/**
 * Where the four panes sit. A view preference, so it rides on an attribute and
 * every option is only a different grid template in the stylesheet.
 */
function setLayout(name) {
  const next = LAYOUTS.includes(name) ? name : LAYOUTS[0];
  dom.layout.value = next;
  dom.app.dataset.layout = next;
}

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */
const PERSISTED_RANGES = [
  'threshold', 'brightness', 'contrast', 'saturation', 'sharpness', 'edgeAmount', 'edgeRadius',
];
const PERSISTED_FIELDS = [
  'preset', 'platform', 'dither', 'invert', 'edgeMode', 'outWidth', 'outHeight', 'fontSize', 'layout',
  'sourceKind', 'textInput', 'textFont',
];

function collectSettings() {
  const values = {
    mode: dom.app.dataset.mode,
    keepAspect: dom.keepAspect.checked,
    textBold: dom.textBold.checked,
    smooth: smoothScaling,
  };
  for (const id of PERSISTED_FIELDS) values[id] = el(id).value;
  for (const name of PERSISTED_RANGES) values[name] = controls[name].value;
  return values;
}

const persist = coalesce(() => saveSettings(collectSettings()));

/** Restore a stored blob, ignoring anything unrecognised rather than trusting it. */
function applySettings(values) {
  setMode(values.mode);

  for (const id of PERSISTED_FIELDS) {
    const stored = values[id];
    if (stored == null) continue;
    const node = el(id);
    // A select silently keeps its old value when handed an option it does not
    // have, which is what should happen to a blob from an older version.
    node.value = stored;
  }
  for (const name of PERSISTED_RANGES) {
    if (Number.isFinite(Number(values[name]))) controls[name].set(values[name]);
  }
  if (typeof values.keepAspect === 'boolean') dom.keepAspect.checked = values.keepAspect;
  if (typeof values.textBold === 'boolean') dom.textBold.checked = values.textBold;
  if (typeof values.smooth === 'boolean') smoothScaling = values.smooth;

  setLayout(dom.layout.value);
  dom.presetHint.textContent = CONTENT_PRESETS[dom.preset.value]?.hint ?? '';
}

function resetEverything() {
  clearSettings();
  for (const control of Object.values(controls)) control.reset();
  for (const id of PERSISTED_FIELDS) {
    const node = el(id);
    if (node instanceof HTMLSelectElement) {
      // A select has no defaultValue; the option marked default is the answer,
      // and the first option otherwise.
      const preferred = [...node.options].find((option) => option.defaultSelected);
      node.value = (preferred ?? node.options[0])?.value ?? '';
    } else {
      // defaultValue is the value attribute on an input and the original text
      // content on a textarea -- reading the attribute would empty the latter.
      node.value = node.defaultValue;
    }
  }
  dom.keepAspect.checked = true;
  smoothScaling = true;
  dom.presetHint.textContent = '';
  setLayout(LAYOUTS[0]);

  syncEdgeControls();
  syncPlatform();
  syncRows();
  setSourceKind(dom.sourceKind.value);
  setStatus('Настройки сброшены.', 'info');
}

/* ------------------------------------------------------------------------ *
 * Getting an image in
 * ------------------------------------------------------------------------ */
function firstImage(list) {
  return [...(list ?? [])].find((item) => item && item.type && item.type.startsWith('image/'));
}

function acceptDroppedFiles() {
  // dragenter/dragleave fire for every child element crossed, so the highlight
  // is refcounted rather than toggled, or it flickers across the whole layout.
  let depth = 0;
  const highlight = (on) => document.body.classList.toggle('dropping', on);

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    highlight(true);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) highlight(false);
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    highlight(false);
    const file = firstImage(event.dataTransfer?.files);
    if (file) loadFile(file);
    else setStatus('Это не изображение.', 'warn');
  });
}

function acceptPastedImages() {
  window.addEventListener('paste', (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    loadFile(file);
  });
}

/* ------------------------------------------------------------------------ *
 * Looking closer
 *
 * The three previews are small so all four panes fit one screen; this is how
 * you actually examine one without giving up that layout.
 * ------------------------------------------------------------------------ */
function inspect(canvasId) {
  const preview = el(canvasId);
  if (!preview.width || !preview.height) return;

  const overlay = document.createElement('div');
  overlay.className = 'inspect';

  const full = createCanvas(preview.width, preview.height);
  full.getContext('2d').drawImage(preview, 0, 0);
  if (canvasId === 'resCanvas') full.style.imageRendering = 'pixelated';

  const caption = document.createElement('p');
  caption.textContent = `${preview.width}×${preview.height} px · щёлкните или нажмите Esc, чтобы закрыть`;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  overlay.append(full, caption);
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

/**
 * Offline support.
 *
 * Skipped inside a frame: a worker registered from there would be scoped to a
 * page that is not the app, and the test suite loads index.html in an iframe.
 * Registration is best-effort -- opened from the filesystem, or with site data
 * blocked, it simply fails and the app carries on online-only.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (window.top !== window.self) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline stays unavailable */ });
  });
}

/* ------------------------------------------------------------------------ *
 * Hand-editing the dots
 *
 * Regeneration would overwrite anything drawn by hand, so while editing is on
 * the art stops following the controls. That is the whole bargain: either the
 * art tracks the parameters, or it is yours to touch up -- silently discarding
 * a minute of work because a slider moved would be worse than refusing to.
 * ------------------------------------------------------------------------ */
function replaceArt(next) {
  artText = next;
  dom.output.textContent = next;
  updateMeta(next);
  dom.dotUndo.disabled = !dotEditor?.canUndo();
}

function setEditing(on) {
  dotEditor.setEnabled(on);
  dom.app.classList.toggle('editing', on);
  dom.dotEdit.setAttribute('aria-pressed', String(on));
  dom.dotUndo.disabled = !on || !dotEditor.canUndo();
  dom.dotHint.textContent = on
    ? 'Щёлкайте или ведите по арту, чтобы ставить и стирать точки. Пока правка включена, арт не пересчитывается.'
    : '';
}

/* ------------------------------------------------------------------------ *
 * Where the picture comes from
 *
 * Lettering is drawn to a canvas and then handed to the same pipeline as a
 * photograph. A canvas is a valid drawImage source, so edges, dithering,
 * cropping, the exports and dot editing all work on text without knowing it is
 * text -- which is why there is no bitmap font here.
 * ------------------------------------------------------------------------ */
function fillFonts() {
  dom.textFont.replaceChildren(
    ...Object.entries(TEXT_FONTS).map(([key, font]) => {
      const isDefault = key === DEFAULT_TEXT_FONT;
      return new Option(font.label, key, isDefault, isDefault);
    }),
  );
}

function describeSource() {
  dom.srcMeta.textContent = source ? `${sourceW()}×${sourceH()}` : '';
}

function useTextSource() {
  source = renderText(dom.textInput.value, {
    font: dom.textFont.value,
    bold: dom.textBold.checked,
  });
  previewReady = false;
  cropRect = null;
  cropper?.set(null);
  if (dotEditor?.isEnabled()) setEditing(false);
  describeSource();
  changed();
}

const scheduleTextSource = coalesce(useTextSource);

function setSourceKind(kind) {
  const next = kind === 'text' ? 'text' : 'image';
  dom.sourceKind.value = next;
  dom.app.dataset.source = next;

  if (next === 'text') {
    useTextSource();
    return;
  }

  source = imageSource;
  previewReady = false;
  describeSource();
  if (source) {
    changed();
  } else {
    dom.output.textContent = '';
    artText = '';
    setStatus('Выберите файл, перетащите изображение или вставьте из буфера.');
  }
}

function init() {
  controls.threshold = bindRange(el('threshold'), el('thresholdVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.brightness = bindRange(el('brightness'), el('brightnessVal'), { onChange: changed });
  controls.contrast = bindRange(el('contrast'), el('contrastVal'), { onChange: changed });
  controls.saturation = bindRange(el('saturation'), el('saturationVal'), { onChange: changed });
  controls.sharpness = bindRange(el('sharpness'), el('sharpnessVal'), { decimals: 1, onChange: changed });
  controls.edgeAmount = bindRange(el('edgeAmount'), el('edgeAmountVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.edgeRadius = bindRange(el('edgeRadius'), el('edgeRadiusVal'), { decimals: 1, onChange: () => changed({ affectsPreview: false }) });

  controls.calibratedScale = bindRange(el('calibratedScale'), el('calibratedScaleVal'), { decimals: 2 });

  fillPresets();
  fillPlatforms();
  fillFonts();

  applySettings(loadSettings());

  dom.sourceKind.addEventListener('change', () => {
    setSourceKind(dom.sourceKind.value);
    persist();
  });
  dom.textInput.addEventListener('input', () => { scheduleTextSource(); persist(); });
  dom.textFont.addEventListener('change', () => { useTextSource(); persist(); });
  dom.textBold.addEventListener('change', () => { useTextSource(); persist(); });

  dom.preset.addEventListener('change', () => applyPreset(dom.preset.value));
  dom.platform.addEventListener('change', () => {
    syncPlatform();
    changed({ affectsPreview: false });
  });

  dom.calibrate.addEventListener('click', () => {
    dom.calibratePanel.hidden = !dom.calibratePanel.hidden;
    if (!dom.calibratePanel.hidden) dom.rulerText.textContent = ruler();
  });

  dom.copyRuler.addEventListener('click', async () => {
    try {
      await copyText(forPlatform(ruler(), dom.platform.value));
      setStatus('Линейка скопирована — отправьте её себе и посчитайте деления до переноса.', 'ok');
    } catch (error) {
      fail(error);
    }
  });

  dom.saveCalibration.addEventListener('click', () => {
    saveCalibration(dom.platform.value, {
      width: clampInt(dom.calibratedWidth.value, 4, MAX_COLS, 40),
      scale: controls.calibratedScale.value,
    });
    syncPlatform();
    setStatus('Измерения сохранены — они запомнятся для этой площадки.', 'ok');
    changed({ affectsPreview: false });
  });

  dom.resetCalibration.addEventListener('click', () => {
    clearCalibration(dom.platform.value);
    syncPlatform();
    setStatus('Измерения сброшены.', 'info');
    changed({ affectsPreview: false });
  });

  dom.downloadSvg.addEventListener('click', () => {
    if (requireArt()) exportSvg();
  });

  dom.modeSimple.addEventListener('click', () => { setMode('simple'); persist(); });
  dom.modeAdvanced.addEventListener('click', () => { setMode('advanced'); persist(); });
  dom.resetAll.addEventListener('click', resetEverything);
  dom.layout.addEventListener('change', () => {
    setLayout(dom.layout.value);
    persist();
  });

  cropper = createCropper(dom.cropper, dom.srcCanvas, (rect) => {
    cropRect = rect;
    previewReady = false;
    setStatus(rect ? 'Область выбрана.' : 'Взят весь кадр.', 'info');
    changed();
  });

  dom.cropToggle.addEventListener('click', () => {
    const on = !cropper.isActive();
    cropper.setActive(on);
    dom.cropToggle.setAttribute('aria-pressed', String(on));
    if (on) setStatus('Тяните рамку по «Оригиналу», чтобы выбрать область.', 'info');
  });

  dom.cropReset.addEventListener('click', () => cropper.reset());

  dotEditor = createDotEditor(dom.output, {
    metrics: outputMetrics,
    getText: () => artText,
    setText: replaceArt,
  });

  dom.dotEdit.addEventListener('click', () => {
    if (!requireArt()) return;
    setEditing(!dotEditor.isEnabled());
  });

  dom.dotUndo.addEventListener('click', () => {
    if (dotEditor.undo()) setStatus('Правка отменена.', 'info');
  });

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'z') return;
    if (!dotEditor.isEnabled()) return;
    event.preventDefault();
    if (dotEditor.undo()) setStatus('Правка отменена.', 'info');
  });

  for (const shot of document.querySelectorAll('[data-inspect]')) {
    shot.addEventListener('click', () => {
      // While a selection is being dragged, a click means crop, not zoom.
      if (cropper.isActive() && shot.dataset.inspect === 'srcCanvas') return;
      inspect(shot.dataset.inspect);
    });
    shot.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      inspect(shot.dataset.inspect);
    });
  }

  acceptDroppedFiles();
  acceptPastedImages();
  registerServiceWorker();

  dom.file.addEventListener('change', () => {
    const file = dom.file.files?.[0];
    if (file) loadFile(file);
  });

  dom.cols.addEventListener('input', () => { syncRows(); changed({ affectsPreview: false }); });
  dom.rows.addEventListener('input', () => changed({ affectsPreview: false }));
  dom.keepAspect.addEventListener('change', () => { syncRows(); changed({ affectsPreview: false }); });
  dom.dither.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.edgeMode.addEventListener('change', () => {
    syncEdgeControls();
    changed({ affectsPreview: false });
  });
  dom.invert.addEventListener('change', () => changed());
  dom.fontSize.addEventListener('input', () => {
    applyFontSize();
    syncRows();
  });

  dom.autoThreshold.addEventListener('click', () => { autoThreshold().catch(fail); });
  dom.generate.addEventListener('click', () => {
    if (dotEditor.isEnabled()) {
      setEditing(false);
      // Not the status line: the render that follows immediately overwrites it,
      // and losing hand edits is worth more than a quarter of a second.
      dom.dotHint.textContent = 'Правки точек сброшены — арт пересчитан заново.';
    } else {
      setStatus('Считаю\u2026');
    }
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
      await copyText(forPlatform(artText, dom.platform.value));
      setStatus(
        PLATFORMS[dom.platform.value].codeBlock
          ? 'Скопировано вместе с обёрткой в код-блок.'
          : 'Скопировано в буфер обмена.',
        'ok',
      );
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
  syncEdgeControls();
  syncPlatform();
  syncRows();
  if (dom.sourceKind.value === 'text') setSourceKind('text');
  else dom.app.dataset.source = 'image';
  setStatus(
    pipeline.offThread
      ? 'Загрузите изображение. Вычисления идут в фоновом потоке.'
      : 'Загрузите изображение. Фоновый поток недоступен — считаем в основном.',
  );
}

init();
