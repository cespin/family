import { describe, expect, it } from 'vitest';
import {
  conversionTolerance,
  convertMinor,
  evenPercents,
  parseAmount,
  parseRate,
  percentTotal,
  quoteBetween,
  ratesFromEntry,
  splitByPercent,
  splitEqual,
  sumConverted,
} from './money.js';

const RATES = { toBase: { CAD: 1, USD: 1.4, CLP: 1 / 670 } };

const sum = (shares) => Object.values(shares).reduce((total, share) => total + share, 0);

describe('parseAmount', () => {
  it.each([
    ['95.000', 'CLP', 95000],
    ['320,00', 'USD', 32000],
    ['1.234,56', 'CAD', 123456],
    ['1.234.567', 'CLP', 1234567],
    ['19,99', 'USD', 1999],
    ['12.5', 'CAD', 1250],
    ['CLP 26.550', 'CLP', 26550],
    ['0', 'CAD', 0],
  ])('reads %s in %s as %i minor units', (text, currency, expected) => {
    expect(parseAmount(text, currency)).toBe(expected);
  });

  it.each(['', '   ', 'abc', ',', null, undefined])('treats %j as no amount, not as zero', (text) => {
    expect(parseAmount(text, 'CAD')).toBeNull();
  });
});

describe('splitEqual', () => {
  it('never loses a minor unit to rounding', () => {
    const shares = splitEqual(10000, ['a', 'b', 'c']);
    expect(shares).toEqual({ a: 3334, b: 3333, c: 3333 });
    expect(sum(shares)).toBe(10000);
  });

  it('returns nothing to split between nobody', () => {
    expect(splitEqual(10000, [])).toEqual({});
  });
});

describe('splitByPercent', () => {
  it('splits 50 · 25 · 25 exactly', () => {
    expect(splitByPercent(120000, ['a', 'b', 'c'], { a: 50, b: 25, c: 25 })).toEqual({
      a: 60000,
      b: 30000,
      c: 30000,
    });
  });

  it('gives the rounding to the largest share so the parts add up', () => {
    const shares = splitByPercent(10001, ['a', 'b', 'c'], { a: 34, b: 33, c: 33 });
    expect(sum(shares)).toBe(10001);
  });

  it('does not invent money when the percentages fall short of 100', () => {
    expect(sum(splitByPercent(10000, ['a', 'b'], { a: 50, b: 25 }))).toBe(7500);
  });
});

describe('evenPercents', () => {
  it('reaches exactly 100 across the included people', () => {
    const percents = evenPercents(['a', 'b', 'c', 'd'], ['a', 'b', 'c']);
    expect(percents).toEqual({ a: 34, b: 33, c: 33, d: 0 });
    expect(percentTotal(['a', 'b', 'c', 'd'], percents)).toBe(100);
  });
});

describe('conversion', () => {
  it('converts through the rates', () => {
    expect(convertMinor(7500, 'CAD', 'USD', RATES)).toBe(5357);
    expect(convertMinor(-26550, 'CLP', 'CAD', RATES)).toBe(-3963);
  });

  it('returns null, not a zero, when a rate is missing', () => {
    expect(convertMinor(100, 'EUR', 'CAD', RATES)).toBeNull();
    expect(convertMinor(100, 'CAD', 'USD', undefined)).toBeNull();
  });

  it('keeps an amount unchanged in its own currency, even without rates', () => {
    expect(convertMinor(100, 'CAD', 'CAD', undefined)).toBe(100);
  });

  it('allows one minor unit of the paying currency when comparing across currencies', () => {
    expect(conversionTolerance('CAD', 'CLP', RATES)).toBe(7);
    expect(conversionTolerance('CLP', 'CLP', RATES)).toBe(0);
  });
});

describe('sumConverted', () => {
  it('adds mixed currencies only after converting, rounding at the end', () => {
    const entries = [
      { minor: -76800, currency: 'CLP' },
      { minor: 7500, currency: 'CAD' },
    ];
    expect(sumConverted(entries, 'CLP', RATES)).toBe(-26550);
    expect(sumConverted(entries, 'CAD', RATES)).toBe(-3963);
  });

  it('refuses to total amounts it cannot convert', () => {
    const entries = [
      { minor: 7500, currency: 'CAD' },
      { minor: 100, currency: 'EUR' },
    ];
    expect(sumConverted(entries, 'CAD', RATES)).toBeNull();
  });
});

describe('quoteBetween', () => {
  it('quotes so the value reads naturally', () => {
    expect(quoteBetween('USD', 'CAD', RATES)).toEqual({ from: 'USD', to: 'CAD', value: 1.4 });
    expect(quoteBetween('CLP', 'CAD', RATES)).toMatchObject({ from: 'CAD', to: 'CLP' });
    expect(quoteBetween('CLP', 'CAD', RATES).value).toBeCloseTo(670);
  });

  it('has no quote for a currency without a rate', () => {
    expect(quoteBetween('EUR', 'CAD', RATES)).toBeNull();
  });
});

describe('parseRate', () => {
  it.each([
    ['1.40', '1.40'],
    ['1,40', '1.40'],
    [' 670 ', '670'],
    ['1.234,5', '1234.5'],
    ['1.000.000', '1000000'],
  ])('reads %j as the plain decimal %j', (text, expected) => {
    expect(parseRate(text)).toBe(expected);
  });

  it.each(['', '0', '-1', 'abc', '1e3', '1.', '1000001'])('refuses %j', (text) => {
    expect(parseRate(text)).toBeNull();
  });
});

describe('ratesFromEntry', () => {
  it('converts through CAD, from the two rates the family enters', () => {
    const rates = ratesFromEntry({ id: 'r', usdCad: '1.40', cadClp: '670', date: '2026-11-18' });
    expect(convertMinor(1000, 'USD', 'CLP', rates)).toBe(9380);
  });

  it('is absent when there is no entry', () => {
    expect(ratesFromEntry(undefined)).toBeNull();
  });
});
