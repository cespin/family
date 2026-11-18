import i18n, { DEFAULT_LOCALE } from './index.js';

// All number, money and date formatting goes through here, so it follows the active language.
const locale = () => i18n.resolvedLanguage ?? DEFAULT_LOCALE;

export function formatNumber(value, options) {
  return new Intl.NumberFormat(locale(), options).format(value);
}

export function formatCurrency(amount, currency) {
  return new Intl.NumberFormat(locale(), { style: 'currency', currency }).format(amount);
}

export function formatDate(date, options = { dateStyle: 'long' }) {
  return new Intl.DateTimeFormat(locale(), options).format(new Date(date));
}

export function formatRelativeTime(value, unit) {
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(value, unit);
}
