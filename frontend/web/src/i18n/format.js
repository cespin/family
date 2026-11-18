import i18n, { DEFAULT_LOCALE } from './index.js';

// All number, money and date formatting goes through here, so it follows the active language.
const locale = () => i18n.resolvedLanguage ?? DEFAULT_LOCALE;

export function formatNumber(value, options) {
  return new Intl.NumberFormat(locale(), options).format(value);
}

export function formatCurrency(amount, currency) {
  return new Intl.NumberFormat(locale(), { style: 'currency', currency }).format(amount);
}

/** How many decimals a currency has: 2 for CAD and USD, 0 for CLP. */
export function currencyDigits(currency) {
  return new Intl.NumberFormat(locale(), { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
}

/** The size of an amount held in minor units. The sign is shown by wording and colour instead. */
export function formatMinor(minor, currency) {
  return formatCurrency(Math.abs(minor) / 10 ** currencyDigits(currency), currency);
}

/** An amount in minor units, written the way a person would type it into a field. */
export function formatAmountInput(minor, currency) {
  const digits = currencyDigits(currency);
  return formatNumber(Math.abs(minor) / 10 ** digits, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDate(date, options = { dateStyle: 'long' }) {
  return new Intl.DateTimeFormat(locale(), options).format(new Date(date));
}

/** A calendar day such as 2026-11-14, which must not shift with the reader's time zone. */
export function formatCalendarDate(isoDate, options) {
  return formatDate(isoDate, { ...options, timeZone: 'UTC' });
}

export function formatRelativeTime(value, unit) {
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(value, unit);
}
