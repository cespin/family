#!/usr/bin/env node
// Builds the ledger test data set from dataset.mjs and checks it against the schema document.
//
//   node backend/testdata/ledger/build.mjs           writes the generated files
//   node backend/testdata/ledger/build.mjs --check   fails if they are out of date

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE, LEDGER_PK, NOT_REPRESENTED, SCENARIOS, baseLedger, requestCases } from './dataset.mjs';
import {
  allocationSlices,
  appliedPayments,
  creditSlicePaid,
  expenseView,
  pairBalances,
  replay,
  standingsFor,
  sumIn,
} from './replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DOC = join(HERE, '..', '..', 'docs', 'dynamodb-schema.md');

function typed(value) {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'number') return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(typed) };
  return { M: typedMap(value) };
}

function typedMap(object) {
  const entries = Object.entries(object).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries.map(([key, value]) => [key, typed(value)]));
}

const ledgerItem = (SK, attributes) => ({ PK: LEDGER_PK, SK, ...attributes });

/** Every item in the table for this state of the ledger, as plain values. */
function render({ state }) {
  const items = [];

  for (const member of Object.values(state.members)) {
    const { id, alias, invited, ...attributes } = member;
    const key = `ACCOUNT#${member.email}`;
    items.push({ PK: key, SK: 'LINK', memberId: id });
    items.push(ledgerItem(`PROFILE#${id}`, attributes));
    if (invited) {
      items.push({
        PK: `MEMBER#${member.email}`,
        SK: 'PROFILE',
        email: member.email,
        addedAt: '2026-09-01T00:00:00Z',
      });
    }
  }
  for (const alias of state.invited) {
    const email = `${alias}@example.test`;
    items.push({ PK: `MEMBER#${email}`, SK: 'PROFILE', email, addedAt: '2026-11-17T00:00:00Z' });
  }

  items.push(ledgerItem('HEAD', { rev: state.rev, lastWrite: state.lastWrite }));

  for (const { id, alias, ...attributes } of Object.values(state.groups)) {
    items.push(ledgerItem(`GROUP#${id}`, attributes));
  }
  for (const { id, alias, otherAmount, ...attributes } of Object.values(state.expenses)) {
    items.push(
      ledgerItem(`EXPENSE#${id}`, {
        ...attributes,
        otherAmountMinor: otherAmount?.amountMinor,
        otherCurrency: otherAmount?.currency,
      }),
    );
  }
  for (const { id, alias, paid, credited, ...attributes } of Object.values(state.payments)) {
    items.push(
      ledgerItem(`PAYMENT#${id}`, {
        ...attributes,
        paidMinor: paid.amountMinor,
        paidCurrency: paid.currency,
        creditedMinor: credited.amountMinor,
        creditedCurrency: credited.currency,
      }),
    );
  }
  for (const { id, alias, ...attributes } of state.rates) {
    items.push(ledgerItem(`RATE#${id}`, attributes));
  }
  for (const { content, rev } of Object.values(state.derived)) {
    items.push({ ...JSON.parse(content), rev });
  }
  return items;
}

const toLine = (item) => JSON.stringify(typedMap(item));
const jsonl = (items) => `${items.map(toLine).join('\n')}\n`;

// The items a scenario adds or replaces, so that loading it on top of the base data is enough.
function overlay(base, scenario) {
  const before = new Set(render(base).map(toLine));
  return render(scenario).filter((item) => !before.has(toLine(item)));
}

function aliases(ledger) {
  const names = {};
  for (const ids of Object.values(ledger.state.ids)) {
    for (const [alias, id] of Object.entries(ids)) names[id] = alias;
  }
  return names;
}

