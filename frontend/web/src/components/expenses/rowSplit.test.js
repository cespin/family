import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.js';
import { percentLabel } from './labels.js';
import { rowSplit } from './rowSplit.js';

const t = i18n.t.bind(i18n);

const LEDGER = {
  me: 'carlos',
  members: [
    { id: 'carlos', name: 'Carlos', tone: 'honey' },
    { id: 'lucia', name: 'Lucía', tone: 'clay' },
    { id: 'diego', name: 'Diego', tone: 'lagoon' },
    { id: 'mama', name: 'Mamá', tone: 'sage' },
    { id: 'beto', name: 'Tío Beto' },
  ],
};

const CARE = {
  payerId: 'lucia',
  amountMinor: 120000,
  splitMode: 'percent',
  participants: [
    { memberId: 'lucia', shareMinor: 30000, percent: 25 },
    { memberId: 'diego', shareMinor: 30000, percent: 25 },
    { memberId: 'carlos', shareMinor: 60000, percent: 50 },
  ],
  standing: { involved: true, openMinor: -60000, settled: false },
};

const equal = (ids, overrides = {}) => ({
  payerId: ids[0],
  amountMinor: 100 * ids.length,
  splitMode: 'equal',
  participants: ids.map((id) => ({ memberId: id, shareMinor: 100 })),
  standing: { involved: true, openMinor: -100, settled: false },
  ...overrides,
});

const NOT_MINE = equal(['lucia', 'diego', 'beto'], {
  standing: { involved: false, openMinor: null, settled: false },
});

describe('rowSplit', () => {
  it('draws a percent split by its percentages, not in equal parts', () => {
    const split = rowSplit(t, LEDGER, CARE, false);
    expect(split.parts.map((part) => [part.id, part.percent])).toEqual([
      ['carlos', 50],
      ['lucia', 25],
      ['diego', 25],
    ]);
    expect(split.caption).toBe(t('expenses:row.yourSharePercent', { percent: percentLabel(t, 50) }));
  });

  it('marks only the reader, and puts their part first on a phone', () => {
    const split = rowSplit(t, LEDGER, CARE, false);
    expect(split.variant).toBe('mine');
    expect(split.parts.filter((part) => part.mine).map((part) => part.id)).toEqual(['carlos']);
  });

  it('still marks the reader when the reader paid', () => {
    const split = rowSplit(t, LEDGER, { ...CARE, payerId: 'carlos' }, false);
    expect(split.parts[0]).toMatchObject({ id: 'carlos', mine: true });
  });

  it('counts the people in an equal split, even when the shares differ by a remainder', () => {
    const expense = equal(['lucia', 'carlos', 'diego'], { amountMinor: 100 });
    expense.participants = [
      { memberId: 'lucia', shareMinor: 34 },
      { memberId: 'carlos', shareMinor: 33 },
      { memberId: 'diego', shareMinor: 33 },
    ];
    const split = rowSplit(t, LEDGER, expense, false);
    expect(split.caption).toBe(t('expenses:row.yourShareEqual', { total: 3 }));
    expect(split.parts.map((part) => part.percent)).toEqual([33, 34, 33]);
  });

  it('shows no split when the list did not send one, rather than guessing an equal one', () => {
    const { splitMode: _mode, participants: _parts, ...bare } = CARE;
    expect(rowSplit(t, LEDGER, { ...bare, participantIds: ['carlos', 'lucia'] }, false)).toBeNull();
    expect(rowSplit(t, LEDGER, { ...bare, participantIds: ['carlos', 'lucia'] }, true)).toBeNull();
    expect(rowSplit(t, LEDGER, { ...CARE, splitMode: undefined }, true)).toBeNull();
  });

  it('shows no split on a phone when the reader is not part of the expense', () => {
    expect(rowSplit(t, LEDGER, NOT_MINE, false)).toBeNull();
  });

  it('shows everyone, and nobody as the reader, on a wide list when the reader is not part of it', () => {
    const split = rowSplit(t, LEDGER, NOT_MINE, true);
    expect(split.variant).toBe('column');
    expect(split.parts.some((part) => part.mine)).toBe(false);
    expect(split.parts.map((part) => part.short)).toEqual([
      t('common:avatar.initials', { initials: 'L' }),
      t('common:avatar.initials', { initials: 'D' }),
      t('common:avatar.initials', { initials: 'TB' }),
    ]);
  });

  it('treats a payer who put in nothing as having no part', () => {
    // The payer counts as involved in `standing`, but has no share to show.
    const expense = equal(['lucia', 'diego'], {
      payerId: 'carlos',
      standing: { involved: true, openMinor: 200, settled: false },
    });
    expect(rowSplit(t, LEDGER, expense, false)).toBeNull();
    expect(rowSplit(t, LEDGER, expense, true).parts.some((part) => part.mine)).toBe(false);
  });

  it('writes "Tú" under the reader on a wide list, in the order the API sent', () => {
    const split = rowSplit(t, LEDGER, CARE, true);
    expect(split.parts.map((part) => part.short)).toEqual([
      t('common:avatar.initials', { initials: 'L' }),
      t('common:avatar.initials', { initials: 'D' }),
      t('expenses:you.subject'),
    ]);
  });

  it('names everyone in the label, but draws no room for a part of zero', () => {
    const expense = {
      ...CARE,
      participants: [...CARE.participants, { memberId: 'mama', shareMinor: 0, percent: 0 }],
    };
    const split = rowSplit(t, LEDGER, expense, true);
    expect(split.parts.map((part) => part.id)).toEqual(['lucia', 'diego', 'carlos']);
    expect(split.label).toContain('Mamá');
  });
});
