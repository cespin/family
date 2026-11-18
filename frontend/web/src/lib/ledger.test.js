import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS,
  balanceTotal,
  balancesFor,
  expenseNet,
  expenseStanding,
  expensesByMonth,
  sortedExpenses,
} from './ledger.js';

const RATES = { toBase: { CAD: 1, USD: 1.4, CLP: 1 / 670 } };

function expense(overrides) {
  return { id: 'e', groupId: 'care', settled: false, date: '2026-11-01', ...overrides };
}

function ledger(overrides = {}) {
  return {
    me: 'me',
    rates: RATES,
    members: [
      { id: 'me', name: 'Yo', currency: 'CAD' },
      { id: 'ana', name: 'Ana', currency: 'CLP' },
      { id: 'leo', name: 'Leo', currency: 'USD' },
    ],
    groups: [{ id: 'care', memberIds: ['me', 'ana', 'leo'] }],
    settlements: [],
    expenses: [
      expense({
        id: 'clp',
        payerId: 'ana',
        amountMinor: 120000,
        currency: 'CLP',
        shares: { me: 76800, ana: 43200 },
      }),
      expense({
        id: 'cad',
        payerId: 'me',
        amountMinor: 30000,
        currency: 'CAD',
        shares: { me: 15000, ana: 7500, leo: 7500 },
      }),
    ],
    ...overrides,
  };
}

describe('balancesFor', () => {
  it('nets what each person owes across currencies', () => {
    const rows = balancesFor(ledger(), { currency: 'CLP' });
    expect(rows.map((row) => [row.member.id, row.netMinor])).toEqual([
      ['leo', 50250],
      ['ana', -26550],
    ]);
  });

  it('reports the balance in the other person’s own currency too', () => {
    const [leo] = balancesFor(ledger(), { currency: 'CAD' });
    expect(leo.homeMinor).toBe(5357);
  });

  it('ignores settled expenses', () => {
    const data = ledger();
    data.expenses = data.expenses.map((item) => ({ ...item, settled: true }));
    expect(balancesFor(data, { currency: 'CAD' })).toEqual([]);
  });

  it('counts a recorded settlement against the debt', () => {
    const data = ledger({
      settlements: [{ fromId: 'me', toId: 'ana', amountMinor: 26550, currency: 'CLP' }],
    });
    const rows = balancesFor(data, { groupId: ALL_GROUPS, currency: 'CLP' });
    expect(rows.map((row) => row.member.id)).toEqual(['leo']);
  });

  it('marks a balance as absent when a rate is missing, instead of dropping the amount', () => {
    const data = ledger({ rates: { toBase: { CAD: 1, USD: 1.4 } } });
    const ana = balancesFor(data, { currency: 'CAD' }).find((row) => row.member.id === 'ana');
    expect(ana.netMinor).toBeNull();
  });
});

describe('balanceTotal', () => {
  it('rounds only once, at the end', () => {
    expect(balanceTotal(ledger(), { currency: 'CAD' })).toBe(3537);
  });

  it('is absent, not partial, when one amount cannot be converted', () => {
    const data = ledger({ rates: { toBase: { CAD: 1, USD: 1.4 } } });
    expect(balanceTotal(data, { currency: 'CAD' })).toBeNull();
  });

  it('is a real zero when everyone is square', () => {
    expect(balanceTotal(ledger({ expenses: [] }), { currency: 'CAD' })).toBe(0);
  });
});