function describeStandings(pairs, memberId, names) {
  return standingsFor(pairs, memberId)
    .map(({ memberId: other, entries }) => {
      const overall = new Map();
      const groups = new Map();
      for (const { groupId, currency, minor } of entries) {
        overall.set(currency, (overall.get(currency) ?? 0) + minor);
        const name = groupId ? names[groupId] : null;
        const amounts = groups.get(name) ?? new Map();
        amounts.set(currency, (amounts.get(currency) ?? 0) + minor);
        groups.set(name, amounts);
      }
      const list = (map) =>
        [...map].filter(([, minor]) => minor !== 0).map(([currency, amountMinor]) => ({ amountMinor, currency }));
      return {
        member: names[other],
        overall: list(overall),
        groups: [...groups].map(([group, amounts]) => ({ group, amounts: list(amounts) })),
      };
    })
    .sort((a, b) => a.member.localeCompare(b.member));
}

function describeExpense(pairs, ledger, expense, memberId, names) {
  const payments = Object.values(ledger.state.payments);
  const { standing, participants } = expenseView(pairs, expense, memberId);
  return {
    standing,
    participants: Object.fromEntries(participants.map((row) => [names[row.memberId], row.status])),
    shares: Object.fromEntries(Object.entries(expense.shares).map(([id, minor]) => [names[id], minor])),
    appliedPayments: appliedPayments(pairs, payments, expense.id).map((slice) => ({
      payment: names[slice.paymentId],
      from: names[slice.fromId],
      to: names[slice.toId],
      paidMinor: slice.paidMinor,
      paidCurrency: slice.paidCurrency,
      coveredMinor: slice.coveredMinor,
      method: slice.method,
      date: slice.date,
      transactionDate: ledger.state.payments[slice.paymentId].transactionDate,
    })),
  };
}

function ratesOn(ledger, date) {
  const entries = ledger.state.rates.filter((rate) => rate.date <= date);
  return entries[entries.length - 1];
}

/** What the API must return to one caller. */
function describeCaller(ledger, member, pairs, names) {
  const { state } = ledger;
  const groups = Object.values(state.groups).filter((group) => group.memberIds.includes(member.id));
  const visible = new Set(groups.map((group) => group.id));

  // A removed member's balance in that group must be zero, or they could not see what they owe.
  for (const row of standingsFor(pairs, member.id)) {
    for (const entry of row.entries) {
      if (entry.groupId) assert.ok(visible.has(entry.groupId), `${member.alias} has a hidden balance`);
    }
  }

  const expenses = Object.values(state.expenses)
    .filter((expense) => visible.has(expense.groupId))
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || b.seq - a.seq);

  return {
    access: 'allowed',
    memberId: member.id,
    groups: groups.map((group) => group.alias),
    payments: Object.values(state.payments)
      .filter((payment) => payment.fromId === member.id || payment.toId === member.id)
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || b.seq - a.seq)
      .map((payment) => payment.alias),
    standings: describeStandings(pairs, member.id, names),
    lists: {
      all: expenses.map((expense) => expense.alias),
      byGroup: Object.fromEntries(
        groups.map((group) => [
          group.alias,
          expenses.filter((expense) => expense.groupId === group.id).map((expense) => expense.alias),
        ]),
      ),
      byKind: Object.fromEntries(
        ['meal', 'parents', 'gift', 'other'].map((kind) => [
          kind,
          expenses.filter((expense) => expense.kind === kind).map((expense) => expense.alias),
        ]),
      ),
    },
    expenses: expenses.map((expense) => ({
      expense: expense.alias,
      ratesEntry: ratesOn(ledger, expense.date)?.alias ?? null,
      ...describeExpense(pairs, ledger, expense, member.id, names),
    })),
  };
}

function expectedBase(ledger) {
  const { state } = ledger;
  const pairs = ledger.pairs();
  const names = aliases(ledger);
  const callers = {};
  for (const member of Object.values(state.members)) {
    callers[member.alias] = member.invited
      ? describeCaller(ledger, member, pairs, names)
      : { access: 'forbidden', reason: 'removed from the allowlist', memberId: member.id };
  }
  for (const alias of state.invited) {
    callers[alias] = { access: 'forbidden', reason: 'first sign-in step not finished', memberId: null };
  }
  return callers;
}

