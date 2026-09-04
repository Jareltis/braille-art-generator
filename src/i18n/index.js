// SPDX-License-Identifier: GPL-3.0-or-later
// Translation.
//
// Adding a language is one file next to this one and one line in LOCALES.
// Nothing else in the project holds a user-visible string: the markup carries
// keys in data-i18n attributes, and the code asks t() for everything it says.

import { ru } from './ru.js';
import { en } from './en.js';

export const LOCALES = Object.freeze({ ru, en });
export const FALLBACK = 'en';

let current = FALLBACK;
const listeners = new Set();

const locale = () => LOCALES[current] ?? LOCALES[FALLBACK];

/**
 * Pick the plural form.
 *
 * Not a count of one against everything else: Russian needs one, few and many
 * (1 знак, 2 знака, 5 знаков), Polish and Arabic more still. Intl knows the
 * rules for every language, so a dictionary only has to supply the forms its
 * own language actually uses.
 */
function plural(forms, count) {
  if (typeof forms === 'string') return forms;
  const category = new Intl.PluralRules(locale().tag).select(count ?? 0);
  return forms[category] ?? forms.other ?? Object.values(forms)[0] ?? '';
}

/** Numbers belong to the language too: 1 234 here, 1,234 there. */
export const formatNumber = (value) => Number(value).toLocaleString(locale().tag);

/**
 * {name} inserts a value as it is; {#name} groups it as a number.
 *
 * The distinction matters: 1234 characters should read as 1,234, but a frame
 * 1280 pixels wide should not read as 1,280.
 */
function fill(template, params) {
  return template.replace(/\{(#?)(\w+)\}/g, (whole, asNumber, name) => {
    if (!(name in params)) return whole;
    return asNumber ? formatNumber(params[name]) : String(params[name]);
  });
}

/**
 * A phrase, by key.
 *
 * A missing key falls back to the reference language and then to the key
 * itself, which shows up in the interface as obviously wrong rather than as a
 * blank -- a gap should be visible, not silent.
 */
export function t(key, params = {}) {
  const entry = locale().strings[key] ?? LOCALES[FALLBACK].strings[key];
  if (entry === undefined) return key;
  return fill(plural(entry, params.count), params);
}

/** Elements carry keys; this puts the words into them. */
export function applyTranslations(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of root.querySelectorAll('[data-i18n-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  }
  // Two phrases live in the stylesheet, where a key cannot reach them.
  const style = document.documentElement.style;
  style.setProperty('--empty-art', JSON.stringify(t('art.empty')));
  style.setProperty('--drop-hint', JSON.stringify(t('drop.hint')));
}

export const currentLocale = () => current;
export const localeTag = () => locale().tag;

export function setLocale(code) {
  const next = code in LOCALES ? code : FALLBACK;
  if (next === current) return;
  current = next;
  document.documentElement.lang = locale().tag;
  applyTranslations();
  for (const listener of listeners) listener(next);
}

/** Called after every change, for the strings that live in code rather than markup. */
export function onLocaleChange(listener) {
  listeners.add(listener);
}

/**
 * What the visitor most likely reads, from the browser's own preference order.
 * A stored choice always wins over this; it is only the first guess.
 */
export function preferredLocale() {
  for (const tag of navigator.languages ?? [navigator.language ?? '']) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (code in LOCALES) return code;
  }
  return FALLBACK;
}

/** Set without notifying: for the first application, before anything is listening. */
export function initLocale(code) {
  current = code in LOCALES ? code : FALLBACK;
  document.documentElement.lang = locale().tag;
  applyTranslations();
  return current;
}
