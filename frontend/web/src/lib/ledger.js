import { convertExact, sumConverted, sumExact } from './money.js';

export const ALL_GROUPS = 'all';

/** The currencies this ledger has rates for, in the order the data lists them. */
export function currenciesOf(ledger) {
  return Object.keys(ledger.rates?.toBase ?? {});
}

/** Today's calendar day in the reader's own time zone, as YYYY-MM-DD. */
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function memberById(ledger, id) {
  return ledger.members.find((member) => member.id === id);
}

export function groupById(ledger, id) {
  return ledger.groups.find((group) => group.id === id);
}

export function expenseById(ledger, id) {
  return ledger.expenses.find((expense) => expense.id === id);
}

/** What this expense means for me: positive comes back to me, negative I owe, null not involved. */
export function expenseNet(expense, me) {
  const share = expense.shares[me];
  if (expense.payerId === me) return expense.amountMinor - (share ?? 0);
  return share == null ? null : -share;
}

/** Newest first, whichever order the data arrives in. */
export function sortedExpenses(expenses) {
  return [...expenses].sort((a, b) => b.date.localeCompare(a.date));
}

export function filterExpenses(expenses, { groupId = ALL_GROUPS, kind = 'all' }) {
  return expenses.filter(
    (expense) =>
      (groupId === ALL_GROUPS || expense.groupId === groupId) &&
      (kind === 'all' || expense.kind === kind),
  );
}

/** Groups already sorted expenses by calendar month, keeping their order. */
export function expensesByMonth(expenses) {
  const months = [];
  for (const expense of expenses) {
    const key = expense.date.slice(0, 7);
    const current = months[months.length - 1];
    if (current?.key === key) current.expenses.push(expense);
    else months.push({ key, date: expense.date, expenses: [expense] });
  }
  return months;
}

// Anything smaller than this, in minor units, is conversion noise rather than money.
const NOISE = 0.01;

// What one expense leaves open between me and one person: positive means they owe me.
function openItems(ledger, otherId) {
  const { me } = ledger;
  const items = [];
  const extras = [];

  for (const expense of ledger.expenses) {
    if (expense.settled) continue;
    const { id: expenseId, currency, date, groupId, payerId, shares } = expense;
    let gross = 0;
    if (payerId === me && shares[otherId]) gross = shares[otherId];
    if (payerId === otherId && shares[me]) gross = -shares[me];
    if (gross !== 0) items.push({ expenseId, groupId, date, currency, gross, remaining: gross });

    for (const payment of expense.payments ?? []) {
      const fromOther = payment.fromId === otherId && payment.toId === me;
      const fromMe = payment.fromId === me && payment.toId === otherId;
      if (fromOther || fromMe) {
        const minor = fromOther ? -payment.amountMinor : payment.amountMinor;
        extras.push({ groupId, minor, currency: payment.currency });
      }
    }
  }
  return { items: items.sort((a, b) => a.date.localeCompare(b.date)), extras };
}

// How much a group can still absorb from a payment in this direction, in the payment's currency.
function groupRoom(state, groupId, direction, currency, rates) {
  const entries = [
    ...state.items
      .filter((item) => item.groupId === groupId)
      .map((item) => ({ minor: item.remaining, currency: item.currency })),
    ...state.extras.filter((extra) => extra.groupId === groupId),
    ...state.credits.filter((credit) => credit.groupId === groupId),
  ];
  const net = sumExact(entries, currency, rates);
  return net == null ? null : Math.max(0, net * direction);
}

/**
 * Applies one payment to the debts it pays off. The API must follow the same rule:
 * the group the person chose goes first, then the oldest debts in any group. A group never takes
 * more than it is owed in total, and what is left over stays as credit.
 */
function applySettlement(state, settlement, rates) {
  const { amountMinor, currency, groupId: chosenId } = settlement;
  const direction = settlement.fromId === state.me ? -1 : 1;
  const debts = state.items.filter((item) => item.remaining * direction > 0);
  const ordered = chosenId
    ? [
        ...debts.filter((item) => item.groupId === chosenId),
        ...debts.filter((item) => item.groupId !== chosenId),
      ]
    : debts;

  let left = amountMinor;
  for (const item of ordered) {
    const owed = convertExact(Math.abs(item.remaining), item.currency, currency, rates);
    const room = groupRoom(state, item.groupId, direction, currency, rates);
    if (owed != null && room != null && left > NOISE) {
      const taken = Math.min(left, owed, room);
      if (taken > 0) {
        item.remaining -= direction * convertExact(taken, currency, item.currency, rates);
        left -= taken;
      }
    }
  }

  if (left > NOISE) {
    const newest = state.items[state.items.length - 1];
    state.credits.push({
      groupId: chosenId ?? newest?.groupId ?? null,
      minor: -direction * left,
      currency,
    });
  }
}