const CARLOS = 'carlos';
const LUCIA = 'lucia';

function debtLeft(ledger, expenseAlias) {
  const debt = ledger.debt(expenseAlias, CARLOS, LUCIA);
  return debt.closed ? 'settled' : Math.abs(debt.remaining);
}

// Every other member's balance with Carlos per group, in CAD at the current rates.
function groupsInCad(ledger) {
  const rates = ledger.currentRates();
  const byGroup = new Map();
  for (const { entries } of standingsFor(ledger.pairs(), ledger.member(CARLOS))) {
    for (const entry of entries) {
      byGroup.set(entry.groupId, [...(byGroup.get(entry.groupId) ?? []), entry]);
    }
  }
  const names = aliases(ledger);
  const totals = {};
  for (const [groupId, entries] of byGroup) {
    const total = sumIn(entries, 'CAD', rates);
    if (total !== 0) totals[names[groupId] ?? 'none'] = total;
  }
  return totals;
}

function creditWithLucia(ledger) {
  const names = aliases(ledger);
  const key = [ledger.member(CARLOS), ledger.member(LUCIA)].sort().join('|');
  return ledger.pairs().get(key).credits.map((credit) => ({
    minor: credit.minor,
    currency: credit.currency,
    group: names[credit.groupId] ?? null,
  }));
}

/** The published figures. A disagreement here means the replay is wrong, so nothing is written. */
function assertBaseFigures(ledger) {
  const rates = ledger.currentRates();
  const rows = standingsFor(ledger.pairs(), ledger.member(CARLOS));
  const balance = (alias) => rows.find((row) => row.memberId === ledger.member(alias)).entries;

  assert.equal(rows.length, 3, 'Carlos has a balance with exactly three people');
  assert.equal(sumIn(balance('diego'), 'CAD', rates), 7500, 'Diego owes Carlos CAD 75,00');
  assert.equal(sumIn(balance('diego'), 'USD', rates), 5357, 'which is USD 53,57');
  assert.equal(sumIn(balance('lucia'), 'CLP', rates), -26550, 'Carlos owes Lucía CLP 26.550');
  assert.equal(sumIn(balance('lucia'), 'CAD', rates), -3963, 'which is CAD 39,63');
  assert.equal(sumIn(balance('beto'), 'USD', rates), -1200, 'Carlos owes Tío Beto USD 12,00');
  assert.equal(sumIn(balance('beto'), 'CAD', rates), -1680, 'which is CAD 16,80');
  assert.equal(sumIn(rows.flatMap((row) => row.entries), 'CAD', rates), 1857, 'Carlos is owed CAD 18,57');

  const groups = groupsInCad(ledger);
  assert.deepEqual(groups, { meals: -2507, care: 6045, family: -1680 });
  assert.equal(Object.values(groups).reduce((sum, value) => sum + value, 0), 1858, 'groups round to 18,58');

  const shares = (alias) => ledger.state.expenses[ledger.expenseId(alias)].shares;
  const m = ledger.member;
  assert.deepEqual(shares('compra-cad'), { [m('diego')]: 9270, [m('lucia')]: 4635, [m('mama')]: 4635 });
  assert.deepEqual(shares('compra-clp'), { [m('diego')]: 60000, [m('lucia')]: 30000, [m('mama')]: 30000 });
  assert.deepEqual(shares('taxi'), { [m('diego')]: 3334, [m('lucia')]: 3333, [m('mama')]: 3333 });
  assert.deepEqual(shares('farmacia'), { [m('diego')]: 3300, [m('lucia')]: 3300, [m('mama')]: 3401 });
  assert.deepEqual(shares('peaje'), { [m('diego')]: 5000, [m('lucia')]: 5001 });

  const remedios = ledger.debt('remedios', 'mama', LUCIA);
  assert.equal(Math.abs(remedios.remaining), 1800, 'credit paid CLP 3.200 of the CLP 5.000 share');
  assert.equal(ledger.debt('cabana', 'diego', 'beto').closed, true, 'closed by the group net');
  assert.equal(Math.abs(ledger.debt('cena', 'papa', 'mama').remaining), 5000, 'partly paid');
  assert.equal(Math.abs(ledger.debt('pan', 'papa', 'beto').remaining), 2000, 'no rates, so credit waits');
  assert.equal(Math.abs(ledger.debt('flores', 'papa', 'beto').remaining), 700, 'same currency, so it pays');
}

