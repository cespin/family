import { describe, expect, it } from 'vitest';
import {
  currencyDigits,
  formatAmountInput,
  formatCalendarDate,
  formatCurrency,
  formatMinor,
} from './format.js';

describe('money in minor units', () => {
  it('knows that pesos have no decimals', () => {
    expect(currencyDigits('CLP')).toBe(0);
    expect(currencyDigits('CAD')).toBe(2);
  });

  it('does not divide a currency without decimals', () => {
    expect(formatMinor(120000, 'CLP')).toBe(formatCurrency(120000, 'CLP'));
    expect(formatMinor(32000, 'USD')).toBe(formatCurrency(320, 'USD'));
  });

  it('shows the size of a debt, leaving the direction to the wording', () => {
    expect(formatMinor(-5000, 'CAD')).toBe(formatMinor(5000, 'CAD'));
  });

  it('writes an amount the way it can be typed back', () => {
    expect(formatAmountInput(3963, 'CAD')).toMatch(/^39.63$/);
  });
});

describe('formatCalendarDate', () => {
  it('keeps the day that was recorded, whatever the reader’s time zone', () => {
    expect(formatCalendarDate('2026-11-14', { day: 'numeric' })).toBe('14');
  });
});