/** Every open debt between me and one person, after the payments recorded so far. */
function pairStanding(ledger, otherId) {
  const state = { me: ledger.me, credits: [], ...openItems(ledger, otherId) };
  const settlements = (ledger.settlements ?? [])
    .filter(
      (item) =>
        (item.fromId === ledger.me && item.toId === otherId) ||
        (item.fromId === otherId && item.toId === ledger.me),
    )
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const settlement of settlements) applySettlement(state, settlement, ledger.rates);

  // Debts and credits that cancel out inside a group close each other. An overpayment is left out
  // of this: it only exists once every debt it could pay has been covered.
  const items = state.items.map((item) => {
    const entries = [
      ...state.items
        .filter((other) => other.groupId === item.groupId)
        .map((other) => ({ minor: other.remaining, currency: other.currency })),
      ...state.extras.filter((extra) => extra.groupId === item.groupId),
    ];
    const groupNet = sumExact(entries, item.currency, ledger.rates);
    const groupIsEven = groupNet != null && Math.abs(groupNet) < NOISE;
    return { ...item, cleared: groupIsEven || Math.abs(item.remaining) < NOISE };
  });
  return { items, extras: [...state.extras, ...state.credits] };
}

// Signed amounts between me and one person: positive means they owe me.
function entriesWith(ledger, otherId, groupId) {
  const { items, extras } = pairStanding(ledger, otherId);
  const inScope = (entry) => groupId === ALL_GROUPS || entry.groupId === groupId;
  return [
    ...items
      .filter((item) => inScope(item) && !item.cleared)
      .map((item) => ({ minor: item.remaining, currency: item.currency })),
    ...extras
      .filter((extra) => inScope(extra) && Math.abs(extra.minor) >= NOISE)
      .map(({ minor, currency }) => ({ minor, currency })),
  ];
}

/** Whether what this person owed on this expense, or was owed, has been paid off. */
export function pairCleared(ledger, expense, otherId) {
  const item = pairStanding(ledger, otherId).items.find(
    (candidate) => candidate.expenseId === expense.id,
  );
  return item?.cleared ?? false;
}

/**
 * What is still open for me on this expense. `netMinor` is the original amount once it is settled,
 * and null when I am not part of the expense.
 */
export function expenseStanding(ledger, expense) {
  const { me } = ledger;
  const gross = expenseNet(expense, me);
  if (gross == null || expense.settled) {
    return { netMinor: gross, settled: Boolean(expense.settled) };
  }

  const others =
    expense.payerId === me
      ? ledger.members.map((member) => member.id).filter((id) => expense.shares[id] && id !== me)
      : [expense.payerId];
  const open = others
    .map((id) => pairStanding(ledger, id).items.find((item) => item.expenseId === expense.id))
    .filter((item) => item && !item.cleared);

  if (others.length > 0 && open.length === 0) return { netMinor: gross, settled: true };
  if (others.length === 0) return { netMinor: gross, settled: false };
  const netMinor = Math.round(open.reduce((sum, item) => sum + item.remaining, 0));
  return { netMinor, settled: false };
}

/**
 * What each person and I owe each other, in `currency`. `netMinor` is null when a rate is missing.
 * People who owe me come first, then the largest debts.
 */
export function balancesFor(ledger, { groupId = ALL_GROUPS, currency }) {
  const rows = ledger.members
    .filter((member) => member.id !== ledger.me)
    .map((member) => {
      const entries = entriesWith(ledger, member.id, groupId);
      return {
        member,
        entries,
        netMinor: sumConverted(entries, currency, ledger.rates),
        homeMinor: sumConverted(entries, member.currency, ledger.rates),
      };
    })
    .filter((row) => row.entries.length > 0 && row.netMinor !== 0);

  return rows.sort((a, b) => {
    if (a.netMinor == null || b.netMinor == null) return a.netMinor == null ? 1 : -1;
    if (a.netMinor > 0 !== b.netMinor > 0) return a.netMinor > 0 ? -1 : 1;
    return Math.abs(b.netMinor) - Math.abs(a.netMinor);
  });
}

/** The sum of every balance in `currency`, or null when any of them cannot be converted. */
export function balanceTotal(ledger, { groupId = ALL_GROUPS, currency }) {
  const entries = balancesFor(ledger, { groupId, currency }).flatMap((row) => row.entries);
  return sumConverted(entries, currency, ledger.rates);
}

/** A share of the expense as a percentage, for expenses that were not split by percent. */
export function sharePercent(expense, memberId) {
  const explicit = expense.percents?.[memberId];
  if (explicit != null) return explicit;
  return ((expense.shares[memberId] ?? 0) * 100) / expense.amountMinor;
}