function pairLeft(ledger, expenseAlias, x, y) {
  const debt = ledger.debt(expenseAlias, x, y);
  if (!debt) return 'none';
  return debt.closed ? 'settled' : Math.abs(debt.remaining);
}

function assertGroup(ledger, name, { alias, version, usualSplit }) {
  const group = ledger.state.groups[ledger.group(alias)];
  assert.equal(group.version, version, `${name}: group version`);
  const expected = usualSplit && ledger.percentMap(usualSplit);
  assert.deepEqual(group.usualSplit ?? null, expected, `${name}: usual split`);
}

function assertSeenBy(ledger, name, seenBy) {
  const pairs = ledger.pairs();
  const names = aliases(ledger);
  for (const [alias, { applied, hiddenExpense, hiddenPayment }] of Object.entries(seenBy)) {
    const member = ledger.state.members[ledger.member(alias)];
    const view = describeCaller(ledger, member, pairs, names);
    const [expense, payment, coveredMinor] = applied;
    const row = view.expenses.find((item) => item.expense === expense);
    const slice = row.appliedPayments.find((item) => item.payment === payment);
    assert.equal(slice?.coveredMinor, coveredMinor, `${name}: ${alias} sees the part in their group`);
    assert.ok(!view.expenses.some((item) => item.expense === hiddenExpense), `${name}: hidden expense`);
    assert.ok(!view.payments.includes(hiddenPayment), `${name}: hidden payment`);
  }
}

function assertScenario(ledger, { name, expect }) {
  const { groupsCad, credit, credits, creditCurrency, pairs, group, seenBy, paidSlice, standing, ...debts } = expect;
  for (const [alias, left] of Object.entries(debts)) {
    assert.equal(debtLeft(ledger, alias), left, `${name}: ${alias}`);
  }
  for (const [alias, x, y, left] of pairs ?? []) {
    assert.equal(pairLeft(ledger, alias, x, y), left, `${name}: ${alias} between ${x} and ${y}`);
  }
  if (paidSlice) {
    const [expense, payment, paidMinor] = paidSlice;
    const slices = appliedPayments(ledger.pairs(), Object.values(ledger.state.payments), ledger.expenseId(expense));
    const slice = slices.find((item) => item.paymentId === ledger.id('payment', payment));
    assert.equal(slice?.paidMinor, paidMinor, `${name}: paid amount of the slice`);
  }
  if (standing) {
    const [expense, alias, expected, status] = standing;
    const item = ledger.state.expenses[ledger.expenseId(expense)];
    const view = expenseView(ledger.pairs(), item, ledger.member(alias));
    assert.deepEqual(view.standing, expected, `${name}: standing`);
    const row = view.participants.find((entry) => entry.memberId === ledger.member(alias));
    assert.equal(row.status, status, `${name}: status`);
  }
  if (group) assertGroup(ledger, name, group);
  if (seenBy) assertSeenBy(ledger, name, seenBy);
  if (credits) assert.deepEqual(creditWithLucia(ledger), credits, `${name}: credits`);
  if (groupsCad) {
    const actual = groupsInCad(ledger);
    for (const [group, value] of Object.entries(groupsCad)) {
      assert.equal(actual[group], value, `${name}: balance in ${group}`);
    }
    if (!('meals' in groupsCad)) assert.equal(actual.meals, undefined, `${name}: meals is even`);
  }
  if (credit) assert.deepEqual(creditWithLucia(ledger), [credit], `${name}: credit`);
  if (creditCurrency) {
    assert.equal(creditWithLucia(ledger)[0].currency, creditCurrency, `${name}: credit currency`);
  }
}

