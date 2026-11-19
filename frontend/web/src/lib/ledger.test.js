import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_GROUPS, balanceTotal, balancesFor, expensesByMonth } from './ledger.js';
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
});
