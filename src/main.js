// SPDX-License-Identifier: GPL-3.0-or-later
// Wiring: reads the controls, drives the pipeline, paints the previews.
// All pixel work lives in ./core; this and ./ui are the only files touching the DOM.

import { CELL_W, CELL_H, rowsForAspect, trimBlank, trimBounds, trimColours } from './core/braille.js';
import {
  LOCALES, currentLocale, initLocale, onLocaleChange, preferredLocale, setLocale, t,
} from './i18n/index.js';
import { cellHex, colourRuns } from './core/colour.js';
import { DEFAULT_DITHER } from './core/dither.js';
import { CONTENT_PRESETS } from './core/presets.js';
import { fitWithin } from './core/pixels.js';
import { createCanvas, drawScaled, putImageData, readImageData } from './ui/canvas.js';
import { bindRange, clampInt, coalesce } from './ui/controls.js';
import {
  brailleToAnsi, brailleToHtml, brailleToSvg, copyText, downloadCanvas, downloadHtml, downloadSvg,
  downloadText, renderTextToCanvas,
} from './ui/export.js';
import {
  PLATFORMS, calibrationOf, clearCalibration, forPlatform, messageLength, partsFit, ruler,
  saveCalibration, splitForPlatform,
} from './ui/platforms.js';
import { clearSettings, loadSettings, saveSettings } from './ui/settings.js';
import { createCropper } from './ui/crop.js';
import { createDotEditor } from './ui/dots.js';
import { DEFAULT_TEXT_FONT, TEXT_FONTS, renderText } from './ui/text.js';
import { createCamera } from './ui/camera.js';
import { createSketchPad } from './ui/draw.js';
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
  trimBlank: el('trimBlank'),
  fitLimit: el('fitLimit'),
  colour: el('colour'),
  language: el('language'),
  downloadHtml: el('downloadHtml'),
  downloadAnsi: el('downloadAnsi'),
  dotEdit: el('dotEdit'),
  dotUndo: el('dotUndo'),
  dotHint: el('dotHint'),
  sourceKind: el('sourceKind'),
  textInput: el('textInput'),
  textFont: el('textFont'),
  textBold: el('textBold'),
  camera: el('camera'),
  cameraCapture: el('cameraCapture'),
  drawCanvas: el('drawCanvas'),
  brushErase: el('brushErase'),
  drawClear: el('drawClear'),
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
let camera = null;
let sketchPad = null;

// Requests are answered out of order once they are asynchronous; a reply is
// only applied while it is still the newest of its kind.
let previewToken = 0;
let generateToken = 0;

/**
 * Bumped by every message, so a render can tell whether anything more
 * interesting was said while it was working.
 */
let statusStamp = 0;

function setStatus(message, kind = 'info') {
  dom.status.textContent = message;
  dom.status.dataset.kind = kind;
  statusStamp++;
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
  colour: dom.colour.checked,
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
    setStatus(t('status.needImage'), 'warn');
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
  const { text, pixels, colours, cols: gridCols } = await pipeline.generate(
    readImageData(target), readAdjustments(), readOptions(),
  );
  if (token !== generateToken) return;

  if (dom.trimBlank.checked) {
    const bounds = trimBounds(text);
    artColours = trimColours(colours, gridCols, bounds);
    artText = trimBlank(text);
    artCols = bounds ? bounds.right - bounds.left + 1 : 0;
  } else {
    artColours = colours;
    artText = text;
    artCols = gridCols;
  }

  nextPart = 0;
  paintArt();
  dotEditor?.forget();
  dom.dotUndo.disabled = true;
  applyFontSize();
  putImageData(dom.resCanvas, pixels);
  dom.gridMeta.textContent = `${cols * CELL_W}×${rows * CELL_H}`;
  updateMeta(artText, { cols, rows });
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

// An error may carry a key rather than a sentence: the module that threw it
// should not have to know which language the page is in.
const fail = (error) => setStatus(
  error?.i18n ? t(error.i18n, { reason: error.message }) : String(error?.message ?? error),
  'error',
);

const schedulePreview = coalesce(() => { renderPreview().catch(fail); });
/**
 * "Done." is only worth saying when there is nothing better to say. Anything
 * that reports a result and redraws -- picking a threshold, fitting to a limit
 * -- used to have its message wiped a fraction of a second later by the render
 * it had itself triggered.
 */
const renderThen = coalesce((stamp) => {
  render()
    .then(() => {
      if (statusStamp === stamp) setStatus(t('status.done'), 'ok');
    })
    .catch(fail);
});
const scheduleRender = () => renderThen(statusStamp);

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
    setStatus(t('dots.frozen'), 'warn');
    return;
  }
  if (isLive()) {
    scheduleRender();
  } else if (artText) {
    setStatus(t('status.tooBigForLive'), 'warn');
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
    setStatus(t('source.loaded', { w: image.naturalWidth, h: image.naturalHeight }));
    schedulePreview();
    scheduleRender();
  }, { once: true });

  image.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    setStatus(t('source.unreadable'), 'error');
  }, { once: true });

  image.src = url;
}

