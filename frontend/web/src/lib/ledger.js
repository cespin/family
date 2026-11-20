import { sumConverted } from './money.js';

// Reading the ledger that src/lib/expenses.js returns. The API owns balances and payment
// allocation: nothing here works out who owes what, it only converts the standings the API sent
// into the currency the reader chose.

export const ALL_GROUPS = 'all';

/** Today's calendar day in the reader's own time zone, as YYYY-MM-DD. */
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Whether a day typed into a date field can be a transaction date: a real calendar day, today or
 * earlier. A browser lets someone type a day past the field's `max`, so the form checks it too.
 */
export function isTransactionDate(value, today = todayIso()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && value <= today;
}

/** The day an expense's or payment's money changed hands. Older answers carry only `date`. */
export function transactionDateOf(item) {
  return item.transactionDate ?? item.date;
}

export function memberById(ledger, id) {
  return ledger.members.find((member) => member.id === id);
}

export function groupById(ledger, id) {
  return ledger.groups.find((group) => group.id === id);
}

/** The signed-in member. */
export function myself(ledger) {
  return memberById(ledger, ledger.me);
}

/** The conversion table that was in force on an expense's date, or null when none existed. */
export function ratesById(ledger, ratesId) {
  return ledger.rateEntries.find((entry) => entry.id === ratesId) ?? null;
}

/** Groups already sorted expenses by the month their money was spent, keeping their order. */
export function expensesByMonth(expenses) {
  const months = [];
  for (const expense of expenses) {
    const date = transactionDateOf(expense);
    const key = date.slice(0, 7);
    const current = months[months.length - 1];
    if (current?.key === key) current.expenses.push(expense);
    else months.push({ key, date, expenses: [expense] });
  }
  return months;
}

function amountsIn(standing, groupId) {
  return standing.groups.find((group) => group.groupId === groupId)?.amounts ?? [];
}

/**
 * Credit with no group that a group's view shows: only when both of us belong to that group. See
 * "Credit with no group" in docs/frontend-requirements.md.
 */
function ungroupedIn(ledger, standing, groupId) {
  const group = groupById(ledger, groupId);
  const members = group?.memberIds ?? [];
  const shared = members.includes(ledger.me) && members.includes(standing.memberId);
  return shared ? amountsIn(standing, null) : [];
}

/** What is open with one person, in its original currencies: positive means they owe me. */
function entriesOf(ledger, standing, groupId, withUngrouped) {
  if (groupId === ALL_GROUPS) return { entries: standing.overall, ungrouped: [] };
  const ungrouped = withUngrouped ? ungroupedIn(ledger, standing, groupId) : [];
  return { entries: [...amountsIn(standing, groupId), ...ungrouped], ungrouped };
}

/**
 * What each person and I owe each other, in `currency`. `netMinor` is null when a rate is missing,
 * and `homeMinor` is the same balance in that person's own currency. People who owe me come first,
 * then the largest debts.
 *
 * With `withUngrouped`, a group's rows also count credit that belongs to no group, and
 * `ungroupedMinor` is that part in `currency`: 0 when there is none, null when a rate is missing.
 * Leave it off to read only what is held in the group itself.
 */
export function balancesFor(ledger, { groupId = ALL_GROUPS, currency, withUngrouped = false }) {
  const rows = ledger.standings
    .map((standing) => {
      const member = memberById(ledger, standing.memberId);
      const { entries, ungrouped } = entriesOf(ledger, standing, groupId, withUngrouped);
      return {
        member,
        entries,
        netMinor: sumConverted(entries, currency, ledger.rates),
        homeMinor: sumConverted(entries, member.currency, ledger.rates),
        ungroupedMinor: sumConverted(ungrouped, currency, ledger.rates),
      };
    })
    .filter((row) => row.member && row.entries.length > 0 && row.netMinor !== 0);

  return rows.sort((a, b) => {
    if (a.netMinor == null || b.netMinor == null) return a.netMinor == null ? 1 : -1;
    if (a.netMinor > 0 !== b.netMinor > 0) return a.netMinor > 0 ? -1 : 1;
    return Math.abs(b.netMinor) - Math.abs(a.netMinor);
  });
}

/**
 * Everyone an advance can be recorded with: every other active member, in the API's order, even
 * when nothing is open with them. `homeMinor` and `netMinor` are as in `balancesFor`, and a member
 * with no standing is truly even, so their balance is 0. A former member is left out, because an
 * advance is new money; settling up still clears an old debt with them.
 */
export function advanceCandidates(ledger, currency) {
  return ledger.members
    .filter((member) => member.active && member.id !== ledger.me)
    .map((member) => {
      const standing = ledger.standings.find((item) => item.memberId === member.id);
      const entries = standing ? standing.overall : [];
      return {
        member,
        entries,
        netMinor: sumConverted(entries, currency, ledger.rates),
        homeMinor: sumConverted(entries, member.currency, ledger.rates),
      };
    });
}

/**
 * The sum of every balance in `currency`, or null when any of them cannot be converted. It adds
 * the original amounts and rounds once, so it can differ by a minor unit from the rounded rows.
 */
export function balanceTotal(ledger, { groupId = ALL_GROUPS, currency, withUngrouped = false }) {
  const rows = balancesFor(ledger, { groupId, currency, withUngrouped });
  const entries = rows.flatMap((row) => row.entries);
  return sumConverted(entries, currency, ledger.rates);
}

/** A participant's share as a percentage, for expenses that were not split by percent. */
export function sharePercent(expense, participant) {
  if (participant.percent != null) return participant.percent;
  return (participant.shareMinor * 100) / expense.amountMinor;
}
