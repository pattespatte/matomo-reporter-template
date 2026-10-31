// Load and validate settings.json (repo root): the global user settings for
// every report. Missing file or missing keys fall back to the built-in
// defaults; values with a fixed set (language, pdf.paper) are validated hard -
// a silently ignored typo would change every report without anyone noticing.
// Invalid JSON likewise. Zero dependencies: JSON.parse only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGES } from './locales/index.mjs';

export const PAPERS = ['A4', 'Letter'];

const TOP_ROW_DEFAULTS = {
  pages: 15,
  entryPages: 5,
  exitPages: 8,
  sections: 10,
  regions: 8,
  resolutions: 8,
  browsers: 8,
  browserVersions: 8,
  operatingSystems: 6,
  osVersions: 6,
  languages: 5,
};

export const defaultSettings = () => ({
  language: 'sv',
  paper: 'A4',
  topRows: { ...TOP_ROW_DEFAULTS },
  organization: '',
});

const fail = (message) => {
  console.error(`settings.json: ${message}`);
  process.exit(1);
};

// Validate one topRows entry: whole numbers of 1 and up only, so a stray
// string or 0 cannot quietly empty a table.
const readTopRow = (raw, key, errors) => {
  if (raw === undefined) return TOP_ROW_DEFAULTS[key];
  if (!Number.isInteger(raw) || raw < 1) {
    errors.push(`topRows.${key} must be an integer of 1 or more (got ${JSON.stringify(raw)})`);
    return TOP_ROW_DEFAULTS[key];
  }
  return raw;
};

// Parse settings text into a resolved settings object. Throws with a plain
// message on anything a user must fix; unknown keys only warn on stderr.
export function parseSettings(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON (${err.message})`);
  }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') {
    throw new Error('must be a JSON object');
  }

  const unknown = Object.keys(raw).filter((k) => !['language', 'pdf', 'topRows', 'footer'].includes(k));
  if (unknown.length) console.error(`WARNING: settings.json: unknown key(s) ${unknown.join(', ')} - ignored`);

  const errors = [];
  const settings = defaultSettings();

  if (raw.language !== undefined) {
    if (!SUPPORTED_LANGUAGES.includes(raw.language)) {
      fail(`language must be one of: ${SUPPORTED_LANGUAGES.join(' | ')} (got ${JSON.stringify(raw.language)})`);
    }
    settings.language = raw.language;
  }

  if (raw.pdf !== undefined) {
    if (raw.pdf === null || typeof raw.pdf !== 'object' || Array.isArray(raw.pdf)) {
      errors.push('pdf must be an object');
    } else {
      const pdfUnknown = Object.keys(raw.pdf).filter((k) => k !== 'paper');
      if (pdfUnknown.length) console.error(`WARNING: settings.json: unknown key(s) pdf.${pdfUnknown.join(', pdf.')} - ignored`);
      if (raw.pdf.paper !== undefined) {
        if (!PAPERS.includes(raw.pdf.paper)) {
          errors.push(`pdf.paper must be one of: ${PAPERS.join(' | ')} (got ${JSON.stringify(raw.pdf.paper)})`);
        } else {
          settings.paper = raw.pdf.paper;
        }
      }
    }
  }

  if (raw.topRows !== undefined) {
    if (raw.topRows === null || typeof raw.topRows !== 'object' || Array.isArray(raw.topRows)) {
      errors.push('topRows must be an object');
    } else {
      const unknownRows = Object.keys(raw.topRows).filter((k) => !(k in TOP_ROW_DEFAULTS));
      if (unknownRows.length) {
        console.error(`WARNING: settings.json: unknown key(s) topRows.${unknownRows.join(', topRows.')} - ignored`);
      }
      for (const key of Object.keys(TOP_ROW_DEFAULTS)) {
        settings.topRows[key] = readTopRow(raw.topRows[key], key, errors);
      }
    }
  }

  if (raw.footer !== undefined) {
    if (raw.footer === null || typeof raw.footer !== 'object' || Array.isArray(raw.footer)) {
      errors.push('footer must be an object');
    } else {
      const footerUnknown = Object.keys(raw.footer).filter((k) => k !== 'organization');
      if (footerUnknown.length) console.error(`WARNING: settings.json: unknown key(s) footer.${footerUnknown.join(', footer.')} - ignored`);
      if (raw.footer.organization !== undefined) {
        if (typeof raw.footer.organization !== 'string') {
          errors.push('footer.organization must be a string');
        } else {
          settings.organization = raw.footer.organization.trim();
        }
      }
    }
  }

  if (errors.length) throw new Error(errors.join('; '));
  return settings;
}

// Read settings.json from the repo base; a missing file is the normal
// defaults case, a broken one stops the build with a readable message.
export function loadSettings(base) {
  const path = join(base, 'settings.json');
  if (!existsSync(path)) return defaultSettings();
  try {
    return parseSettings(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(err.message);
  }
}

// Report language for one build: --lang flag > REPORT_LANG env > the
// settings.json default > the language the data was pulled with > sv.
// periodLang comes from data/<slug>/period.json (written by the pull scripts).
export function resolveReportLanguage({ flag, env, settings, periodLang } = {}) {
  const chosen = [flag, env, settings?.language, periodLang].find((v) => v !== undefined && v !== null && v !== '') ?? 'sv';
  if (!SUPPORTED_LANGUAGES.includes(chosen)) {
    fail(
      `unknown report language "${chosen}" (from ${flag !== undefined && flag !== '' && flag === chosen ? '--lang flag' : 'REPORT_LANG or settings'}). Supported: ${SUPPORTED_LANGUAGES.join(' | ')}`
    );
  }
  return chosen;
}