// Stored pair state drops closed debts, so replaying without them must give the same answer.
function assertOpenStateIsEnough(ledger, name) {
  const ids = Object.keys(ledger.state.members);
  const full = ledger.pairs();
  const pruned = replay(ids, ledger.events(), { prune: true });
  const payments = Object.values(ledger.state.payments);
  const open = (pair) => ({
    balances: pairBalances(pair),
    debts: pair.debts.filter((debt) => !debt.closed),
    credits: pair.credits,
    newest: pair.newest,
    allocations: allocationSlices(pair, payments).map(({ paymentId, expenseId, coveredMinor, paidMinor }) => ({
      paymentId,
      expenseId,
      coveredMinor,
      paidMinor,
    })),
  });
  for (const [key, pair] of full) {
    assert.deepEqual(open(pruned.get(key)), open(pair), `${name}: open state alone gives a different result`);

    // A slice funded by stored credit must get its paid amount from what the credit item holds.
    const slices = allocationSlices(pair, payments);
    pair.allocations.forEach((allocation, index) => {
      if (allocation.creditBefore) {
        const payment = payments.find((item) => item.id === allocation.paymentId);
        const paid = creditSlicePaid(payment, allocation.creditBefore, allocation.applied);
        assert.equal(paid, slices[index].paidMinor, `${name}: stored credit gives a different paid amount`);
      }
    });
  }
}

// The read protocol depends on these: nothing disappears, and the head names what the write changed.
function assertWriteIsDetectable(base, ledger, name) {
  const items = render(ledger);
  const keys = new Map(items.map((item) => [`${item.PK}|${item.SK}`, item]));
  for (const item of render(base)) {
    assert.ok(keys.has(`${item.PK}|${item.SK}`), `${name}: ${item.PK} ${item.SK} was deleted`);
  }
  for (const { PK, SK } of ledger.state.lastWrite) {
    assert.equal(keys.get(`${PK}|${SK}`)?.rev, ledger.state.rev, `${name}: ${PK} ${SK} is not stamped`);
  }
  const named = new Set(ledger.state.lastWrite.map(({ PK, SK }) => `${PK}|${SK}`));
  for (const item of items.filter((entry) => entry.rev === ledger.state.rev && entry.SK !== 'HEAD')) {
    assert.ok(named.has(`${item.PK}|${item.SK}`), `${name}: the head does not name ${item.PK} ${item.SK}`);
  }
  const newest = Math.max(...items.filter((item) => item.rev !== undefined).map((item) => item.rev));
  assert.equal(newest, ledger.state.rev, `${name}: an item is newer than the head`);
}

function describeScenario(ledger, { name, requirement, description, views = [] }) {
  const pairs = ledger.pairs();
  const names = aliases(ledger);
  const carlos = ledger.state.members[ledger.member(CARLOS)];
  return {
    name,
    requirement,
    description,
    file: `scenarios/${name}.jsonl`,
    head: { rev: ledger.state.rev },
    ids: ledger.state.ids,
    carlos: describeCaller(ledger, carlos, pairs, names),
    otherCallers: Object.fromEntries(
      views.map((alias) => [
        alias,
        describeCaller(ledger, ledger.state.members[ledger.member(alias)], pairs, names),
      ]),
    ),
    creditWithLucia: creditWithLucia(ledger),
    groupBalancesInCad: groupsInCad(ledger),
    writes: ledger.state.writes,
  };
}

