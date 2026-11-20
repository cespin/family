import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS,
  advanceCandidates,
  balanceTotal,
  balancesFor,
  expensesByMonth,
  isTransactionDate,
  transactionDateOf,
} from './ledger.js';
import { ratesFromEntry } from './money.js';

const RATES = ratesFromEntry({ id: 'r', usdCad: '1.40', cadClp: '670', date: '2026-11-18' });

const MEMBERS = [
  { id: 'carlos', name: 'Carlos', currency: 'CAD', active: true },
  { id: 'lucia', name: 'Lucía', currency: 'CLP', active: true },
  { id: 'diego', name: 'Diego', currency: 'USD', active: true },
  { id: 'beto', name: 'Tío Beto', currency: 'USD', active: true },
];

// Carlos's standings in the backend's test data, which section 6 of docs/frontend-requirements.md
// publishes as the worked example. Reading them from the data keeps both sides on the same figures.
function carlosLedger() {
  const here = dirname(fileURLToPath(import.meta.url));
  const expected = JSON.parse(
    readFileSync(join(here, '../../../../backend/testdata/ledger/expected.json'), 'utf8'),
  );
  const money = ({ amountMinor, currency }) => ({ minor: amountMinor, currency });
  return {
    me: 'carlos',
    rates: RATES,
    members: MEMBERS,
    groups: [],
    standings: expected.callers.carlos.standings.map((standing) => ({
      memberId: standing.member,
      overall: standing.overall.map(money),
      groups: standing.groups.map((group) => ({
        groupId: group.group,
        amounts: group.amounts.map(money),
      })),
    })),
  };
}

describe('balances from the API standings', () => {
  it('matches the worked example in the requirements', () => {
    const ledger = carlosLedger();
    const rows = balancesFor(ledger, { currency: 'CAD' });
    expect(rows.map((row) => [row.member.id, row.netMinor])).toEqual([
      ['diego', 7500],
      ['lucia', -3963],
      ['beto', -1680],
    ]);
    expect(rows.find((row) => row.member.id === 'diego').homeMinor).toBe(5357);
    expect(rows.find((row) => row.member.id === 'lucia').homeMinor).toBe(-26550);
  });

  it('rounds the total once, so it can differ from the sum of the groups', () => {
    const ledger = carlosLedger();
    expect(balanceTotal(ledger, { currency: 'CAD' })).toBe(1857);
    const groups = ['family', 'meals', 'care'].map((groupId) =>
      balanceTotal(ledger, { groupId, currency: 'CAD' }),
    );
    expect(groups).toEqual([-1680, -2507, 6045]);
    expect(groups.reduce((sum, value) => sum + value, 0)).toBe(1858);
  });

  it('keeps each amount in its own currency until it is converted', () => {
    const lucia = balancesFor(carlosLedger(), { currency: 'CLP' }).find(
      (row) => row.member.id === 'lucia',
    );
    expect(lucia.entries).toEqual([
      { minor: -76800, currency: 'CLP' },
      { minor: 7500, currency: 'CAD' },
    ]);
  });

  it('is absent, not partial, when there are no rates to convert with', () => {
    const ledger = { ...carlosLedger(), rates: null };
    expect(balanceTotal(ledger, { currency: 'CAD' })).toBeNull();
    const diego = balancesFor(ledger, { currency: 'CAD' }).find((row) => row.member.id === 'diego');
    expect(diego.netMinor).toBe(7500);
    expect(diego.homeMinor).toBeNull();
  });

  it('is a real zero when everyone is square', () => {
    const ledger = { ...carlosLedger(), standings: [] };
    expect(balancesFor(ledger, { currency: 'CAD' })).toEqual([]);
    expect(balanceTotal(ledger, { groupId: ALL_GROUPS, currency: 'CAD' })).toBe(0);
  });

  it('shows nobody for a group they have nothing open in', () => {
    const rows = balancesFor(carlosLedger(), { groupId: 'meals', currency: 'CAD' });
    expect(rows.map((row) => row.member.id)).toEqual(['lucia']);
  });
});

