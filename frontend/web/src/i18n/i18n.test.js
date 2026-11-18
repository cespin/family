import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import i18n, { DEFAULT_LOCALE, SUPPORTED_LOCALES, catalogs, resolveLocale } from './index.js';
import { errorMessage } from './errors.js';
import { formatCurrency, formatNumber } from './format.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(SRC, '..', '..', '..', 'backend');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(js|jsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

function flatten(messages, prefix = '') {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

function catalogKeys(catalog) {
  return Object.entries(catalog)
    .flatMap(([namespace, messages]) => flatten(messages).map((key) => `${namespace}:${key}`))
    .sort();
}

describe('catalogs', () => {
  it('has a translation for every t() key used in the source', () => {
    const known = new Set(catalogKeys(catalogs[DEFAULT_LOCALE]));
    const used = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]),
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !known.has(key))).toEqual([]);
  });

  it('has the same keys in every locale', () => {
    const expected = catalogKeys(catalogs[DEFAULT_LOCALE]);
    for (const locale of SUPPORTED_LOCALES) {
      expect(catalogKeys(catalogs[locale]), locale).toEqual(expected);
    }
  });

  it('translates every error code the backend can return', () => {
    const rust = readFileSync(join(BACKEND, 'functions/family-core/src/error.rs'), 'utf8');
    const template = readFileSync(join(BACKEND, 'templates/api/stack.yaml'), 'utf8');
    const codes = new Set([
      ...[...rust.matchAll(/Self::\w+\(_\) => "([a-z_]+)"/g)].map((match) => match[1]),
      ...[...template.matchAll(/"code": "([a-z_]+)"/g)].map((match) => match[1]),
    ]);
    expect(codes.size).toBeGreaterThan(5);
    const known = Object.keys(catalogs[DEFAULT_LOCALE].common.errors);
    expect([...codes].filter((code) => !known.includes(code))).toEqual([]);
  });
});

describe('resolveLocale', () => {
  it.each([
    [['es-VE'], 'es-VE'],
    [['es-MX', 'en'], 'es-VE'],
    [['fr-FR'], DEFAULT_LOCALE],
    [[], DEFAULT_LOCALE],
  ])('resolves %j to %s', (preferred, expected) => {
    expect(resolveLocale(preferred)).toBe(expected);
  });

  it('prefers an exact match over the same language', () => {
    expect(resolveLocale(['es-MX'], ['es-VE', 'es-MX'])).toBe('es-MX');
  });
});

describe('errorMessage', () => {
  it('translates a known code', () => {
    expect(errorMessage('forbidden')).toBe(i18n.t('common:errors.forbidden'));
  });

  it('falls back to the generic message for an unknown code', () => {
    expect(errorMessage('something_new')).toBe(i18n.t('common:errors.generic'));
  });
});

describe('format', () => {
  it('formats numbers with the active locale', () => {
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat(DEFAULT_LOCALE).format(1234.5));
  });

  it('formats money with the given currency', () => {
    expect(formatCurrency(10, 'USD')).toBe(
      new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: 'USD' }).format(10),
    );
  });
});
