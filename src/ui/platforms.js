// SPDX-License-Identifier: GPL-3.0-or-later
// Where the art is going, and what that place will accept.

const STORE_PREFIX = 'braille-art.platform.';

/**
 * Only checkable facts live here.
 *
 * A message length limit is documented and verifiable. The width a client wraps
 * at is not: it moves with the device, the window, the zoom, the font size in
 * that client's own settings and whether the art sits in a code block. Numbers
 * like "Discord is about 30 wide" look authoritative and are worth nothing, so
 * width is measured by the person sending the art and remembered per platform
 * rather than guessed on their behalf.
 */
export const PLATFORMS = Object.freeze({
  none: { label: 'Никуда конкретно', limit: Infinity, codeBlock: false },
  discord: { label: 'Discord', limit: 2000, codeBlock: true },
  telegram: { label: 'Telegram', limit: 4096, codeBlock: true },
  other: { label: 'Другой чат', limit: Infinity, codeBlock: true },
});

// Private browsing and blocked site data both throw here rather than returning
// nothing, so every access is guarded and simply falls back to "not calibrated".
function read(key) {
  try {
    return localStorage.getItem(STORE_PREFIX + key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(STORE_PREFIX + key, String(value));
    return true;
  } catch {
    return false;
  }
}

/** Remembered measurements, or nulls when the platform has never been measured. */
export function calibrationOf(platform) {
  const width = Number(read(`${platform}.width`));
  const scale = Number(read(`${platform}.scale`));
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

export function saveCalibration(platform, { width, scale }) {
  if (width != null) write(`${platform}.width`, Math.round(width));
  if (scale != null) write(`${platform}.scale`, scale);
}

export function clearCalibration(platform) {
  try {
    localStorage.removeItem(`${STORE_PREFIX}${platform}.width`);
    localStorage.removeItem(`${STORE_PREFIX}${platform}.scale`);
  } catch { /* nothing stored anyway */ }
}

const FENCE = '```';

/** How many characters the art costs once wrapped for the target. */
export function messageLength(text, platform) {
  const wrapper = PLATFORMS[platform]?.codeBlock ? FENCE.length * 2 + 2 : 0;
  return text.length + wrapper;
}

/** The art as it should actually be pasted. */
export function forPlatform(text, platform) {
  return PLATFORMS[platform]?.codeBlock ? `${FENCE}\n${text}\n${FENCE}` : text;
}

const MARK_TEN = '\u28FF';  // full cell, every tenth
const MARK_FIVE = '\u2836'; // half cell, every fifth
const MARK_ONE = '\u2804';  // single dot

/**
 * A ruler built from braille cells rather than digits.
 *
 * The measurement wanted is how many *braille* glyphs fit before the client
 * wraps, and in a proportional or fallback font a digit is a different width
 * from U+28xx. Measuring with the wrong glyph would give the wrong answer.
 */
export function ruler(cells = 160) {
  let out = '';
  for (let i = 0; i < cells; i++) {
    out += i % 10 === 0 ? MARK_TEN : i % 5 === 0 ? MARK_FIVE : MARK_ONE;
  }
  return out;
}
