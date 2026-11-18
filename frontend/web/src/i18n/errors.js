import i18n from './index.js';

/** The translated message for an API error code, with a generic fallback for unknown codes. */
export function errorMessage(code) {
  const key = `common:errors.${code}`;
  return i18n.exists(key) ? i18n.t(key) : i18n.t('common:errors.generic');
}
