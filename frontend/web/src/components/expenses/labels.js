import { formatCalendarDate, formatNumber } from '../../i18n/format.js';
import { memberById } from '../../lib/ledger.js';
import { quoteBetween } from '../../lib/money.js';

// Translated names for closed sets of values. Each key is written out so the catalog test sees it.

export function currencyLabel(t, code) {
  const labels = {
    CAD: t('expenses:currencies.CAD'),
    USD: t('expenses:currencies.USD'),
    CLP: t('expenses:currencies.CLP'),
  };
  return labels[code] ?? code;
}

export function kindLabel(t, kind) {
  const labels = {
    meal: t('expenses:kinds.meal'),
    parents: t('expenses:kinds.parents'),
    gift: t('expenses:kinds.gift'),
    other: t('expenses:kinds.other'),
  };
  return labels[kind];
}

export function kindFilterLabel(t, kind) {
  const labels = {
    all: t('expenses:filters.all'),
    meal: t('expenses:filters.meal'),
    parents: t('expenses:filters.parents'),
    gift: t('expenses:filters.gift'),
    other: t('expenses:filters.other'),
  };
  return labels[kind];
}

/** "Tú" for the reader, and the person's name for everyone else. */
export function memberLabel(t, ledger, id) {
  return id === ledger.me ? t('expenses:you.subject') : memberById(ledger, id)?.name;
}

export function percentLabel(t, value) {
  return t('expenses:percent', { value: formatNumber(value, { maximumFractionDigits: 1 }) });
}

export function quoteLabel(t, quote) {
  const digits = quote.value < 100 ? 2 : 0;
  return t('expenses:rates.quote', {
    from: currencyLabel(t, quote.from),
    to: currencyLabel(t, quote.to),
    value: formatNumber(quote.value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  });
}

/** The two rates the family enters, such as "1 USD = 1,40 CAD · 1 CAD = 670 CLP". */
export function ratesQuotes(t, rates) {
  return [quoteBetween('USD', 'CAD', rates), quoteBetween('CAD', 'CLP', rates)]
    .filter(Boolean)
    .map((quote) => quoteLabel(t, quote))
    .join(' · ');
}

/** The rates in use and the day they were entered, or null when the family has entered none. */
export function ratesLine(t, ledger) {
  if (!ledger.rates) return null;
  return t('expenses:rates.asOf', {
    date: formatCalendarDate(ledger.rates.asOf, { day: 'numeric', month: 'short' }),
    rates: ratesQuotes(t, ledger.rates),
  });
}

/** The group's usual split, such as "Tú 50 % · Ana 25 % · Leo 25 %". */
export function usualSplitLabel(t, ledger, group) {
  return group.memberIds
    .map((id) => `${memberLabel(t, ledger, id)} ${percentLabel(t, group.usual[id])}`)
    .join(' · ');
}

export function groupPeople(ledger, group) {
  return group.memberIds.map((id) => memberById(ledger, id));
}

/** Smallest group first, which puts the most specific split at the top. */
export function groupsBySize(ledger) {
  return [...ledger.groups].sort((a, b) => a.memberIds.length - b.memberIds.length);
}