describe('where a payment goes', () => {
  // Owes CLP 9.750 net in "care" and CLP 16.800 in "meals", the second being the oldest debt.
  function family(settlements = []) {
    return ledger({
      settlements,
      members: [
        { id: 'me', name: 'Yo', currency: 'CAD' },
        { id: 'ana', name: 'Ana', currency: 'CLP' },
      ],
      groups: [
        { id: 'care', memberIds: ['me', 'ana'] },
        { id: 'meals', memberIds: ['me', 'ana'] },
      ],
      expenses: [
        expense({
          id: 'therapy',
          groupId: 'care',
          date: '2026-11-14',
          payerId: 'ana',
          amountMinor: 120000,
          currency: 'CLP',
          shares: { me: 60000, ana: 60000 },
        }),
        expense({
          id: 'tablet',
          groupId: 'care',
          date: '2026-11-12',
          payerId: 'me',
          amountMinor: 15000,
          currency: 'CAD',
          shares: { me: 7500, ana: 7500 },
        }),
        expense({
          id: 'lunch',
          groupId: 'meals',
          date: '2026-11-08',
          payerId: 'ana',
          amountMinor: 33600,
          currency: 'CLP',
          shares: { me: 16800, ana: 16800 },
        }),
      ],
    });
  }

  const pay = (amountMinor, groupId) => ({
    fromId: 'me',
    toId: 'ana',
    amountMinor,
    currency: 'CLP',
    groupId,
  });
  const owedIn = (data, groupId) => balanceTotal(data, { groupId, currency: 'CLP' });

  it('goes to the oldest debt when no group is chosen', () => {
    const data = family([pay(10000)]);
    expect(owedIn(data, 'meals')).toBe(-6800);
    expect(owedIn(data, 'care')).toBe(-9750);
  });

  it('goes to the chosen group when there is one', () => {
    const data = family([pay(5000, 'care')]);
    expect(owedIn(data, 'care')).toBe(-4750);
    expect(owedIn(data, 'meals')).toBe(-16800);
  });

  it('sends what the chosen group cannot absorb to the oldest debt', () => {
    const data = family([pay(10000, 'care')]);
    expect(owedIn(data, 'care')).toBe(0);
    expect(owedIn(data, 'meals')).toBe(-16550);
  });

  it.each([[undefined], ['care'], ['meals']])(
    'keeps the groups adding up to the overall debt when choosing %s',
    (groupId) => {
      const data = family([pay(10000, groupId)]);
      const overall = balanceTotal(data, { currency: 'CLP' });
      expect(overall).toBe(-16550);
      expect(owedIn(data, 'care') + owedIn(data, 'meals')).toBe(overall);
    },
  );

  it('keeps an overpayment as credit instead of losing it', () => {
    const data = family([pay(30000)]);
    expect(balanceTotal(data, { currency: 'CLP' })).toBe(3450);
  });

  it('marks the debts as paid when a payment goes beyond them', () => {
    const data = family([pay(30000)]);
    for (const item of data.expenses) {
      expect(expenseStanding(data, item).settled, item.id).toBe(true);
    }
  });

  it('shows what is left on a partly paid expense', () => {
    const data = family([pay(10000)]);
    const lunch = data.expenses.find((item) => item.id === 'lunch');
    expect(expenseStanding(data, lunch)).toEqual({ netMinor: -6800, settled: false });
  });

  it('marks everything paid once the whole debt is cleared', () => {
    const data = family([pay(26550)]);
    expect(balancesFor(data, { currency: 'CLP' })).toEqual([]);
    for (const item of data.expenses) {
      expect(expenseStanding(data, item).settled, item.id).toBe(true);
    }
  });

  it('leaves untouched expenses at their full amount', () => {
    const data = family([pay(10000)]);
    const therapy = data.expenses.find((item) => item.id === 'therapy');
    expect(expenseStanding(data, therapy)).toEqual({ netMinor: -60000, settled: false });
  });
});

describe('expenseNet', () => {
  it('is what comes back to me when I paid', () => {
    expect(expenseNet({ payerId: 'me', amountMinor: 300, shares: { me: 150 } }, 'me')).toBe(150);
  });

  it('is what I owe when someone else paid', () => {
    expect(expenseNet({ payerId: 'ana', amountMinor: 300, shares: { me: 150 } }, 'me')).toBe(-150);
  });

  it('is absent when I am not part of it', () => {
    expect(expenseNet({ payerId: 'ana', amountMinor: 300, shares: { ana: 300 } }, 'me')).toBeNull();
  });
});

describe('expensesByMonth', () => {
  it('keeps the newest month first', () => {
    const months = expensesByMonth(
      sortedExpenses([
        expense({ id: 'old', date: '2026-10-04' }),
        expense({ id: 'new', date: '2026-11-14' }),
        expense({ id: 'mid', date: '2026-11-01' }),
      ]),
    );
    expect(months.map((month) => month.key)).toEqual(['2026-11', '2026-10']);
    expect(months[0].expenses.map((item) => item.id)).toEqual(['new', 'mid']);
  });
});