/** Compares the attributes the schema document lists with the ones the data set really has. */
function schemaProblems(items) {
  const doc = readFileSync(SCHEMA_DOC, 'utf8');
  const COMMON = ['rev', 'lastRequestId', 'lastRequestHash'];
  const entities = {
    'Family member (allowlist)': (item) => item.PK.startsWith('MEMBER#'),
    'Account link': (item) => item.PK.startsWith('ACCOUNT#'),
    'Ledger head': (item) => item.SK === 'HEAD',
    Member: (item) => item.SK.startsWith('PROFILE#'),
    Group: (item) => item.SK.startsWith('GROUP#'),
    Expense: (item) => item.SK.startsWith('EXPENSE#'),
    Payment: (item) => item.SK.startsWith('PAYMENT#'),
    'Exchange rate': (item) => item.SK.startsWith('RATE#'),
    'Pair state': (item) => item.SK.startsWith('PAIR#'),
    'Pair allocations': (item) => item.SK.startsWith('ALLOC#'),
    'Group expense entry': (item) => item.PK.endsWith('#EXPENSES'),
    'Group kind entry': (item) => item.PK.includes('#KIND#'),
    'Pair payment entry': (item) => item.PK.endsWith('#PAYMENTS'),
  };
  const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

  function documented(entity) {
    const paragraph = doc.match(new RegExp(`^\\*\\*${entity}:\\*\\* (.+?)\\.(?: |$)`, 'm'));
    if (paragraph) return backticked(paragraph[1]);
    const row = doc.split('\n').find((line) => line.startsWith(`| ${entity} |`));
    return row ? backticked(row.split('|')[4]) : null;
  }

  const problems = [];
  for (const [entity, matches] of Object.entries(entities)) {
    const listed = documented(entity);
    const hasRow = doc.split('\n').some((line) => line.startsWith(`| ${entity} |`));
    if (!listed || !hasRow) {
      problems.push(`${entity}: not found in docs/dynamodb-schema.md`);
    } else {
      const own = items.filter(matches);
      const ignored = entity === 'Ledger head' || !own[0]?.PK.startsWith(LEDGER_PK) ? [] : COMMON;
      const present = new Set(own.flatMap((item) => Object.keys(item)));
      ['PK', 'SK', ...ignored].forEach((name) => present.delete(name));
      const expected = new Set(listed);
      for (const name of expected) {
        if (!present.has(name)) problems.push(`${entity}: documented attribute \`${name}\` has no test data`);
      }
      for (const name of present) {
        if (!expected.has(name)) problems.push(`${entity}: test data has undocumented attribute \`${name}\``);
      }
    }
  }
  return problems;
}

function coverageDocument() {
  const rows = COVERAGE.map(([section, requirement, where]) => `| ${section} | ${requirement} | ${where} |`);
  return [
    '# Requirement coverage',
    '',
    'Generated by `build.mjs` from `COVERAGE` in `dataset.mjs`. Sections refer to `docs/frontend-requirements.md`.',
    '',
    '| Section | Requirement | Where |',
    '|---|---|---|',
    ...rows,
    '',
    '## Not represented',
    '',
    'Stored data cannot show these, so they need their own tests.',
    '',
    '| Section | Requirement | How to test it |',
    '|---|---|---|',
    ...NOT_REPRESENTED.map(([section, requirement, how]) => `| ${section} | ${requirement} | ${how} |`),
    '',
  ].join('\n');
}

function assertCoverageNamesExist(ledger) {
  const known = new Set([
    ...Object.values(ledger.state.ids).flatMap((ids) => Object.keys(ids)),
    ...ledger.state.invited,
    ...SCENARIOS.map((scenario) => scenario.name),
    'requests.json',
    'expected.json',
    'callers',
    'lists',
  ]);
  for (const [, requirement, where] of COVERAGE) {
    for (const [, name] of where.matchAll(/`([^`]+)`/g)) {
      assert.ok(known.has(name), `coverage for "${requirement}" names unknown \`${name}\``);
    }
  }
}