describe('credit with no group in a group view', () => {
  // Diego owes Carlos CAD 10 in "pyh", and Carlos holds USD 20 of Diego's credit with no group.
  function withUngrouped(overrides = {}) {
    return {
      me: 'carlos',
      rates: RATES,
      members: MEMBERS,
      groups: [
        { id: 'pyh', name: 'Padre e Hijo', memberIds: ['carlos', 'diego'] },
        { id: 'other', name: 'Otro', memberIds: ['carlos', 'lucia'] },
      ],
      standings: [
        {
          memberId: 'diego',
          overall: [
            { minor: 1000, currency: 'CAD' },
            { minor: -2000, currency: 'USD' },
          ],
          groups: [
            { groupId: 'pyh', amounts: [{ minor: 1000, currency: 'CAD' }] },
            { groupId: null, amounts: [{ minor: -2000, currency: 'USD' }] },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('counts it in a group both people belong to, and says how much of it has no group', () => {
    const [diego] = balancesFor(withUngrouped(), {
      groupId: 'pyh',
      currency: 'USD',
      withUngrouped: true,
    });
    expect(diego.entries).toEqual([
      { minor: 1000, currency: 'CAD' },
      { minor: -2000, currency: 'USD' },
    ]);
    expect(diego.ungroupedMinor).toBe(-2000);
    expect(diego.netMinor).toBe(-1286);
    const total = balanceTotal(withUngrouped(), {
      groupId: 'pyh',
      currency: 'USD',
      withUngrouped: true,
    });
    expect(total).toBe(-1286);
  });

  it('reads only what is held in the group unless asked, as settling up does', () => {
    const [diego] = balancesFor(withUngrouped(), { groupId: 'pyh', currency: 'USD' });
    expect(diego.entries).toEqual([{ minor: 1000, currency: 'CAD' }]);
    expect(diego.ungroupedMinor).toBe(0);
  });

  it('leaves it out of a group the other person is not in', () => {
    const rows = balancesFor(withUngrouped(), {
      groupId: 'other',
      currency: 'USD',
      withUngrouped: true,
    });
    expect(rows).toEqual([]);
  });

  it('counts it once across all groups', () => {
    const [diego] = balancesFor(withUngrouped(), { currency: 'USD', withUngrouped: true });
    expect(diego.netMinor).toBe(-1286);
    expect(diego.ungroupedMinor).toBe(0);
  });

  it('is absent, not zero, when it cannot be converted', () => {
    const [diego] = balancesFor(withUngrouped({ rates: null }), {
      groupId: 'pyh',
      currency: 'CAD',
      withUngrouped: true,
    });
    expect(diego.ungroupedMinor).toBeNull();
    expect(diego.netMinor).toBeNull();
  });
});

describe('advanceCandidates', () => {
  const withMembers = (ledger) => ({
    ...ledger,
    members: [
      ...MEMBERS,
      { id: 'mama', name: 'Mamá', currency: 'USD', active: true },
      { id: 'rosa', name: 'Rosa', currency: 'CLP', active: false },
    ],
  });

  it('offers everyone else who is active, in the API order, even when nothing is open', () => {
    const rows = advanceCandidates(withMembers(carlosLedger()), 'CAD');
    expect(rows.map((row) => row.member.id)).toEqual(['lucia', 'diego', 'beto', 'mama']);
  });

  it('keeps the balance with someone who has one, in both currencies', () => {
    const lucia = advanceCandidates(withMembers(carlosLedger()), 'CAD').find(
      (row) => row.member.id === 'lucia',
    );
    expect(lucia.netMinor).toBe(-3963);
    expect(lucia.homeMinor).toBe(-26550);
  });

  it('is a real zero for someone with no standing', () => {
    const mama = advanceCandidates(withMembers(carlosLedger()), 'CAD').find(
      (row) => row.member.id === 'mama',
    );
    expect(mama.entries).toEqual([]);
    expect(mama.netMinor).toBe(0);
    expect(mama.homeMinor).toBe(0);
  });

  it('is absent, not zero, when a balance cannot be converted', () => {
    const ledger = { ...withMembers(carlosLedger()), rates: null };
    const diego = advanceCandidates(ledger, 'CAD').find((row) => row.member.id === 'diego');
    expect(diego.homeMinor).toBeNull();
  });
});

describe('expensesByMonth', () => {
  it('keeps the order the API sent, newest month first', () => {
    const months = expensesByMonth([
      { id: 'new', date: '2026-11-14' },
      { id: 'mid', date: '2026-11-01' },
      { id: 'old', date: '2026-10-04' },
    ]);
    expect(months.map((month) => month.key)).toEqual(['2026-11', '2026-10']);
    expect(months[0].expenses.map((item) => item.id)).toEqual(['new', 'mid']);
  });

  it('groups by the month the money was spent, not the day it was entered', () => {
    const months = expensesByMonth([
      { id: 'entered-late', date: '2026-11-19', transactionDate: '2026-08-03' },
      { id: 'older', date: '2026-08-01' },
    ]);
    expect(months).toEqual([
      {
        key: '2026-08',
        date: '2026-08-03',
        expenses: [
          { id: 'entered-late', date: '2026-11-19', transactionDate: '2026-08-03' },
          { id: 'older', date: '2026-08-01' },
        ],
      },
    ]);
  });
});

describe('transactionDateOf', () => {
  it('reads the entry date of an answer that predates transaction dates', () => {
    expect(transactionDateOf({ date: '2026-11-14' })).toBe('2026-11-14');
    expect(transactionDateOf({ date: '2026-11-14', transactionDate: '2026-08-03' })).toBe('2026-08-03');
  });
});

describe('isTransactionDate', () => {
  const today = '2026-11-19';

  it.each([
    ['today', '2026-11-19', true],
    ['a past day', '2026-08-03', true],
    ['a real day still to come', '2028-02-29', false],
    ['tomorrow', '2026-11-20', false],
    ['a day that does not exist', '2026-02-30', false],
    ['an empty field', '', false],
    ['a partly typed day', '2026-11', false],
  ])('%s', (_name, value, expected) => {
    expect(isTransactionDate(value, today)).toBe(expected);
  });

  it('accepts 29 February in a leap year that has passed', () => {
    expect(isTransactionDate('2024-02-29', today)).toBe(true);
    expect(isTransactionDate('2025-02-29', today)).toBe(false);
  });
});
