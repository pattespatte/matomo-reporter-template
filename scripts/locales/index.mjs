// Locale loader for the report dictionaries in this directory. Swedish
// (sv.mjs) is the reference: its key set defines what a complete translation
// has, and any missing key in another locale falls back to the Swedish text
// (with a one-time warning) so an incomplete translation degrades gracefully
// instead of rendering dictionary keys. setLocale() switches the active
// locale; report-common.mjs's useLocale() calls it together with the
// Intl formatters. Zero dependencies.

import sv from './sv.mjs';
import en from './en.mjs';
import fr from './fr.mjs';
import de from './de.mjs';
import es from './es.mjs';

export const SUPPORTED_LANGUAGES = ['en', 'fr', 'de', 'es', 'sv'];

const catalog = { sv, en, fr, de, es };
const reference = sv;

// Dotted key paths of every string in a dictionary - the shape the
// completeness check and test/check-translations.mjs compare on.
export const flatKeys = (strings, prefix = '') =>
  Object.entries(strings).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flatKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

export const interpolate = (template, vars = {}) =>
  template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));

// Current locale; defaults to Swedish so helpers work (with sv output)
// even before useLocale() runs.
let current = sv;

// Warn once per locale and key - repeated reports must not spam stderr.
const warned = new Set();

export function setLocale(code) {
  const dict = catalog[code];
  if (!dict) throw new Error(`unknown locale code: ${code}`);
  current = dict;
  const have = new Set(flatKeys(dict.strings));
  for (const key of flatKeys(reference.strings)) {
    if (!have.has(key) && !warned.has(`${code}:${key}`)) {
      warned.add(`${code}:${key}`);
      console.error(`WARNING: language ${code} is missing the text "${key}" - the Swedish text is used there`);
    }
  }
}

export const localeMeta = () => current;
export const locales = () => catalog;

export const tr = (key, vars) => {
  const template = Object.prototype.hasOwnProperty.call(current.strings, key)
    ? current.strings[key]
    : reference.strings[key] ?? key;
  return vars === undefined ? template : interpolate(template, vars);
};

// Label maps translate raw values coming from Matomo data (device types,
// theme values, referrer types). Keys are lowercase; lookup normalizes.
// Unmapped values pass through as-is, matching the old per-map behavior.
export const mapLabel = (mapName, raw, fallback) => {
  const map = current.maps?.[mapName];
  if (!map) return fallback ?? String(raw ?? '');
  const key = String(raw ?? '').toLowerCase().trim();
  return map[key] ?? fallback ?? String(raw ?? '');
};
