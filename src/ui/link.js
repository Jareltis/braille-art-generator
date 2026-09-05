// SPDX-License-Identifier: GPL-3.0-or-later
// Settings in a link.
//
// The recipe travels; the picture does not. Everything here fits in a URL
// fragment, and a fragment is never sent to the server -- which for a static
// site means a shared link discloses nothing to the host.
//
// Keys are short but readable on purpose. Someone should be able to look at a
// link, see that w=120 is the width, and change it without tooling.

const KEYS = Object.freeze({
  mode: 'm',
  layout: 'l',
  language: 'lang',
  sourceKind: 'src',
  preset: 'p',
  platform: 'pf',
  dither: 'd',
  invert: 'inv',
  edgeMode: 'e',
  outWidth: 'w',
  outHeight: 'h',
  fontSize: 'fs',
  threshold: 't',
  detail: 'dt',
  brightness: 'b',
  contrast: 'c',
  saturation: 'sa',
  sharpness: 'sh',
  edgeAmount: 'ea',
  edgeRadius: 'er',
  edgeClean: 'ec',
  edgeColour: 'eco',
  emphasis: 'em',
  keepAspect: 'ka',
  trimBlank: 'tr',
  evenGrid: 'eg',
  colour: 'col',
  palette: 'pal',
  transparent: 'tr0',
  smooth: 'sm',
  textBold: 'tb',
  textFont: 'tf',
  textInput: 'txt',
});

const NAMES = Object.freeze(Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [key, name])));

/** Written as 1 and 0, and read back as booleans rather than as those strings. */
const BOOLEAN = new Set(['keepAspect', 'trimBlank', 'colour', 'smooth', 'textBold', 'transparent', 'evenGrid', 'edgeColour']);

/** Lettering long enough to make the link useless is left out of it. */
const TEXT_LIMIT = 400;

export function toHash(settings) {
  const parts = [];
  for (const [name, key] of Object.entries(KEYS)) {
    const value = settings[name];
    if (value === undefined || value === null || value === '') continue;
    if (name === 'textInput' && String(value).length > TEXT_LIMIT) continue;
    const encoded = BOOLEAN.has(name) ? (value ? '1' : '0') : String(value);
    parts.push(`${key}=${encodeURIComponent(encoded)}`);
  }
  return parts.join('&');
}

/**
 * Read a fragment back into settings.
 *
 * Unknown keys are ignored rather than rejected: a link written by a later
 * version should still work here, minus whatever this version cannot do.
 */
export function fromHash(hash) {
  const settings = {};
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text) return settings;

  for (const pair of text.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const name = NAMES[pair.slice(0, at)];
    if (!name) continue;

    let value;
    try {
      value = decodeURIComponent(pair.slice(at + 1));
    } catch {
      continue; // a malformed escape is not worth failing the whole link over
    }
    settings[name] = BOOLEAN.has(name) ? value === '1' : value;
  }
  return settings;
}

/** Whether the lettering had to be dropped, so the caller can say so. */
export const textFits = (settings) => String(settings.textInput ?? '').length <= TEXT_LIMIT;

export function shareUrl(settings) {
  const url = new URL(window.location.href);
  url.hash = toHash(settings);
  return url.toString();
}

/**
 * Keep the address bar in step, without filling the back button with every
 * slider position.
 */
export function updateHash(settings) {
  const hash = toHash(settings);
  const url = new URL(window.location.href);
  if (url.hash.replace(/^#/, '') === hash) return;
  url.hash = hash;
  window.history.replaceState(null, '', url);
}
