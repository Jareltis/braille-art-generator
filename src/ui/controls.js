// SPDX-License-Identifier: GPL-3.0-or-later
// Input plumbing. Everything that used to be duplicated between index.html's
// inline script and the generator lives here, once.

/**
 * Wraps `fn` so it runs at most once per animation frame.
 *
 * The adjustment sliders used to run a full pixel pass plus a convolution on
 * every `input` event, which froze the tab while dragging.
 */
export function coalesce(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

export function clampInt(raw, lo, hi, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Keeps a range input, its numeric readout and the app in sync.
 * Returns a handle whose `value` is already parsed.
 */
export function bindRange(input, readout, { decimals = 0, onChange } = {}) {
  const format = (v) => Number.parseFloat(v).toFixed(decimals);
  const sync = () => { readout.textContent = format(input.value); };

  sync();
  input.addEventListener('input', () => {
    sync();
    onChange?.();
  });

  return {
    input,
    get value() { return Number.parseFloat(input.value); },
    reset() {
      input.value = input.defaultValue;
      sync();
    },
  };
}