function requireArt() {
  if (artText) return true;
  setStatus(t('status.needArt'), 'warn');
  return false;
}

async function autoThreshold() {
  if (!source) {
    setStatus(t('status.needImage'), 'warn');
    return;
  }
  const { cols, rows } = resolveGrid();
  // Measure the histogram of the pixels that will actually be encoded, not of
  // the preview -- downscaling changes the distribution.
  const target = drawScaled(source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()), { smooth: smoothScaling, crop: cropRect });
  const threshold = await pipeline.otsu(readImageData(target), readAdjustments(), readOptions());
  controls.threshold.set(threshold);
  setStatus(t('threshold.picked', { value: threshold }), 'ok');
  changed({ affectsPreview: false });
}

/** The size line, plus how the art measures against the target's limit. */
function updateMeta(text, sampled = null) {
  const lines = text.split('\n');
  const rows = lines.length;
  const cols = lines[0]?.length ?? 0;
  const platform = dom.platform.value;
  const { limit } = PLATFORMS[platform];

  const trimmed = sampled && (sampled.cols !== cols || sampled.rows !== rows);
  const parts = [
    trimmed
      ? t('meta.trimmed', { fromCols: sampled.cols, fromRows: sampled.rows, cols, rows })
      : t('meta.size', { cols, rows }),
    t('meta.characters', { count: text.length }),
  ];

  // Width is only half the problem: the message length limit is the wall that
  // actually stops a paste, and it is easy to sail past without noticing.
  let over = false;
  if (Number.isFinite(limit)) {
    const length = messageLength(text, platform);
    over = length > limit;
    parts.push(
      t('meta.limit', { platform: t(`platform.${platform}`), used: length, limit })
      + (over ? t('meta.over') : ''),
    );
  }

  dom.meta.textContent = parts.join(' · ');
  dom.meta.classList.toggle('over', over);
}

function fillPresets() {
  dom.preset.replaceChildren(new Option(t('preset.none'), ''));
  for (const key of Object.keys(CONTENT_PRESETS)) {
    dom.preset.append(new Option(t(`preset.${key}`), key));
  }
}

/**
 * A preset writes every control it covers, so choosing one twice always lands
 * in the same place regardless of what was adjusted in between.
 */
function applyPreset(key) {
  const preset = CONTENT_PRESETS[key];
  dom.presetHint.textContent = preset ? t(`preset.${key}.hint`) : '';
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
    ...Object.keys(PLATFORMS).map((key) => new Option(t(`platform.${key}`), key)),
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
      t('platform.measured', { width, scale: scale.toFixed(2) });
    dom.cols.value = width;
  } else {
    dom.platformState.textContent =
      t('platform.unmeasured');
  }

  dom.fitLimit.disabled = !Number.isFinite(PLATFORMS[key].limit);
  dom.calibratedWidth.value = width ?? clampInt(dom.cols.value, 1, MAX_COLS, 80);
  controls.calibratedScale.set(scale);
  syncRows();
}

function exportSvg() {
  downloadSvg(brailleToSvg(artText, exportStyle()), 'braille.svg');
  setStatus(t('status.svgSaved'), 'ok');
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
    language: currentLocale(),
    keepAspect: dom.keepAspect.checked,
    textBold: dom.textBold.checked,
    colour: dom.colour.checked,
    trimBlank: dom.trimBlank.checked,
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
  if (typeof values.trimBlank === 'boolean') dom.trimBlank.checked = values.trimBlank;
  if (typeof values.colour === 'boolean') dom.colour.checked = values.colour;
  if (typeof values.smooth === 'boolean') smoothScaling = values.smooth;

  setLayout(dom.layout.value);
  dom.presetHint.textContent = CONTENT_PRESETS[dom.preset.value] ? t(`preset.${dom.preset.value}.hint`) : '';
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
  dom.trimBlank.checked = false;
  dom.colour.checked = false;
  smoothScaling = true;
  dom.presetHint.textContent = '';
  setLayout(LAYOUTS[0]);

  syncEdgeControls();
  syncPlatform();
  syncRows();
  setSourceKind(dom.sourceKind.value);
  setStatus(t('reset.allDone'), 'info');
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
    else setStatus(t('source.notAnImage'), 'warn');
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
  caption.textContent = t('inspect.close', { w: preview.width, h: preview.height });

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
  paintArt();
  updateMeta(next);
  dom.dotUndo.disabled = !dotEditor?.canUndo();
}

