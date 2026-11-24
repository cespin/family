import { currencyDigits } from '../i18n/format.js';

// Money is always integer minor units plus its currency. Nothing here adds two currencies together
// without converting through an explicit rate first.

/** The supported currencies, offered whether or not any rates exist yet. */
export const CURRENCIES = ['CAD', 'USD', 'CLP'];

/** The largest expense the API accepts, in minor units: 10.000,00 CAD or USD, or CLP 10.000.000. */
export const EXPENSE_MAX_MINOR = { CAD: 1_000_000, USD: 1_000_000, CLP: 10_000_000 };

/** The largest payment a browser reads exactly, which is also the API's limit. */
export const PAYMENT_MAX_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * The conversion table for one exchange rate entry from the API, or null when there is none.
 * The entry holds 1 USD in CAD and 1 CAD in CLP as decimal strings; CAD is the base.
 */
/**
 * The reader's own calendar day for a fetched entry's time. The entry's `date` is the UTC day,
 * which in the Americas turns to tomorrow from the late afternoon on.
 */
function localDay(timestamp) {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return null;
  const month = String(time.getMonth() + 1).padStart(2, '0');
  const day = String(time.getDate()).padStart(2, '0');
  return `${time.getFullYear()}-${month}-${day}`;
}

export function ratesFromEntry(entry) {
  if (!entry) return null;
  const usdCad = Number(entry.usdCad);
  const cadClp = Number(entry.cadClp);
  if (!(usdCad > 0) || !(cadClp > 0)) return null;
  return {
    id: entry.id,
    base: 'CAD',
    asOf: (entry.fetchedAt && localDay(entry.fetchedAt)) || entry.date,
    enteredBy: entry.enteredBy,
    usdCad: entry.usdCad,
    cadClp: entry.cadClp,
    toBase: { CAD: 1, USD: usdCad, CLP: 1 / cadClp },
  };
}

/**
 * Reads what a person typed into integer minor units, or null when there is no number in it.
 * Accepts both "95.000" (thousands) and "320,00" (decimals), the way family members write amounts.
 */
export function parseAmount(text, currency) {
  let digits = String(text ?? '').replace(/[^0-9.,]/g, '');
  if (!/[0-9]/.test(digits)) return null;
  if (digits.includes(',')) {
    digits = digits.replaceAll('.', '').replace(',', '.');
  } else if (/\.\d{3}$/.test(digits) || (digits.match(/\./g) ?? []).length > 1) {
    digits = digits.replaceAll('.', '');
  }
  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) return null;
  return Math.round(value * 10 ** currencyDigits(currency));
}

/** Equal shares that always add up to the total. The first people absorb any remainder. */
export function splitEqual(totalMinor, ids) {
  if (ids.length === 0) return {};
  const each = Math.floor(totalMinor / ids.length);
  const remainder = totalMinor - each * ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, each + (index < remainder ? 1 : 0)]));
}

/** Percentage shares. When the percentages reach 100, the largest share absorbs the rounding. */
export function splitByPercent(totalMinor, ids, percents) {
  const shares = Object.fromEntries(
    ids.map((id) => [id, Math.round((totalMinor * (percents[id] ?? 0)) / 100)]),
  );
  if (percentTotal(ids, percents) !== 100 || ids.length === 0) return shares;
  const largest = ids.reduce((top, id) => (shares[id] > shares[top] ? id : top), ids[0]);
  const assigned = ids.reduce((sum, id) => sum + shares[id], 0);
  return { ...shares, [largest]: shares[largest] + totalMinor - assigned };
}

export function percentTotal(ids, percents) {
  return ids.reduce((sum, id) => sum + (percents[id] ?? 0), 0);
}

/** Whole percentages that add up to 100 across the included people, and 0 for everyone else. */
export function evenPercents(ids, includedIds) {
  const count = includedIds.length;
  const base = count > 0 ? Math.floor(100 / count) : 0;
  const remainder = 100 - base * count;
  return Object.fromEntries(
    ids.map((id) => {
      const position = includedIds.indexOf(id);
      if (position < 0) return [id, 0];
      return [id, base + (position < remainder ? 1 : 0)];
    }),
  );
}

/** One minor-unit amount in another currency, unrounded, or null when a rate is missing. */
export function convertExact(minor, from, to, rates) {
  if (from === to) return minor;
  const fromRate = rates?.toBase?.[from];
  const toRate = rates?.toBase?.[to];
  if (fromRate == null || toRate == null) return null;
  const major = minor / 10 ** currencyDigits(from);
  return (major * fromRate * 10 ** currencyDigits(to)) / toRate;
}

/** Converts to another currency's minor units. Null when a rate is missing, never a guess. */
export function convertMinor(minor, from, to, rates) {
  const converted = convertExact(minor, from, to, rates);
  return converted == null ? null : Math.round(converted);
}

/** How far one minor unit of `from` reaches in `to`, so conversion rounding is not read as a debt. */
export function conversionTolerance(from, to, rates) {
  if (from === to) return 0;
  const converted = convertExact(1, from, to, rates);
  return converted == null ? 0 : Math.ceil(converted);
}

/** Adds signed amounts in mixed currencies, unrounded. Null when any rate is missing. */
export function sumExact(entries, to, rates) {
  let total = 0;
  for (const { minor, currency } of entries) {
    const converted = convertExact(minor, currency, to, rates);
    if (converted == null) return null;
    total += converted;
  }
  return total;
}

/**
 * Adds signed amounts in mixed currencies, in `to`. Rounds only at the end, and returns null when
 * any rate is missing: a total that leaves an amount out is not a total.
 */
export function sumConverted(entries, to, rates) {
  const total = sumExact(entries, to, rates);
  return total == null ? null : Math.round(total);
}

/** The rate between two currencies, written so the quoted value is at least 1. */
export function quoteBetween(from, to, rates) {
  const fromRate = rates?.toBase?.[from];
  const toRate = rates?.toBase?.[to];
  if (from === to || fromRate == null || toRate == null) return null;
  const value = fromRate / toRate;
  return value >= 1 ? { from, to, value } : { from: to, to: from, value: toRate / fromRate };
}
