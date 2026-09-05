// SPDX-License-Identifier: GPL-3.0-or-later
// Wiring: reads the controls, drives the pipeline, paints the previews.
// All pixel work lives in ./core; this and ./ui are the only files touching the DOM.

import { CELL_W, CELL_H, rowsForAspect, trimBlank, trimBounds, trimColours } from './core/braille.js';
import {
  LOCALES, currentLocale, initLocale, onLocaleChange, preferredLocale, setLocale, t,
} from './i18n/index.js';
import { cellHex, colourRuns } from './core/colour.js';
import { paletteFor, snap } from './core/palette.js';
import { DEFAULT_DITHER, DIFFUSING } from './core/dither.js';
import { CONTENT_PRESETS } from './core/presets.js';
import { classifyImage } from './core/classify.js';
import { APP_VERSION } from './version.js';
import { DRAWS_PER_FAMILY, VARIANT_FAMILIES } from './core/variants.js';
import { fitWithin } from './core/pixels.js';
import { canDraw, createCanvas, drawScaled, putImageData, readImageData } from './ui/canvas.js';
import { bindRange, clampInt, coalesce } from './ui/controls.js';
import { keepsUp } from './ui/pace.js';
import {
  SVG_DOT_LIMIT, brailleToAnsi, brailleToHtml, brailleToSvg, canShare, copyCanvas, copyText,
  downloadCanvas, downloadHtml, downloadSvg, downloadText, raisedDots, renderDotsToCanvas, shareArt,
} from './ui/export.js';
import {
  PLATFORMS, calibrationOf, clearCalibration, forPlatform, messageLength, partsFit, ruler,
  saveCalibration, splitForPlatform,
} from './ui/platforms.js';
import { clearSettings, loadSettings, saveSettings } from './ui/settings.js';
import { deleteWork, listWorks, packWork, readWork, saveWork, unpackWork } from './ui/store.js';
import { fromHash, shareUrl, textFits, updateHash } from './ui/link.js';
import { createCropper } from './ui/crop.js';
import { createDotEditor } from './ui/dots.js';
import { createLatticeView } from './ui/lattice.js';
import { GLYPH_SETS, cellsOf, toGlyphs } from './core/glyphs.js';
import { DEFAULT_TEXT_FONT, TEXT_FONTS, renderText } from './ui/text.js';
import { createCamera } from './ui/camera.js';
import { createSketchPad } from './ui/draw.js';
import { createPipeline } from './ui/pipeline.js';

const MAX_COLS = 400;
const MAX_ROWS = 400;
const PREVIEW_LIMIT = { w: 900, h: 700 };

/**
 * How much of the picture the encoder is allowed to look at.
 *
 * Larger than the grid, because structure only exists above it, and bounded,
 * because every one of these pixels is walked in script rather than by the
 * browser. On ordinary sizes the budget never binds: an 80-column art asks for
 * 640x368.
 */
const DETAIL_SCALE = 4;
const DETAIL_BUDGET = 2_000_000;

/**
 * What the last redraw cost, and how much of it there was.
 *
 * The art follows the sliders while a redraw stays quick, and the only honest
 * way to know that is to have timed one -- see ui/pace.js for why a cell count
 * was the wrong unit.
 */
let lastRender = null;
let following = true;

/**
 * What the app worked out for itself, as opposed to what it was told.
 *
 * There is a lot of it now -- the kind of picture, the threshold, whether a
 * redraw still keeps up, what cleaning is doing -- and almost all of it was
 * announced once in the status line and then gone. Kept here so the panel can
 * say what is in effect rather than what happened a minute ago.
 */
let detectedKind = null;
let thresholdFromOtsu = false;
let lastSampling = null;

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
  edgeColour: el('edgeColour'),
  fitLimit: el('fitLimit'),
  colour: el('colour'),
  cellGround: el('cellGround'),
  colourPattern: el('colourPattern'),
  palette: el('palette'),
  decided: el('decided'),
  decidedList: el('decidedList'),
  transparent: el('transparent'),
  language: el('language'),
  copyLink: el('copyLink'),
  downloadHtml: el('downloadHtml'),
  downloadAnsi: el('downloadAnsi'),
  dotEdit: el('dotEdit'),
  dotUndo: el('dotUndo'),
  dotHint: el('dotHint'),
  dotCursor: el('dotCursor'),
  padCursor: el('padCursor'),
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
  suggest: el('suggest'),
  settingsUndo: el('settingsUndo'),
  settingsRedo: el('settingsRedo'),
  generate: el('generate'),
  reset: el('resetEdits'),
  output: el('output'),
  lattice: el('lattice'),
  evenGrid: el('evenGrid'),
  theme: el('theme'),
  glyphSet: el('glyphSet'),
  glyphHint: el('glyphHint'),
  status: el('status'),
  meta: el('meta'),
  srcCanvas: el('srcCanvas'),
  editCanvas: el('editCanvas'),
  resCanvas: el('resCanvas'),
  downloadTxt: el('downloadTxt'),
  copy: el('copy'),
  copyImage: el('copyImage'),
  share: el('share'),
  worksPanel: el('worksPanel'),
  worksList: el('worksList'),
  worksHint: el('worksHint'),
  workName: el('workName'),
  workSave: el('workSave'),
  styleSave: el('styleSave'),
  workExport: el('workExport'),
  workImport: el('workImport'),
  workFile: el('workFile'),
  downloadPng: el('downloadPng'),
};

const pipeline = createPipeline();
const controls = {};

let source = null;            // whatever is being encoded: a photo or drawn lettering
let imageSource = null;       // the last loaded file, kept while text is in use
let sourceBlob = null;        // and the bytes it came from, for saving the work
let sourceUrl = null;         // object URL backing `source`
let previewReady = false;
let previewBackground = null; // background the preview source was composited over
let artText = '';
let linkOpened = false;

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
  emphasis: controls.emphasis.value / 100,
  colour: dom.colour.checked,
  // The second colour is only meaningful where something can draw a background,
  // so it is asked for separately rather than implied by colour.
  ground: dom.colour.checked && dom.cellGround.checked,
  // Colour picks the dots only where it has both colours to pick between.
  pattern: dom.colour.checked && dom.cellGround.checked && dom.colourPattern.checked ? 'colour' : 'tone',
  detail: controls.detail.value / 100,
  edge: {
    mode: dom.edgeMode.value,
    amount: controls.edgeAmount.value / 100,
    radius: controls.edgeRadius.value,
    clean: controls.edgeClean.value / 100,
    colour: dom.edgeColour.checked,
  },
});

/** The line controls mean nothing until a detector is chosen. */
/** The emphasis only means anything where the error is handed on. */
function syncEmphasis() {
  controls.emphasis.input.disabled = !DIFFUSING.has(dom.dither.value || DEFAULT_DITHER);
}