function setEditing(on) {
  dotEditor.setEnabled(on);
  dom.app.classList.toggle('editing', on);
  dom.dotEdit.setAttribute('aria-pressed', String(on));
  dom.dotUndo.disabled = !on || !dotEditor.canUndo();
  dom.dotHint.textContent = on
    ? t('dots.hint')
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
function fillLanguages() {
  dom.language.replaceChildren(
    ...Object.entries(LOCALES).map(([code, locale]) => {
      const chosen = code === currentLocale();
      return new Option(locale.name, code, chosen, chosen);
    }),
  );
}

/**
 * Everything the markup cannot carry on a data-i18n attribute: option labels
 * built at run time, hints chosen by state, and the meta line, which is
 * assembled from numbers.
 */
function retranslate() {
  const chosen = {
    preset: dom.preset.value,
    platform: dom.platform.value,
    font: dom.textFont.value,
  };

  fillLanguages();
  fillPresets();
  fillPlatforms();
  fillFonts();

  dom.preset.value = chosen.preset;
  dom.platform.value = chosen.platform;
  dom.textFont.value = chosen.font;

  dom.presetHint.textContent = CONTENT_PRESETS[chosen.preset] ? t(`preset.${chosen.preset}.hint`) : '';
  dom.dotHint.textContent = dotEditor?.isEnabled() ? t('dots.hint') : '';
  syncPlatform();
  if (artText) updateMeta(artText);
  setStatus(artText ? t('status.done') : t('status.start'), 'info');
}

function fillFonts() {
  dom.textFont.replaceChildren(
    ...Object.keys(TEXT_FONTS).map((key) => {
      const isDefault = key === DEFAULT_TEXT_FONT;
      return new Option(t(`font.${key}`), key, isDefault, isDefault);
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
const scheduleSketch = coalesce(useSketchSource);

const SOURCE_KINDS = ['image', 'text', 'camera', 'draw'];

function setSourceKind(kind) {
  const next = SOURCE_KINDS.includes(kind) ? kind : 'image';
  dom.sourceKind.value = next;
  dom.app.dataset.source = next;

  // Holding the camera open in another mode would leave the light on for
  // nothing, so the stream is released the moment it stops being the subject.
  if (next !== 'camera' && camera?.isRunning()) camera.stop();

  if (next === 'text') {
    useTextSource();
    return;
  }
  if (next === 'draw') {
    useSketchSource();
    return;
  }
  if (next === 'camera') {
    startCamera();
    // Whatever was captured last stays the subject until a new frame is taken.
  }

  source = imageSource;
  previewReady = false;
  describeSource();
  if (source) {
    changed();
  } else if (next === 'camera') {
    dom.output.textContent = '';
    artText = '';
  } else {
    dom.output.textContent = '';
    artText = '';
    setStatus(t('source.prompt'));
  }
}

/* ------------------------------------------------------------------------ *
 * Making it fit
 *
 * Knowing the art is over the limit is not much use on its own. These are the
 * three ways out: drop what is not picture, sample smaller, or send it in
 * pieces.
 * ------------------------------------------------------------------------ */

/** Render at a given width without touching the page, for searching. */
async function artAtWidth(cols) {
  const rows = dom.keepAspect.checked ? rowsFor(cols) : clampInt(dom.rows.value, 1, MAX_ROWS, 30);
  const target = drawScaled(
    source, cols * CELL_W, rows * CELL_H, backgroundFor(isInverted()),
    { smooth: smoothScaling, crop: cropRect },
  );
  const { text } = await pipeline.generate(readImageData(target), readAdjustments(), readOptions());
  return dom.trimBlank.checked ? trimBlank(text) : text;
}

/**
 * The widest sampling that still fits one message.
 *
 * Binary search rather than stepping down: the relationship is monotonic enough
 * and a probe costs a full render, so nine of them beats a hundred.
 */
async function fitToLimit() {
  if (!source) {
    setStatus(t('status.needImage'), 'warn');
    return;
  }
  const platform = dom.platform.value;
  const { limit } = PLATFORMS[platform];
  if (!Number.isFinite(limit)) {
    setStatus(t('platform.noLimit'), 'warn');
    return;
  }

  setStatus(t('fit.searching', { platform: t(`platform.${platform}`) }));
  let low = 8;
  let high = MAX_COLS;
  let widest = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = await artAtWidth(middle);
    if (messageLength(candidate, platform) <= limit) {
      widest = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (widest === null) {
    setStatus(t('fit.impossible', { platform: t(`platform.${platform}`) }), 'warn');
    return;
  }
  dom.cols.value = widest;
  syncRows();
  changed({ affectsPreview: false });
  setStatus(t('fit.found', { width: widest, platform: t(`platform.${platform}`) }), 'ok');
}

/**
 * Copying in pieces.
 *
 * The clipboard holds one thing, so an art that needs three messages is handed
 * over one press at a time, and the status says where you are.
 */
let nextPart = 0;

async function copyArt() {
  const platform = dom.platform.value;
  const parts = splitForPlatform(artText, platform);

  if (parts.length === 1) {
    await copyText(forPlatform(artText, platform));
    setStatus(
      PLATFORMS[platform].codeBlock
        ? t('status.copiedFenced')
        : t('status.copied'),
      'ok',
    );
    return;
  }

  if (nextPart >= parts.length) nextPart = 0;
  const index = nextPart;
  await copyText(forPlatform(parts[index], platform));
  nextPart = index + 1;

  const oversized = !partsFit(parts, platform);
  setStatus(
    t('status.part', { index: index + 1, total: parts.length })
    + (nextPart < parts.length ? t('status.partNext') : t('status.partLast'))
    + (oversized ? t('status.partOversized') : ''),
    oversized ? 'warn' : 'ok',
  );
}

/** Sources that are their own canvas: what is drawn is what is encoded. */
const LIVE_SOURCES = new Set(['draw']);

function useSketchSource() {
  source = sketchPad.canvas;
  previewReady = false;
  describeSource();
  changed();
}

async function startCamera() {
  try {
    await camera.start();
    setStatus(t('camera.ready'), 'ok');
  } catch (error) {
    // Refusing permission or having no camera is an ordinary answer, not a
    // fault: say so and fall back rather than leaving a dead mode on screen.
    setStatus(error.message, 'warn');
  }
}

function captureFrame() {
  const frame = camera.capture(createCanvas);
  if (!frame) {
    setStatus(t('camera.notStarted'), 'warn');
    return;
  }
  source = frame;
  imageSource = frame;
  previewReady = false;
  cropRect = null;
  cropper?.set(null);
  describeSource();
  changed();
  setStatus(t('camera.captured', { w: frame.width, h: frame.height }), 'ok');
}

/* ------------------------------------------------------------------------ *
 * Colour
 *
 * Kept alongside the text rather than inside it: the art stays a plain string
 * that can be copied, saved and hand-edited, and the colours are a parallel
 * array of one entry per cell. Formats that cannot carry colour simply ignore
 * it.
 * ------------------------------------------------------------------------ */

/** Past this many cells the page is painted plain; the exports keep the colour. */
const COLOUR_CELL_LIMIT = 40000;

let artColours = null;
let artCols = 0;

function paintArt() {
  const lines = artText.split('\n');

  if (!artColours || artCols === 0) {
    dom.output.textContent = artText;
    return;
  }
  if (lines.length * artCols > COLOUR_CELL_LIMIT) {
    dom.output.textContent = artText;
    setStatus(t('colour.tooLarge'), 'warn');
    return;
  }

  // Only braille glyphs and the markup built here ever reach innerHTML.
  dom.output.innerHTML = lines
    .map((line, row) => colourRuns(artColours, row, line.length)
      .map(({ start, end, index }) =>
        `<span style="color:${cellHex(artColours, index)}">${line.slice(start, end)}</span>`)
      .join(''))
    .join('\n');
}

/** Everything the colour-aware exports need, in one place. */
function exportStyle() {
  const style = getComputedStyle(dom.output);
  const { fontFamily, fontSize, lineHeight } = outputMetrics();
  return {
    fontFamily,
    fontSize,
    lineHeight,
    foreground: style.color,
    background: style.backgroundColor,
    colours: artColours,
  };
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

  // A stored choice beats the browser's preference. applyTranslations runs for
  // the first time here, before anything is listening for changes.
  initLocale(loadSettings().language ?? preferredLocale());
  onLocaleChange(retranslate);

  fillLanguages();
  fillPresets();
  fillPlatforms();
  fillFonts();

  dom.language.addEventListener('change', () => {
    setLocale(dom.language.value);
    persist();
  });

  applySettings(loadSettings());

  dom.sourceKind.addEventListener('change', () => {
    setSourceKind(dom.sourceKind.value);
    persist();
  });
  camera = createCamera(dom.camera);
  sketchPad = createSketchPad(dom.drawCanvas, () => {
    // The pad is the source, so every stroke invalidates what was sampled.
    previewReady = false;
    scheduleSketch();
  });

  controls.brushSize = bindRange(el('brushSize'), el('brushSizeVal'), {
    onChange: () => sketchPad.setBrush(controls.brushSize.value),
  });
  sketchPad.setBrush(controls.brushSize.value);

  dom.cameraCapture.addEventListener('click', captureFrame);
  dom.brushErase.addEventListener('click', () => {
    const on = !sketchPad.isErasing();
    sketchPad.setErasing(on);
    dom.brushErase.setAttribute('aria-pressed', String(on));
  });
  dom.drawClear.addEventListener('click', () => sketchPad.clear());

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
      setStatus(t('calibrate.rulerCopied'), 'ok');
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
    setStatus(t('calibrate.saved'), 'ok');
    changed({ affectsPreview: false });
  });

  dom.resetCalibration.addEventListener('click', () => {
    clearCalibration(dom.platform.value);
    syncPlatform();
    setStatus(t('calibrate.cleared'), 'info');
    changed({ affectsPreview: false });
  });

  dom.downloadSvg.addEventListener('click', () => {
    if (requireArt()) exportSvg();
  });

  dom.colour.addEventListener('change', () => changed({ affectsPreview: false }));

  dom.downloadHtml.addEventListener('click', () => {
    if (!requireArt()) return;
    downloadHtml(brailleToHtml(artText, artColours, artCols, exportStyle()), 'braille.html');
    setStatus(artColours ? t('status.htmlSavedColour') : t('status.htmlSaved'), 'ok');
  });

  dom.downloadAnsi.addEventListener('click', () => {
    if (!requireArt()) return;
    downloadText(brailleToAnsi(artText, artColours, artCols), 'braille.ans');
    setStatus(
      artColours
        ? t('status.ansiSaved')
        : t('status.ansiNoColour'),
      'ok',
    );
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
    setStatus(rect ? t('crop.selected') : t('crop.whole'), 'info');
    changed();
  });

  dom.cropToggle.addEventListener('click', () => {
    const on = !cropper.isActive();
    cropper.setActive(on);
    dom.cropToggle.setAttribute('aria-pressed', String(on));
    if (on) setStatus(t('crop.prompt'), 'info');
  });

  dom.cropReset.addEventListener('click', () => cropper.reset());
  dom.trimBlank.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.fitLimit.addEventListener('click', () => { fitToLimit().catch(fail); });

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
    if (dotEditor.undo()) setStatus(t('dots.undone'), 'info');
  });

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'z') return;
    if (!dotEditor.isEnabled()) return;
    event.preventDefault();
    if (dotEditor.undo()) setStatus(t('dots.undone'), 'info');
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
      dom.dotHint.textContent = t('dots.discarded');
    } else {
      setStatus(t('status.working'));
    }
    scheduleRender();
  });

  dom.reset.addEventListener('click', () => {
    for (const name of ['brightness', 'contrast', 'saturation', 'sharpness']) {
      controls[name].reset();
    }
    changed();
    setStatus(t('reset.editsDone'), 'info');
  });

  dom.downloadTxt.addEventListener('click', () => {
    if (requireArt()) downloadText(artText, 'braille.txt');
  });

  dom.copy.addEventListener('click', async () => {
    if (!requireArt()) return;
    try {
      await copyArt();
    } catch (error) {
      fail(error);
    }
  });

  dom.downloadPng.addEventListener('click', () => {
    if (!requireArt()) return;
    const { canvas, scale } = renderTextToCanvas(artText, exportStyle());
    downloadCanvas(canvas, 'braille.png');
    setStatus(
      scale < 1
        ? t('status.pngScaled', { percent: Math.round(scale * 100) })
        : t('status.pngSaved'),
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
      ? t('status.start')
      : t('status.startInline'),
  );
}

init();