// The page orders in requests.json are written by hand, so check them against the data.
function assertRequestLists(ledger, cases) {
  const pairs = ledger.pairs();
  const names = aliases(ledger);
  for (const { name, caller, path, expect } of cases.filter((item) => item.expect.expenses)) {
    const member = ledger.state.members[ledger.member(caller)];
    const view = describeCaller(ledger, member, pairs, names);
    const query = new URL(path, 'http://local').searchParams;
    const kind = query.get('kind');
    const groupId = query.get('groupId');
    const matching = view.expenses
      .map((row) => ledger.state.expenses[ledger.expenseId(row.expense)])
      .filter((item) => (!kind || item.kind === kind) && (!groupId || item.groupId === groupId))
      .map((item) => item.id);
    const limit = Number(query.get('limit') ?? 50);
    assert.deepEqual(expect.expenses, matching.slice(0, limit), `request "${name}": page`);
    assert.equal(expect.morePages, matching.length > limit, `request "${name}": more pages`);
  }
  for (const { name, caller, path, expect } of cases.filter((item) => item.expect.payments)) {
    const member = ledger.state.members[ledger.member(caller)];
    const query = new URL(path, 'http://local').searchParams;
    const other = query.get('memberId');
    const matching = describeCaller(ledger, member, pairs, names)
      .payments.map((alias) => ledger.state.payments[ledger.id('payment', alias)])
      .filter((item) => !other || item.fromId === other || item.toId === other)
      .map((item) => item.id);
    const limit = Number(query.get('limit') ?? 50);
    assert.deepEqual(expect.payments, matching.slice(0, limit), `request "${name}": page`);
    assert.equal(expect.morePages, matching.length > limit, `request "${name}": more pages`);
  }
}

function buildFiles() {
  const base = baseLedger();
  assertBaseFigures(base);
  assertOpenStateIsEnough(base, 'base data');
  assertCoverageNamesExist(base);

  const items = render(base);
  const problems = schemaProblems(items);
  if (problems.length > 0) {
    throw new Error(`The data set and docs/dynamodb-schema.md disagree:\n  ${problems.join('\n  ')}`);
  }

  const files = new Map();
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    const ledger = base.clone();
    ledger.state.writes = [];
    scenario.apply(ledger);
    assertScenario(ledger, scenario);
    assertOpenStateIsEnough(ledger, scenario.name);
    assertWriteIsDetectable(base, ledger, scenario.name);
    files.set(`scenarios/${scenario.name}.jsonl`, jsonl(overlay(base, ledger)));
    scenarios.push(describeScenario(ledger, scenario));
  }

  const requests = requestCases(base);
  assertRequestLists(base, requests);

  const expected = {
    table: {
      pk: LEDGER_PK,
      head: { rev: base.state.rev, lastWrite: base.state.lastWrite },
    },
    ids: base.state.ids,
    callers: expectedBase(base),
    scenarios,
  };
  files.set('items.jsonl', jsonl(items));
  files.set('expected.json', `${JSON.stringify(expected, null, 2)}\n`);
  files.set('requests.json', `${JSON.stringify(requests, null, 2)}\n`);
  files.set('COVERAGE.md', coverageDocument());
  return files;
}

function outOfDate(files) {
  const stale = [];
  for (const [path, content] of files) {
    let current = null;
    try {
      current = readFileSync(join(HERE, path), 'utf8');
    } catch {
      // A missing file is reported below as out of date.
    }
    if (current !== content) stale.push(path);
  }
  const onDisk = readdirSync(join(HERE, 'scenarios'), { withFileTypes: true }).map(
    (entry) => `scenarios/${entry.name}`,
  );
  return [...stale, ...onDisk.filter((path) => !files.has(path))];
}

const files = buildFiles();

if (process.argv.includes('--check')) {
  const stale = outOfDate(files);
  if (stale.length > 0) {
    console.error(`Out of date, run node backend/testdata/ledger/build.mjs:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`ledger test data: ${files.size} files are up to date and match the schema document`);
} else {
  rmSync(join(HERE, 'scenarios'), { recursive: true, force: true });
  mkdirSync(join(HERE, 'scenarios'));
  for (const [path, content] of files) writeFileSync(join(HERE, path), content);
  console.log(`ledger test data: wrote ${files.size} files`);
}