function syncEdgeControls() {
  const off = dom.edgeMode.value === 'none';
  controls.edgeAmount.input.disabled = off;
  controls.edgeRadius.input.disabled = off;
  controls.edgeClean.input.disabled = off;
  dom.edgeColour.disabled = off;
  syncEmphasis();
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

function detailSize(cols, rows) {
  const gridW = cols * CELL_W;
  const gridH = rows * CELL_H;
  let w = Math.max(gridW, Math.min(gridW * DETAIL_SCALE, sourceW()));
  let h = Math.max(gridH, Math.min(gridH * DETAIL_SCALE, sourceH()));

  const fit = Math.sqrt(DETAIL_BUDGET / (w * h));
  if (fit < 1) {
    w = Math.max(gridW, Math.round(w * fit));
    h = Math.max(gridH, Math.round(h * fit));
  }
  return { w, h };
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
  const detail = detailSize(cols, rows);
  lastSampling = { w: sourceW(), h: sourceH(), dw: detail.w, dh: detail.h, cols, rows };
  const target = drawScaled(source, detail.w, detail.h, backgroundFor(isInverted()), { smooth: smoothScaling, crop: cropRect });

  const token = ++generateToken;
  const { text, pixels, colours, background, cols: gridCols } = await pipeline.generate(
    readImageData(target), readAdjustments(), { ...readOptions(), grid: { cols, rows } },
  );
  if (token !== generateToken) return;

  // Snapped here, once, so the screen, the HTML, the PNG, the SVG and the
  // terminal all agree about what colour a cell is.
  // One palette for both, chosen from the ink: two palettes would let a cell's
  // ground land on a colour its ink could not have, and the pair is meant to
  // come from the same picture.
  const palette = paletteFor(dom.palette.value, colours);
  const painted = snap(colours, palette);
  const behind = snap(background, palette);

  if (dom.trimBlank.checked) {
    const bounds = trimBounds(text);
    artColours = trimColours(painted, gridCols, bounds);
    artGround = trimColours(behind, gridCols, bounds);
    artText = trimBlank(text);
    artCols = bounds ? bounds.right - bounds.left + 1 : 0;
  } else {
    artColours = painted;
    artGround = behind;
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

/**
 * Light or dark, or whatever the system is saying.
 *
 * The attribute goes on the root element rather than on the app, because the
 * page's own background is painted from there -- set it lower down and the
 * margins keep the other theme. "As the system says" removes the attribute
 * instead of setting one, so the media query is back in charge.
 */
function applyTheme() {
  const chosen = dom.theme.value;
  if (chosen === 'light' || chosen === 'dark') {
    document.documentElement.dataset.theme = chosen;
  } else {
    delete document.documentElement.dataset.theme;
  }
  // The art is drawn from the page's own colours, so it has to be redrawn
  // when they change; the text under it follows on its own.
  lattice?.redraw();
}

function applyFontSize() {
  dom.output.style.fontSize = `${clampInt(dom.fontSize.value, 6, 48, 12)}px`;
  lattice?.redraw();
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
 * One redraw at a time, and always the newest one.
 *
 * Coalescing by animation frame is not enough on its own: it merges the events
 * of a single frame, then the next frame starts another redraw regardless of
 * whether the last has finished. Dragging a slider over a large grid therefore
 * queued a redraw every frame, each of which the worker dutifully computed and
 * the page then threw away as stale -- the art arrived long after the hand had
 * stopped. Now a request that finds one already running only leaves a note, and
 * the settings are read afresh when that note is picked up.
 *
 * "Done." is only worth saying when there is nothing better to say: anything
 * that reports a result and redraws -- picking a threshold, fitting to a limit
 * -- used to have its message wiped a fraction of a second later by the redraw
 * it had itself triggered.
 */
let rendering = false;
let renderWanted = false;

async function keepRendering() {
  rendering = true;
  try {
    do {
      renderWanted = false;
      const stamp = statusStamp;
      const { cols, rows } = resolveGrid();
      const started = performance.now();
      await render();
      lastRender = { ms: performance.now() - started, cells: cols * rows };
      following = keepsUp(lastRender.cells, lastRender, following);
      describeDecisions();
      describeArt();
      if (statusStamp === stamp) setStatus(t('status.done'), 'ok');
    } while (renderWanted);
  } finally {
    rendering = false;
  }
}

const scheduleRender = () => {
  if (rendering) { renderWanted = true; return; }
  keepRendering().catch(fail);
};

const isLive = () => {
  const { cols, rows } = resolveGrid();
  return keepsUp(cols * rows, lastRender, following);
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
  sourceBlob = file;
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
    // A new picture is a new question, so the detector answers it again --
    // after the loaded message, whose place it takes.
    if (dom.preset.value === AUTO_PRESET) detectPreset();
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
  const detail = detailSize(cols, rows);
  const target = drawScaled(source, detail.w, detail.h, backgroundFor(isInverted()), { smooth: smoothScaling, crop: cropRect });
  const threshold = await pipeline.otsu(readImageData(target), readAdjustments(), { ...readOptions(), grid: { cols, rows } });
  controls.threshold.set(threshold);
  thresholdFromOtsu = true;
  setStatus(t('threshold.picked', { value: threshold }), 'ok');
  changed({ affectsPreview: false });
}

/** The size line, plus how the art measures against the target's limit. */
/**
 * Say what the art is, for anyone who cannot see it.
 *
 * A screen reader meeting this element without help reads the braille patterns
 * one after another -- several thousand of them, in a row, as dot numbers. For
 * an app that makes pictures out of braille that is worse than unhelpful: the
 * one group of people who read braille for real get the worst of it.
 *
 * So the art is what it is, a picture, and says so: role="img" makes the label
 * the whole of it and the characters are passed over. The label is built here
 * rather than left in the markup because it has to describe this art, not the
 * idea of one.
 *
 * The role comes off while dots are being edited by hand, because then the
 * element is not a picture but a thing being worked on, and the status line --
 * which is already a live region -- is what reports each change.
 */
function describeArt() {
  const editing = Boolean(dotEditor?.isEnabled());
  // One split, and the newline built rather than written: this shell eats a
  // doubled backslash inside a heredoc, and has done four times now.
  const lines = artText ? artText.split(String.fromCharCode(10)) : [];
  const rows = lines.length;
  const cols = lines[0]?.length ?? 0;

  if (editing) {
    dom.output.removeAttribute('role');
    dom.output.setAttribute('aria-label', t('art.describesEditing', { cols, rows }));
    return;
  }

  dom.output.setAttribute('role', 'img');
  dom.output.setAttribute('aria-label', artText
    ? t('art.describes', {
      source: t(`source.${dom.sourceKind.value}`),
      cols,
      rows,
      // Its own key, because a language with three plural forms needs one
      // count per phrase and this sentence carries three numbers.
      chars: t('art.chars', { count: artText.length }),
    })
    : t('art.describesNone'));
}

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
    // Counted the way a message limit counts: a block glyph outside the basic
    // plane is two units, and a room that cuts at a number cuts at that one.
    t('meta.characters', { count: toGlyphs(text, glyphSet()).length }),
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

/** Not a preset but a way of choosing one, so it lives beside them, not among them. */
const AUTO_PRESET = 'auto';

/** How large a raster the detector reads. Enough to judge by, cheap to make. */
const STUDY_SIZE = 384;

function fillPresets() {
  dom.preset.replaceChildren(new Option(t('preset.none'), ''));
  dom.preset.append(new Option(t('preset.auto'), AUTO_PRESET));
  for (const key of Object.keys(CONTENT_PRESETS)) {
    dom.preset.append(new Option(t(`preset.${key}`), key));
  }
}

const hintFor = (key) => {
  if (key === AUTO_PRESET) return t('preset.auto.hint');
  return CONTENT_PRESETS[key] ? t(`preset.${key}.hint`) : '';
};

/**
 * Look at the picture, and set the controls the way its kind wants them.
 *
 * The answer is announced rather than applied quietly: it is a guess, and a
 * guess that says what it saw can be overruled by picking a kind by hand.
 */
function detectPreset() {
  dom.presetHint.textContent = hintFor(AUTO_PRESET);
  if (!source) return null;

  const scale = Math.min(1, STUDY_SIZE / Math.max(sourceW(), sourceH()));
  // Sharp scaling on purpose. Smoothing would blur away the repeated columns
  // that give enlarged pixel art away, which is the one thing it is known by.
  const study = drawScaled(
    source,
    Math.max(8, Math.round(sourceW() * scale)),
    Math.max(8, Math.round(sourceH() * scale)),
    backgroundFor(isInverted()),
    { smooth: false, crop: cropRect },
  );

  const { kind } = classifyImage(readImageData(study));
  detectedKind = kind;
  applyPreset(kind);
  // applyPreset writes that kind's own hint; the chosen kind is still auto.
  dom.presetHint.textContent = hintFor(AUTO_PRESET);
  setStatus(t('preset.detected', { kind: t(`preset.${kind}`) }), 'info');
  return kind;
}

/**
 * A preset writes every control it covers, so choosing one twice always lands
 * in the same place regardless of what was adjusted in between.
 */
function applyPreset(key) {
  const preset = CONTENT_PRESETS[key];
  dom.presetHint.textContent = hintFor(key);
  if (!preset) return;

  const chosen = preset.settings;
  // The preset is setting this, so it is no longer Otsu's answer. set() does
  // not go through the control's onChange, which is where that is normally
  // cleared -- without this the panel credited Otsu with a preset's number.
  thresholdFromOtsu = false;
  dom.dither.value = chosen.method;
  dom.edgeMode.value = chosen.edgeMode;
  controls.detail.set(chosen.detail);
  controls.threshold.set(chosen.threshold);
  controls.edgeAmount.set(chosen.edgeAmount);
  controls.edgeRadius.set(chosen.edgeRadius);
  controls.edgeClean.set(chosen.edgeClean);
  dom.edgeColour.checked = Boolean(chosen.edgeColour);
  controls.emphasis.set(chosen.emphasis);
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
  // Which of the two forms it got is worth saying: one is the lattice the page
  // shows, the other is at the mercy of the reader's font.
  setStatus(t(raisedDots(artText) <= SVG_DOT_LIMIT ? 'status.svgDrawn' : 'status.svgTypeset'), 'ok');
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
 * Saved work
 *
 * Two places, and the panel says why: the browser remembers, a file keeps.
 * What is stored is the settings, the art as it stands, and the picture it was
 * made from -- without that last one a saved work could be looked at but never
 * worked on again, which is not what saving means.
 * ------------------------------------------------------------------------ */
let worksReady = true;

/** The picture as bytes, whatever kind of source it came from. */
async function sourceBytes() {
  if (dom.sourceKind.value === 'image' && sourceBlob) {
    return { kind: 'image', name: sourceBlob.name ?? '', blob: sourceBlob };
  }
  // Lettering, a camera frame, a drawing: no file ever existed, so one is made.
  if (!source) return null;
  const canvas = createCanvas(sourceW(), sourceH());
  canvas.getContext('2d').drawImage(source, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? { kind: dom.sourceKind.value, name: '', blob } : null;
}

/**
 * A small drawing of the art, for telling one saved work from another.
 *
 * Drawn rather than typeset, by the same function as the page and the PNG, so
 * a thumbnail cannot show something the art does not. Small enough to store
 * beside every work without thinking about it: a hundred cells across comes to
 * a couple of kilobytes.
 */
const THUMB_W = 208;
const THUMB_H = 104;

async function thumbOf() {
  const lines = artText.split('\n');
  const cols = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const rows = lines.length;
  if (!cols || !rows) return null;

  // The cell keeps its 1:2 shape, and whichever of the two axes runs out first
  // decides the size -- a tall art and a wide one both land inside the box.
  const advance = Math.max(1, Math.min(THUMB_W / cols, THUMB_H / rows / 2));
  const { canvas } = renderDotsToCanvas(artText, {
    advancePx: advance,
    lineHeightPx: advance * 2,
    foreground: getComputedStyle(dom.output).getPropertyValue('--ink').trim() || '#ffffff',
    background: dom.transparent.checked ? 'transparent' : getComputedStyle(dom.output).backgroundColor,
    colours: artColours,
    ground: artGround,
    fill: glyphSet() === 'octants' ? 'blocks' : 'dots',
  });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Everything needed to open this again, later. */
async function currentWork() {
  const lines = artText.split('\n');
  return {
    name: dom.workName.value.trim() || t('works.namePlaceholder'),
    settings: collectSettings(),
    art: artText,
    cols: artCols || (lines[0]?.length ?? 0),
    rows: artText ? lines.length : 0,
    source: await sourceBytes(),
    thumb: await thumbOf(),
  };
}

/** Object URLs handed to the list, released when the list is rebuilt. */
let shownThumbs = [];

/** The settings alone, for putting on some other picture later. */
function currentStyle() {
  return {
    kind: 'style',
    name: dom.workName.value.trim() || t('works.namePlaceholder'),
    settings: collectSettings(),
    art: '',
    cols: 0,
    rows: 0,
    source: null,
    thumb: null,
  };
}

function showWorks(saved) {
  for (const url of shownThumbs) URL.revokeObjectURL(url);
  shownThumbs = [];

  dom.worksList.replaceChildren(...saved.map((work) => {
    const row = document.createElement('li');

    if (work.thumb) {
      const url = URL.createObjectURL(work.thumb);
      shownThumbs.push(url);
      const shot = document.createElement('img');
      shot.className = 'peek';
      shot.src = url;
      shot.alt = '';
      row.append(shot);
    }

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = work.name;

    const when = document.createElement('span');
    when.className = 'when';
    // A style has no size to give, so it says what it is instead.
    when.textContent = work.kind === 'style' ? t('works.style') : `${work.cols}×${work.rows}`;

    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = t('works.open');
    open.addEventListener('click', () => { openWork(work.id).catch(fail); });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = t('works.delete');
    drop.addEventListener('click', () => { removeWork(work.id, work.name).catch(fail); });

    row.append(who, when, open, drop);
    return row;
  }));

  if (!saved.length) {
    const row = document.createElement('li');
    // Its own class: the size next to a name never wraps, and this sentence
    // must, or the row runs a couple of screens off the side of a phone.
    row.className = 'none';
    row.textContent = t('works.empty');
    dom.worksList.replaceChildren(row);
  }
}

async function refreshWorks() {
  try {
    const saved = await listWorks();
    showWorks(saved);
    // The works' own size, not the origin's: navigator.storage counts the
    // offline cache too, and "3 saved, 64 MB" would be a lie about them.
    const bytes = saved.reduce((total, work) => total + work.bytes, 0);
    const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    const drop = t('works.dropHint');
    dom.worksHint.textContent = saved.length
      ? `${t('works.room', { count: saved.length, size })} · ${drop}`
      : drop;
  } catch (error) {
    worksReady = false;
    dom.worksList.replaceChildren();
    dom.worksHint.textContent = t(error?.i18n ?? 'works.unavailable');
    dom.workSave.disabled = true;
  }
}

/** Put a work back: the settings first, then the picture it was made from. */
async function applyWork(work) {
  if (work.source?.blob) {
    const file = new File([work.source.blob], work.source.name || 'work.png', { type: work.source.blob.type });
    await new Promise((resolve) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.addEventListener('load', () => {
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        source = image;
        imageSource = image;
        sourceUrl = url;
        sourceBlob = file;
        previewReady = false;
        cropRect = null;
        cropper?.set(null);
        dom.srcMeta.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
        resolve();
      }, { once: true });
      image.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(); }, { once: true });
      image.src = url;
    });
  }

  remember();
  applySettings(work.settings);
  dom.workName.value = work.name ?? '';
  syncEdgeControls();
  syncPlatform();
  syncRows();
  schedulePreview();
  scheduleRender();
}

async function openWork(id) {
  const work = await readWork(id);
  if (!work) return;
  await applyWork(work);
  // Opening a style puts it on whatever picture is already here, which is the
  // whole point of having saved one, so it says that rather than "opened".
  setStatus(t(work.kind === 'style' ? 'works.appliedStyle' : 'works.opened', { name: work.name }), 'ok');
}

async function removeWork(id, name) {
  await deleteWork(id);
  await refreshWorks();
  setStatus(t('works.deleted', { name }), 'info');
}

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */
const PERSISTED_RANGES = [
  'detail', 'threshold', 'brightness', 'contrast', 'saturation', 'sharpness', 'edgeAmount', 'edgeRadius',
  'edgeClean', 'emphasis',
];
const PERSISTED_FIELDS = [
  'preset', 'platform', 'dither', 'invert', 'edgeMode', 'outWidth', 'outHeight', 'fontSize', 'layout',
  'sourceKind', 'textInput', 'textFont', 'palette', 'glyphSet', 'theme',
];

function collectSettings() {
  const values = {
    mode: dom.app.dataset.mode,
    language: currentLocale(),
    keepAspect: dom.keepAspect.checked,
    textBold: dom.textBold.checked,
    colour: dom.colour.checked,
    cellGround: dom.cellGround.checked,
    colourPattern: dom.colourPattern.checked,
    transparent: dom.transparent.checked,
    trimBlank: dom.trimBlank.checked,
    edgeColour: dom.edgeColour.checked,
    evenGrid: dom.evenGrid.checked,
    smooth: smoothScaling,
  };
  for (const id of PERSISTED_FIELDS) values[id] = el(id).value;
  for (const name of PERSISTED_RANGES) values[name] = controls[name].value;
  return values;
}

/**
 * Somewhere to come back from.
 *
 * Three things now rewrite the whole panel in one go -- picking a preset,
 * letting it work out the kind of picture, taking one of the offered variants
 * -- and until this there was no way back from any of them except memory. The
 * stack holds whole settings, not the individual controls that changed, because
 * that is what those actions replace and what applySettings already knows how
 * to put back.
 *
 * It is also how one art is compared against another: step back, look, step
 * forward. That beats a peek-while-held toggle, which would have to show one
 * art while the panel described a different one, and would hand the wrong thing
 * to whoever pressed copy at that moment.
 */
const HISTORY_DEPTH = 30;
const wasBefore = [];
const wasAfter = [];

function syncHistoryButtons() {
  dom.settingsUndo.disabled = wasBefore.length === 0;
  dom.settingsRedo.disabled = wasAfter.length === 0;
}

/**
 * Note where things stand, before something automatic moves them.
 *
 * Called at the places that rewrite several controls at once rather than inside
 * the functions that do the rewriting: detectPreset goes through applyPreset,
 * and remembering in both would put the same state on the stack twice.
 */
function remember() {
  wasBefore.push(collectSettings());
  if (wasBefore.length > HISTORY_DEPTH) wasBefore.shift();
  wasAfter.length = 0;
  syncHistoryButtons();
}

function stepHistory(from, to, message) {
  if (!from.length) return false;
  to.push(collectSettings());
  applySettings(from.pop());
  syncHistoryButtons();
  syncEdgeControls();
  syncPlatform();
  syncRows();
  setStatus(t(message), 'info');
  changed();
  return true;
}

const undoSettings = () => stepHistory(wasBefore, wasAfter, 'settings.undone');
const redoSettings = () => stepHistory(wasAfter, wasBefore, 'settings.redone');

const persist = coalesce(() => {
  const settings = collectSettings();
  saveSettings(settings);
  // replaceState, not pushState: the back button should not fill up with every
  // position a slider passed through.
  updateHash(settings);
});

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
  if (typeof values.edgeColour === 'boolean') dom.edgeColour.checked = values.edgeColour;
  if (typeof values.colour === 'boolean') dom.colour.checked = values.colour;
  if (typeof values.cellGround === 'boolean') dom.cellGround.checked = values.cellGround;
  if (typeof values.colourPattern === 'boolean') dom.colourPattern.checked = values.colourPattern;
  dom.cellGround.disabled = !dom.colour.checked;
  dom.colourPattern.disabled = !dom.colour.checked || !dom.cellGround.checked;
  if (typeof values.transparent === 'boolean') dom.transparent.checked = values.transparent;
  if (typeof values.smooth === 'boolean') smoothScaling = values.smooth;
  if (typeof values.evenGrid === 'boolean') dom.evenGrid.checked = values.evenGrid;
  // Setting a checkbox from code fires no change event, so the view is told.
  if (lattice) lattice.enabled = dom.evenGrid.checked;

  setLayout(dom.layout.value);
  applyTheme();
  dom.presetHint.textContent = hintFor(dom.preset.value);
}

function resetEverything() {
  clearSettings();
  thresholdFromOtsu = false;
  detectedKind = null;
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
  dom.edgeColour.checked = false;
  dom.evenGrid.checked = true;
  if (lattice) lattice.enabled = true;
  dom.colour.checked = false;
  dom.cellGround.checked = false;
  dom.cellGround.disabled = true;
  dom.colourPattern.checked = false;
  dom.colourPattern.disabled = true;
  dom.transparent.checked = false;
  describeDecisions();
  applyTheme();
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

/**
 * A saved work, as opposed to a picture.
 *
 * Some browsers hand a dropped .json a type of application/json, some hand it
 * an empty string, and some guess text/plain; the name is the only thing all of
 * them agree on. Whatever it is, it is read and then judged by its contents --
 * a file that is not ours is refused there, not here.
 */
function firstWork(list) {
  return [...(list ?? [])].find((item) => item
    && (/json/.test(item.type) || /\.json$/i.test(item.name ?? '')));
}

/** Open a dropped or chosen work file, saying so or saying why not. */
async function openWorkFile(file) {
  const work = await unpackWork(await file.text());
  await applyWork(work);
  setStatus(t('works.opened', { name: work.name || file.name }), 'ok');
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
    // A picture is the usual thing to drop here; a saved work is the other one,
    // and dropping it is the same gesture as dropping the picture it holds.
    const dropped = event.dataTransfer?.files;
    const picture = firstImage(dropped);
    if (picture) {
      loadFile(picture);
      return;
    }
    const work = firstWork(dropped);
    if (work) {
      openWorkFile(work).catch(fail);
      return;
    }
    setStatus(t('source.notAnImage'), 'warn');
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
/** What a dropdown calls the value it is set to, in whatever language it is in. */
const optionLabel = (select, value) =>
  [...select.options].find((option) => option.value === value)?.text ?? value;

/**
 * What taking this offer would change, in the words on the panel.
 *
 * A tile shows a picture and a name, and the name says what kind of thing it
 * is, not which controls made it. Naming the differences turns each offer into
 * a small lesson about the panel: the person can see that the one they liked is
 * blue noise with the threshold moved, and go and do that themselves next time.
 *
 * Differences against what is set now, rather than the recipe in full, because
 * the useful question in front of a tile is what would change.
 */
function whatChanges(recipe) {
  const changes = [];
  if (recipe.method !== dom.dither.value) changes.push(optionLabel(dom.dither, recipe.method));
  if (recipe.edge.mode !== dom.edgeMode.value) changes.push(optionLabel(dom.edgeMode, recipe.edge.mode));
  if (recipe.threshold != null && Math.round(recipe.threshold) !== Math.round(controls.threshold.value)) {
    changes.push(`${t('threshold.label')} ${Math.round(recipe.threshold)}`);
  }
  if (recipe.detail !== Math.round(controls.detail.value)) {
    changes.push(`${t('detail.label')} ${recipe.detail}`);
  }
  return changes;
}

/** A recipe writes the same controls a preset does, and nothing else. */
function applyRecipe(recipe) {
  thresholdFromOtsu = false;
  dom.dither.value = recipe.method;
  controls.detail.set(recipe.detail);
  if (recipe.threshold != null) controls.threshold.set(recipe.threshold);
  dom.edgeMode.value = recipe.edge.mode;
  if (recipe.edge.mode !== 'none') {
    controls.edgeAmount.set(Math.round((recipe.edge.amount ?? 1) * 100));
    controls.edgeRadius.set(recipe.edge.radius ?? 1);
    controls.edgeClean.set(Math.round((recipe.edge.clean ?? 0) * 100));
  }
  syncEdgeControls();
}

/**
 * Put the offers on the table.
 *
 * Each tile is a button holding the art itself, because the art is the argument
 * -- a name for a dithering method tells nobody which one suits their picture.
 * Arrows walk the grid and Enter takes one; Escape leaves everything as it was,
 * which is the point of showing them rather than applying the best outright.
 */
function showOffers(offers, { opener, onDismiss } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'inspect offer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('offer.label'));

  const grid = document.createElement('div');
  grid.className = 'offer-grid';

  let taken = false;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (opener instanceof HTMLElement) opener.focus();
    if (!taken) onDismiss?.();
  };

  const tiles = offers.map((offer) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'offer-tile';

    const art = document.createElement('pre');
    // Trimmed here if trimming is on, because the tile is a promise about what
    // choosing it will produce, and trimming happens after the encoder.
    art.textContent = dom.trimBlank.checked ? trimBlank(offer.text) : offer.text;
    art.setAttribute('aria-hidden', 'true');   // the name below says what it is

    const name = document.createElement('span');
    name.className = 'offer-name';
    name.textContent = t(`variant.${offer.key}`);

    const why = document.createElement('span');
    why.className = 'offer-why';
    // Which question the number answers, because two are being asked: a tonal
    // variant is measured against the light and a drawing against the contours,
    // and one percentage standing for either would mean nothing.
    why.textContent = t(offer.judge === 'contour' ? 'offer.matchContour' : 'offer.matchTone',
                        { score: Math.round(offer.score * 100) });

    const changes = whatChanges(offer.recipe);
    const differs = document.createElement('span');
    differs.className = 'offer-why';
    differs.textContent = changes.length
      ? t('offer.differs', { what: changes.slice(0, 3).join(' · ') })
      : t('offer.same');

    tile.append(art, name, why, differs);
    tile.addEventListener('click', () => {
      taken = true;
      remember();
      applyRecipe(offer.recipe);
      close();
      setStatus(t('offer.applied', { name: t(`variant.${offer.key}`) }), 'ok');
      scheduleRender();
    });
    grid.append(tile);
    return tile;
  });

  const hint = document.createElement('p');
  hint.textContent = t('offer.hint');

  const onKey = (event) => {
    if (event.key === 'Escape') { close(); return; }
    const at = tiles.indexOf(document.activeElement);
    if (at < 0) return;
    // Two columns, so left and right step by one and up and down by two.
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[event.key];
    if (!step) return;
    event.preventDefault();
    tiles[Math.min(tiles.length - 1, Math.max(0, at + step))].focus();
  };

  overlay.append(grid, hint);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  fitArt(tiles);
  tiles[0]?.focus();
}

/**
 * Grow each art until it fills its tile.
 *
 * Measured rather than calculated from an assumed character width: the advance
 * of a braille glyph over the line height differs between fonts, and the whole
 * layout already learned once that guessing that ratio produces three numbers
 * that disagree. So the art is laid out at a known size, its real extent is
 * read back, and the size is scaled by whichever of width or height runs out
 * first.
 */
function fitArt(tiles) {
  const PROBE = 10;
  for (const tile of tiles) {
    const art = tile.querySelector('pre');
    art.style.fontSize = `${PROBE}px`;
    const room = art.getBoundingClientRect();
    if (!art.scrollWidth || !art.scrollHeight || !room.width || !room.height) continue;
    const factor = Math.min(room.width / art.scrollWidth, room.height / art.scrollHeight);
    art.style.fontSize = `${Math.max(2, PROBE * factor)}px`;
  }
}

/** Render a spread of recipes, score each against the picture, offer the best. */
async function suggestVariants() {
  if (!source) {
    setStatus(t('status.needImage'), 'warn');
    return;
  }
  const { cols, rows } = resolveGrid();
  const detail = detailSize(cols, rows);
  const target = drawScaled(
    source, detail.w, detail.h, backgroundFor(isInverted()),
    { smooth: smoothScaling, crop: cropRect },
  );

  // Whatever the panel was saying goes back if the offer is declined: the
  // search is not something that happened to the art.
  const before = { text: dom.status.textContent, kind: dom.status.dataset.kind };
  // Noted before the button is disabled, because disabling it takes the focus
  // away: asking afterwards finds the body and the dialog has nowhere to
  // return to.
  const opener = document.activeElement;

  dom.suggest.disabled = true;
  setStatus(t('offer.working', { count: VARIANT_FAMILIES.length * DRAWS_PER_FAMILY }));
  try {
    const offers = await pipeline.variants(
      readImageData(target), readAdjustments(), { ...readOptions(), grid: { cols, rows } }, 4,
      // A fresh draw every press: pressing again is meant to be worth doing.
      (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    );
    dom.suggest.disabled = false;
    showOffers(offers, { opener, onDismiss: () => setStatus(before.text, before.kind) });
  } catch (error) {
    fail(error);
  } finally {
    dom.suggest.disabled = false;
  }
}

function inspect(canvasId) {
  const preview = el(canvasId);
  if (!preview.width || !preview.height) return;

  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'inspect';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('inspect.label'));
  overlay.tabIndex = -1;

  const full = createCanvas(preview.width, preview.height);
  full.getContext('2d').drawImage(preview, 0, 0);
  if (canvasId === 'resCanvas') full.style.imageRendering = 'pixelated';

  const caption = document.createElement('p');
  caption.textContent = t('inspect.close', { w: preview.width, h: preview.height });

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    // Put the caller back where it was, or the next Tab starts from the body.
    if (opener instanceof HTMLElement) opener.focus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  overlay.append(full, caption);
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.focus();
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
  dom.dotHint.textContent = on ? `${t('dots.hint')} ${t('dots.keys')}` : '';
  describeArt();
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
  dom.dotHint.textContent = dotEditor?.isEnabled() ? `${t('dots.hint')} ${t('dots.keys')}` : '';
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
    sketchPad.refresh();
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
  const detail = detailSize(cols, rows);
  const target = drawScaled(
    source, detail.w, detail.h, backgroundFor(isInverted()),
    { smooth: smoothScaling, crop: cropRect },
  );
  const { text } = await pipeline.generate(
    readImageData(target), readAdjustments(), { ...readOptions(), grid: { cols, rows } },
  );
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

/** What to add to "copied", where the text will not carry what is on screen. */
function copyCaveat() {
  if (dom.colour.checked && dom.cellGround.checked && dom.colourPattern.checked) {
    return t('status.copiedMosaic');
  }
  if (glyphSet() === 'octants') return t('status.copiedBlocks');
  return '';
}

async function copyArt() {
  const platform = dom.platform.value;
  const parts = splitForPlatform(written(), platform);

  if (parts.length === 1) {
    await copyText(forPlatform(written(), platform));
    const caveat = copyCaveat();
    setStatus(
      (PLATFORMS[platform].codeBlock ? t('status.copiedFenced') : t('status.copied')) + caveat,
      caveat ? 'warn' : 'ok',
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
    + (oversized ? t('status.partOversized') : '')
    + copyCaveat(),
    oversized || copyCaveat() ? 'warn' : 'ok',
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
let artGround = null;
let artCols = 0;
/**
 * What survives being pasted somewhere as plain text.
 *
 * Colour never does -- not the cell's ink, not its ground -- which is fine for
 * the ordinary art, where the dots carry the picture on their own. It is not
 * fine for the mosaic, where the dots say which of two colours a spot belongs
 * to rather than how bright it is: measured, its coverage varies between cells
 * by 0.18 against 0.28 for the usual art, and on a plain ramp not at all. The
 * blocks travel, but only as far as the reader's font.
 */
function travelsAsText() {
  if (dom.colour.checked && dom.cellGround.checked && dom.colourPattern.checked) {
    return t('decided.travelsMosaic');
  }
  if (glyphSet() === 'octants') return t('decided.travelsBlocks');
  if (dom.colour.checked) return t('decided.travelsTint');
  return t('decided.travelsPlain');
}

/** Braille, or the blocks -- the art itself is braille either way. */
const glyphSet = () => (dom.glyphSet.value === 'octants' ? 'octants' : 'braille');

/** The art as it should be pasted, which is not always how it is stored. */
const written = () => toGlyphs(artText, glyphSet());

/** What the page is actually showing: colour is dropped on a grid too big for it. */
let shownColours = null;
let shownGround = null;
let lattice = null;

function paintArt() {
  paintText();
  // Every path that changes the art ends up here, so this is the one place
  // the drawn copy has to be brought back in step with the typeset one.
  lattice?.redraw();
}

function paintText() {
  const lines = artText.split('\n');

  if (!artColours || artCols === 0) {
    shownColours = null;
    shownGround = null;
    dom.output.textContent = written();
    return;
  }
  if (lines.length * artCols > COLOUR_CELL_LIMIT) {
    shownColours = null;
    shownGround = null;
    dom.output.textContent = written();
    setStatus(t('colour.tooLarge'), 'warn');
    return;
  }
  shownColours = artColours;
  shownGround = artGround;

  // Only braille glyphs and the markup built here ever reach innerHTML.
  const kind = glyphSet();
  dom.output.innerHTML = lines
    .map((line, row) => {
      // Sliced as cells, not as characters: an octant can be two UTF-16 units
      // wide, and the colour runs are counted in cells.
      const cells = cellsOf(line, kind);
      return colourRuns(artColours, row, artCols, 8, artGround)
        .map(({ start, end, index }) => {
          const paint = artGround
            ? `color:${cellHex(artColours, index)};background:${cellHex(artGround, index)}`
            : `color:${cellHex(artColours, index)}`;
          return `<span style="${paint}">${cells.slice(start, end).join('')}</span>`;
        })
        .join('');
    })
    .join('\n');
}

/** Everything the colour-aware exports need, in one place. */
/**
 * Fill in the "what was worked out" list.
 *
 * Present tense throughout: this describes the state the art is in, not a log
 * of how it got there. Anything the app did not decide for itself says so
 * plainly rather than being left out, because a missing line reads as a bug.
 */
function describeDecisions() {
  const rows = [];
  const add = (term, detail) => rows.push([t(term), detail]);

  add('decided.kind', detectedKind
    ? t('decided.kindAuto', { kind: t(`preset.${detectedKind}`) })
    : t('decided.kindChosen'));

  const threshold = Math.round(controls.threshold.value);
  add('decided.threshold', thresholdFromOtsu
    ? t('decided.thresholdOtsu', { value: threshold })
    : t('decided.thresholdHand', { value: threshold }));

  if (lastSampling) add('decided.sampling', t('decided.samplingFrom', lastSampling));

  add('decided.redraw', lastRender
    ? t(following ? 'decided.redrawLive' : 'decided.redrawButton', { ms: Math.round(lastRender.ms) })
    : t('decided.redrawNone'));

  add('decided.version', APP_VERSION);

  // What copying as text will and will not carry. The panel is where the app
  // says what state it is in, and this is a state worth saying out loud: the
  // mosaic is a picture rather than a text, and the blocks need a font at the
  // other end. Both are easy to copy into a chat and be disappointed by.
  add('decided.travels', travelsAsText());

  const cleaning = Math.round(controls.edgeClean.value);
  add('decided.cleanup', dom.edgeMode.value === 'none'
    ? t('decided.cleanupNoEdges')
    : (cleaning > 0 ? t('decided.cleanupOn', { value: cleaning }) : t('decided.cleanupOff')));

  dom.decidedList.replaceChildren(...rows.flatMap(([term, detail]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = detail;
    return [dt, dd];
  }));
}

function exportStyle() {
  const style = getComputedStyle(dom.output);
  const { fontFamily, fontSize, lineHeight, advancePx, lineHeightPx } = outputMetrics();
  return {
    fontFamily,
    fontSize,
    lineHeight,
    // The cell as the page has it, for the exporter that draws its own dots.
    advancePx,
    lineHeightPx,
    foreground: style.color,
    // 'transparent' is a colour as far as a canvas fill is concerned: it paints
    // nothing, which is exactly what is wanted.
    background: dom.transparent.checked ? 'transparent' : style.backgroundColor,
    colours: artColours,
    ground: artGround,
    // Which characters the art is written in, and therefore whether the drawn
    // copy shows dots or solid quarters.
    glyphs: glyphSet(),
    fill: glyphSet() === 'octants' ? 'blocks' : 'dots',
  };
}

function init() {
  controls.threshold = bindRange(el('threshold'), el('thresholdVal'), {
    // Moved by hand, so it is no longer Otsu's answer. set() does not come
    // through here, which is what makes the flag reliable.
    onChange: () => { thresholdFromOtsu = false; changed({ affectsPreview: false }); },
  });
  controls.brightness = bindRange(el('brightness'), el('brightnessVal'), { onChange: changed });
  controls.contrast = bindRange(el('contrast'), el('contrastVal'), { onChange: changed });
  controls.saturation = bindRange(el('saturation'), el('saturationVal'), { onChange: changed });
  controls.sharpness = bindRange(el('sharpness'), el('sharpnessVal'), { decimals: 1, onChange: changed });
  controls.detail = bindRange(el('detail'), el('detailVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.edgeAmount = bindRange(el('edgeAmount'), el('edgeAmountVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.edgeRadius = bindRange(el('edgeRadius'), el('edgeRadiusVal'), { decimals: 1, onChange: () => changed({ affectsPreview: false }) });
  controls.edgeClean = bindRange(el('edgeClean'), el('edgeCleanVal'), { onChange: () => changed({ affectsPreview: false }) });
  controls.emphasis = bindRange(el('emphasis'), el('emphasisVal'), { onChange: () => changed({ affectsPreview: false }) });

  controls.calibratedScale = bindRange(el('calibratedScale'), el('calibratedScaleVal'), { decimals: 2 });

  // A stored choice beats the browser's preference. applyTranslations runs for
  // the first time here, before anything is listening for changes.
  // A link is a deliberate act, so it outranks whatever this browser had saved.
  const fromLink = fromHash(window.location.hash);
  const stored = loadSettings();
  const opening = { ...stored, ...fromLink };
  linkOpened = Object.keys(fromLink).length > 0;

  initLocale(opening.language ?? preferredLocale());
  onLocaleChange(() => { retranslate(); describeDecisions(); describeArt(); });

  fillLanguages();
  fillPresets();
  fillPlatforms();
  fillFonts();

  dom.language.addEventListener('change', () => {
    setLocale(dom.language.value);
    persist();
  });

  applySettings(opening);
  syncEmphasis();
  describeDecisions();
  describeArt();
  // A link sets the panel, and the panel is a thing this app remembers. Leaving
  // it unsaved would show one state and store another, and the next plain visit
  // would silently undo what the link asked for.
  if (linkOpened) persist();

  dom.sourceKind.addEventListener('change', () => {
    setSourceKind(dom.sourceKind.value);
    persist();
  });
  camera = createCamera(dom.camera);
  sketchPad = createSketchPad(dom.drawCanvas, () => {
    // The pad is the source, so every stroke invalidates what was sampled.
    previewReady = false;
    scheduleSketch();
  }, dom.padCursor);

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

  dom.suggest.addEventListener('click', () => { suggestVariants(); });
  // The palette rewrites the colours the art is tinted with, so it needs the
  // encoder again; a transparent background only changes what export paints.
  dom.palette.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.transparent.addEventListener('change', persist);
  dom.settingsUndo.addEventListener('click', undoSettings);
  dom.settingsRedo.addEventListener('click', redoSettings);
  dom.preset.addEventListener('change', () => {
    remember();
    if (dom.preset.value === AUTO_PRESET) {
      detectPreset();
    } else {
      detectedKind = null;
      applyPreset(dom.preset.value);
    }
    describeDecisions();
  });
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

  // The second colour means nothing without the first, so the box follows it.
  const syncColour = () => {
    dom.cellGround.disabled = !dom.colour.checked;
    // Choosing dots by colour needs somewhere to put the second colour.
    dom.colourPattern.disabled = !dom.colour.checked || !dom.cellGround.checked;
  };
  dom.colour.addEventListener('change', () => {
    syncColour();
    changed({ affectsPreview: false });
  });
  dom.cellGround.addEventListener('change', () => {
    syncColour();
    changed({ affectsPreview: false });
  });
  dom.colourPattern.addEventListener('change', () => changed({ affectsPreview: false }));
  syncColour();

  dom.downloadHtml.addEventListener('click', () => {
    if (!requireArt()) return;
    downloadHtml(brailleToHtml(artText, artColours, artCols, exportStyle()), 'braille.html');
    setStatus(artColours ? t('status.htmlSavedColour') : t('status.htmlSaved'), 'ok');
  });

  dom.downloadAnsi.addEventListener('click', () => {
    if (!requireArt()) return;
    downloadText(
      brailleToAnsi(artText, artColours, artCols, dom.palette.value, artGround, glyphSet()),
      'braille.ans',
    );
    setStatus(
      artColours
        ? t('status.ansiSaved')
        : t('status.ansiNoColour'),
      'ok',
    );
  });

  dom.modeSimple.addEventListener('click', () => { setMode('simple'); persist(); });
  dom.modeAdvanced.addEventListener('click', () => { setMode('advanced'); persist(); });
  dom.resetAll.addEventListener('click', () => { remember(); resetEverything(); });
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
    if (on) setStatus(`${t('crop.prompt')} ${t('crop.keys')}`, 'info');
  });

  dom.cropReset.addEventListener('click', () => cropper.reset());
  dom.trimBlank.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.edgeColour.addEventListener('change', () => changed({ affectsPreview: false }));
  dom.fitLimit.addEventListener('click', () => { fitToLimit().catch(fail); });

  // Offering the blocks where the font has none would put empty boxes in
  // someone's picture, so the page checks before offering them.
  const blocksDrawn = canDraw(0x1CD00, getComputedStyle(dom.output).fontFamily);
  if (!blocksDrawn) {
    dom.glyphSet.querySelector('option[value="octants"]').disabled = true;
    if (dom.glyphSet.value === 'octants') dom.glyphSet.value = 'braille';
  }
  const syncGlyphs = () => {
    dom.glyphHint.textContent = blocksDrawn
      ? (glyphSet() === 'octants' ? t('display.glyphs.hint') : '')
      : t('display.glyphs.missing');
    // Editing counts dots in a braille cell; the blocks are a way of writing
    // the art out, not something to edit in.
    dom.dotEdit.disabled = glyphSet() === 'octants';
    if (glyphSet() === 'octants' && dotEditor?.isEnabled()) setEditing(false);
  };
  dom.glyphSet.addEventListener('change', () => {
    syncGlyphs();
    persist();
    paintArt();
    updateMeta(artText);
  });

  lattice = createLatticeView(dom.lattice, dom.output, {
    metrics: outputMetrics,
    getArt: () => ({
      text: artText,
      colours: shownColours,
      ground: shownGround,
      cols: artCols,
      fill: glyphSet() === 'octants' ? 'blocks' : 'dots',
    }),
  });
  lattice.enabled = dom.evenGrid.checked;
  dom.evenGrid.addEventListener('change', () => {
    lattice.enabled = dom.evenGrid.checked;
    persist();
  });

  dotEditor = createDotEditor(dom.output, {
    metrics: outputMetrics,
    getText: () => artText,
    setText: replaceArt,
    cursor: dom.dotCursor,
  });

  dom.dotEdit.addEventListener('click', () => {
    if (!requireArt()) return;
    setEditing(!dotEditor.isEnabled());
  });

  dom.dotUndo.addEventListener('click', () => {
    if (dotEditor.undo()) setStatus(t('dots.undone'), 'info');
  });

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();

    // Recalculate, and copy. Shift on the copy so the plain chord goes on
    // meaning what it means everywhere else -- taking that would be rude, and
    // would break copying out of the lettering box.
    if (key === 'enter') {
      event.preventDefault();
      dom.generate.click();
      return;
    }
    if (key === 'c' && event.shiftKey) {
      event.preventDefault();
      dom.copy.click();
      return;
    }

    if (key !== 'z' && key !== 'y') return;

    // While dots are being edited the same chord means the dots, which is what
    // the hand is on. The panel's history waits its turn.
    if (dotEditor.isEnabled() && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      if (dotEditor.undo()) setStatus(t('dots.undone'), 'info');
      return;
    }

    const forward = key === 'y' || event.shiftKey;
    if (forward ? redoSettings() : undoSettings()) event.preventDefault();
  });

  for (const shot of document.querySelectorAll('[data-inspect]')) {
    shot.addEventListener('click', () => {
      // While a selection is being dragged, a click means crop, not zoom.
      if (cropper.isActive() && shot.dataset.inspect === 'srcCanvas') return;
      inspect(shot.dataset.inspect);
    });
    shot.addEventListener('keydown', (event) => {
      // Only when the figure itself has focus. Enter and Space belong to
      // whatever is inside it -- the sketch pad uses Enter for the pen -- and
      // acting on a bubbled key opened the enlarged view behind the drawing.
      if (event.target !== shot) return;
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
  dom.dither.addEventListener('change', () => { syncEmphasis(); changed({ affectsPreview: false }); });
  dom.edgeMode.addEventListener('change', () => {
    syncEdgeControls();
    changed({ affectsPreview: false });
  });
  dom.invert.addEventListener('change', () => changed());
  dom.theme.addEventListener('change', () => {
    applyTheme();
    persist();
  });
  dom.fontSize.addEventListener('input', () => {
    applyFontSize();
    syncRows();
  });

  dom.autoThreshold.addEventListener('click', () => { remember(); autoThreshold().catch(fail); });
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

  dom.copyLink.addEventListener('click', async () => {
    const settings = collectSettings();
    try {
      await copyText(shareUrl(settings));
      setStatus(textFits(settings) ? t('status.linkCopied') : t('status.linkNoText'), 'ok');
    } catch (error) {
      fail(error);
    }
  });

  dom.downloadTxt.addEventListener('click', () => {
    if (!requireArt()) return;
    downloadText(written(), 'braille.txt');
    // A file of text carries no more colour than a paste does.
    const caveat = copyCaveat();
    if (caveat) setStatus(t('status.savedText') + caveat, 'warn');
  });

  dom.copyImage.addEventListener('click', async () => {
    if (!requireArt()) return;
    try {
      const { canvas } = renderDotsToCanvas(artText, exportStyle());
      await copyCanvas(canvas);
      setStatus(t('status.copiedImage'), 'ok');
    } catch (error) {
      fail(error);
    }
  });

  // On a phone the chat is not on the clipboard, it is behind the share sheet.
  // A browser without one is not shown a button it could never answer.
  dom.workSave.addEventListener('click', () => {
    if (!requireArt()) return;
    (async () => {
      const work = await currentWork();
      await saveWork(work);
      dom.worksPanel.open = true;
      await refreshWorks();
      setStatus(t('works.saved', { name: work.name }), 'ok');
    })().catch(fail);
  });

  dom.styleSave.addEventListener('click', () => {
    (async () => {
      const style = currentStyle();
      await saveWork(style);
      dom.worksPanel.open = true;
      await refreshWorks();
      setStatus(t('works.savedStyle', { name: style.name }), 'ok');
    })().catch(fail);
  });

  dom.workExport.addEventListener('click', () => {
    if (!requireArt()) return;
    (async () => {
      const work = await currentWork();
      downloadText(await packWork(work), `${work.name.replace(/[^\p{L}\p{N} _-]/gu, '') || 'work'}.braille.json`);
      setStatus(t('works.saved', { name: work.name }), 'ok');
    })().catch(fail);
  });

  // The picker is the button; the input itself is only how the browser asks.
  dom.workImport.addEventListener('click', () => dom.workFile.click());
  dom.workFile.addEventListener('change', () => {
    const file = dom.workFile.files?.[0];
    if (!file) return;
    openWorkFile(file).catch(fail).finally(() => { dom.workFile.value = ''; });
  });

  refreshWorks().catch(() => { /* the panel says so itself */ });

  dom.share.hidden = !canShare();
  dom.share.addEventListener('click', async () => {
    if (!requireArt()) return;
    try {
      const { canvas } = renderDotsToCanvas(artText, exportStyle());
      const went = await shareArt(canvas, artText, {
        filename: 'braille.png',
        title: t('share.title'),
      });
      const said = { picture: 'status.shared', text: 'status.sharedText', cancelled: 'status.shareCancelled' };
      setStatus(t(said[went]), went === 'cancelled' ? 'info' : 'ok');
    } catch (error) {
      fail(error);
    }
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
    const { canvas, scale } = renderDotsToCanvas(artText, exportStyle());
    downloadCanvas(canvas, 'braille.png');
    setStatus(
      scale < 1
        ? t('status.pngScaled', { percent: Math.round(scale * 100) })
        : t('status.pngSaved'),
      scale < 1 ? 'warn' : 'ok',
    );
  });

  applyFontSize();
  applyTheme();
  syncGlyphs();
  syncEdgeControls();
  syncPlatform();
  syncRows();
  if (dom.sourceKind.value === 'text') setSourceKind('text');
  else dom.app.dataset.source = 'image';
  if (linkOpened) {
    setStatus(t('status.linkApplied'), 'ok');
    return;
  }
  setStatus(
    pipeline.offThread
      ? t('status.start')
      : t('status.startInline'),
  );
}

init();
