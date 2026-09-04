// SPDX-License-Identifier: GPL-3.0-or-later
// Remembering how the panel was left.
//
// One key holding one object: the settings are only ever read and written as a
// whole, and a single malformed blob is easier to discard than a scattering of
// half-updated keys.

const KEY = 'braille-art.settings';

/** Never throws and never returns anything but an object. */
export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    // Blocked site data, private mode, or a blob written by an older version.
    return {};
  }
}

export function saveSettings(values) {
  try {
    localStorage.setItem(KEY, JSON.stringify(values));
    return true;
  } catch {
    return false;
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing was stored anyway */
  }
}
