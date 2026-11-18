import { formatNumber } from '../../i18n/format.js';
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

/** Every rate against the base currency, or null when the ledger has none. */
export function ratesLine(t, ledger) {
  const { base, toBase } = ledger.rates ?? {};
  const quotes = Object.keys(toBase ?? {})
    .map((code) => quoteBetween(code, base, ledger.rates))
    .filter(Boolean);
  if (quotes.length === 0) return null;
  return t('expenses:rates.today', {
    rates: quotes.map((quote) => quoteLabel(t, quote)).join(' · '),
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
