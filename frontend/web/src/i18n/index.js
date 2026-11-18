import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const DEFAULT_LOCALE = 'es-VE';

// Adding a language means adding a folder under locales/. Nothing else changes.
const catalogFiles = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' });

export const catalogs = Object.entries(catalogFiles).reduce((all, [path, messages]) => {
  const [, locale, namespace] = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  return { ...all, [locale]: { ...all[locale], [namespace]: messages } };
}, {});

export const SUPPORTED_LOCALES = Object.keys(catalogs);
export const NAMESPACES = Object.keys(catalogs[DEFAULT_LOCALE]);

/** The best supported locale for the browser's preferences: exact match, then same language. */
export function resolveLocale(preferred = [], supported = SUPPORTED_LOCALES) {
  for (const candidate of preferred) {
    const exact = supported.find((locale) => locale.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact;
    const language = candidate.split('-')[0].toLowerCase();
    const sameLanguage = supported.find((locale) => locale.split('-')[0].toLowerCase() === language);
    if (sameLanguage) return sameLanguage;
  }
  return DEFAULT_LOCALE;
}

function syncDocument() {
  document.documentElement.lang = i18n.resolvedLanguage ?? DEFAULT_LOCALE;
  document.title = i18n.t('common:appName');
}

i18n.on('languageChanged', syncDocument);

i18n.use(initReactI18next).init({
  resources: catalogs,
  lng: resolveLocale(typeof navigator === 'undefined' ? [] : navigator.languages),
  fallbackLng: DEFAULT_LOCALE,
  ns: NAMESPACES,
  defaultNS: 'common',
  interpolation: { escapeValue: false }, // React already escapes rendered values.
  returnNull: false,
  react: { useSuspense: false },
});

export default i18n;
