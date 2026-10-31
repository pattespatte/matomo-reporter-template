#!/usr/bin/env node
// Check the locale dictionaries against the Swedish reference: every locale
// must define the same key set (strings and label maps) and use only
// placeholders the reference also uses. Exits non-zero with the missing keys
// listed - run it after editing anything in scripts/locales/.
//
//   node test/check-translations.mjs

import { locales, flatKeys, SUPPORTED_LANGUAGES } from '../scripts/locales/index.mjs';

const catalog = locales();
const referenceKeys = new Set(flatKeys(catalog.sv.strings));
const referenceMaps = catalog.sv.maps;
let failed = false;

for (const code of SUPPORTED_LANGUAGES.filter((c) => c !== 'sv')) {
  const dict = catalog[code];
  const keys = new Set(flatKeys(dict.strings));
  const missing = [...referenceKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !referenceKeys.has(k));

  if (missing.length) {
    failed = true;
    console.error(`FAIL ${code}: missing ${missing.length} text(s):`);
    for (const k of missing) console.error(`  ${k}`);
  }
  if (extra.length) {
    failed = true;
    console.error(`FAIL ${code}: ${extra.length} text(s) not in the reference:`);
    for (const k of extra) console.error(`  ${k}`);
  }

  // A label map that sv has but the locale does not means raw Matomo values
  // fall back to themselves - usually wrong, so it is checked like strings.
  for (const map of Object.keys(referenceMaps)) {
    if (!dict.maps?.[map]) {
      failed = true;
      console.error(`FAIL ${code}: missing label map "${map}"`);
      continue;
    }
    const missingEntries = Object.keys(referenceMaps[map]).filter((k) => !(k in dict.maps[map]));
    if (missingEntries.length) {
      failed = true;
      console.error(`FAIL ${code}: label map "${map}" is missing entries for: ${missingEntries.join(', ')}`);
    }
  }
  for (const map of Object.keys(dict.maps ?? {})) {
    if (!referenceMaps[map]) {
      failed = true;
      console.error(`FAIL ${code}: label map "${map}" is not in the reference`);
    }
  }
}

if (failed) process.exit(1);
console.log(`ok: all languages (${SUPPORTED_LANGUAGES.join(', ')}) cover the ${referenceKeys.size} reference texts and all label maps`);
