// The story behind the data set: every write the family made, in the order they made it. build.mjs
// turns it into DynamoDB items and expected results. To change the data, change it here.

import { createHash } from 'node:crypto';
import {
  allocationSlices,
  debtBetween,
  pairBalances,
  replay,
  splitEqual,
  splitPercent,
  standingsFor,
  withinTolerance,
} from './replay.mjs';

const PREFIX = { member: 'a', group: 'b', expense: 'c', payment: 'd', rate: 'e', request: 'f' };
const LIMITS = { CAD: 1000000, USD: 1000000, CLP: 10000000 };
export const LEDGER_PK = 'LEDGER#main';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash stored as `lastRequestHash`: SHA-256 of the body with sorted keys and no whitespace. */
export const requestHash = (body) => createHash('sha256').update(canonical(body)).digest('hex');

const stamp = (date, seq) => `${date}T12:${String(seq % 60).padStart(2, '0')}:00Z`;

export class Ledger {
  constructor(state) {
    this.state = state ?? {
      rev: 0,
      lastWrite: [],
      derived: {},
      counters: {},
      ids: { member: {}, group: {}, expense: {}, payment: {}, rate: {} },
      members: {},
      invited: [],
      groups: {},
      expenses: {},
      payments: {},
      rates: [],
      bodies: {},
    };
  }

  clone() {
    return new Ledger(structuredClone(this.state));
  }

  newId(kind, alias) {
    const { counters, ids } = this.state;
    counters[kind] = (counters[kind] ?? 0) + 1;
    const number = String(counters[kind]).padStart(12, '0');
    const id = `${PREFIX[kind]}0000000-0000-4000-8000-${number}`;
    if (alias) ids[kind][alias] = id;
    return id;
  }

  id(kind, alias) {
    const id = this.state.ids[kind][alias];
    if (!id) throw new Error(`unknown ${kind}: ${alias}`);
    return id;
  }

  member = (alias) => this.id('member', alias);
  group = (alias) => this.id('group', alias);
  expenseId = (alias) => this.id('expense', alias);

  // Scenarios keep the requests behind their writes, so tests can send them through the API.
  record(by, method, path, body) {
    this.state.writes?.push({ caller: this.state.members[by].alias, method, path, body });
  }

  commit(sortKeys) {
    this.state.rev += 1;
    this.state.lastWrite = sortKeys.map((SK) => ({ PK: LEDGER_PK, SK }));
    return this.state.rev;
  }

  /** The items worked out from expenses and payments: pair state, allocations and list entries. */
  derivedItems() {
    const { expenses, payments } = this.state;
    const paymentList = Object.values(payments);
    const items = [];

    for (const pair of this.pairs().values()) {
      const { low, high, newest } = pair;
      items.push({
        PK: LEDGER_PK,
        SK: `PAIR#${low}#${high}`,
        balances: pairBalances(pair),
        openDebts: pair.debts
          .filter((debt) => !debt.closed)
          .map(({ expenseId, groupId, date, seq, currency, gross, remaining }) => ({
            expenseId,
            groupId,
            date,
            seq,
            currency,
            grossMinor: gross,
            remainingMinor: remaining,
          })),
        credits: pair.credits
          .filter((credit) => credit.minor !== 0)
          .map(({ paymentId, seq, minor, currency, groupId, applied }) => ({
            paymentId,
            seq,
            amountMinor: minor,
            currency,
            groupId: groupId ?? undefined,
            appliedTotal: `${applied.n}/${applied.d}`,
          })),
        newestDebt: newest ?? undefined,
      });

      const byYear = new Map();
      for (const slice of allocationSlices(pair, paymentList)) {
        const year = expenses[slice.expenseId].date.slice(0, 4);
        byYear.set(year, [...(byYear.get(year) ?? []), slice]);
      }
      for (const [year, allocations] of byYear) {
        items.push({ PK: LEDGER_PK, SK: `ALLOC#${low}#${high}#${year}`, allocations });
      }
    }

    for (const expense of Object.values(expenses)) {
      const {
        id,
        title,
        kind,
        groupId,
        payerId,
        addedBy,
        amountMinor,
        currency,
        date,
        transactionDate,
        participantIds,
        splitMode,
        shares,
        percents,
        seq,
      } = expense;
      const SK = `${transactionDate}#${String(seq).padStart(8, '0')}`;
      const entry = {
        expenseId: id,
        title,
        kind,
        groupId,
        payerId,
        addedBy,
        amountMinor,
        currency,
        date,
        transactionDate,
        participantIds,
        splitMode,
        shares,
        ...(percents ? { percents } : {}),
        seq,
      };
      items.push({ PK: `GROUP#${groupId}#EXPENSES`, SK, ...entry });
      items.push({ PK: `GROUP#${groupId}#KIND#${kind}`, SK, ...entry });
    }

    for (const payment of paymentList) {
      const [low, high] = [payment.fromId, payment.toId].sort();
      items.push({
        PK: `PAIR#${low}#${high}#PAYMENTS`,
        SK: `${payment.transactionDate}#${String(payment.seq).padStart(8, '0')}`,
        paymentId: payment.id,
        fromId: payment.fromId,
        toId: payment.toId,
        paidMinor: payment.paid.amountMinor,
        paidCurrency: payment.paid.currency,
        creditedMinor: payment.credited.amountMinor,
        creditedCurrency: payment.credited.currency,
        method: payment.method,
        date: payment.date,
        transactionDate: payment.transactionDate,
        groupId: payment.groupId,
        version: payment.version,
        seq: payment.seq,
      });
    }
    return items;
  }

  // Stamps what this write changed, the way the write protocol does.
  refreshDerived() {
    const { state } = this;
    const next = {};
    for (const item of this.derivedItems()) {
      const key = `${item.PK}|${item.SK}`;
      const content = JSON.stringify(item);
      if (state.derived[key]?.content === content) {
        next[key] = state.derived[key];
      } else {
        next[key] = { content, rev: state.rev };
        state.lastWrite.push({ PK: item.PK, SK: item.SK });
      }
    }
    // An item that no longer applies is overwritten, never deleted, so that a read caught in the
    // middle of this write sees the new revision and retries.
    for (const [key, known] of Object.entries(state.derived)) {
      if (!next[key]) {
        const [PK, SK] = key.split('|');
        const content = JSON.stringify({ PK, SK, removed: true });
        next[key] = known.content === content ? known : { content, rev: state.rev };
        if (known.content !== content) state.lastWrite.push({ PK, SK });
      }
    }
    state.derived = next;
  }

  currentRates() {
    const latest = this.state.rates[this.state.rates.length - 1];
    return latest ? { usdCad: latest.usdCad, cadClp: latest.cadClp } : undefined;
  }

  events() {
    const expenses = Object.values(this.state.expenses).map((item) => ({ ...item, type: 'expense' }));
    const payments = Object.values(this.state.payments).map((item) => ({ ...item, type: 'payment' }));
    return [...expenses, ...payments];
  }

  pairs() {
    return replay(Object.keys(this.state.members), this.events());
  }

  invite(alias) {
    this.state.invited.push(alias);
  }

  profile(alias, { displayName, homeCurrency, tone, invited = true }) {
    const id = this.newId('member', alias);
    const rev = this.commit([`PROFILE#${id}`]);
    this.state.members[id] = {
      id,
      alias,
      displayName,
      homeCurrency,
      tone,
      email: `${alias}@example.test`,
      createdAt: `2026-09-01T12:${String(rev).padStart(2, '0')}:00Z`,
      invited,
      rev,
    };
  }

  createGroup(alias, { name, by, members, usualSplit }) {
    const id = this.newId('group', alias);
    const requestId = id;
    const memberIds = members.map(this.member);
    const split = usualSplit && this.percentMap(usualSplit);
    const body = { requestId, name, memberIds, usualSplit: split };
    const rev = this.commit([`GROUP#${id}`]);
    this.record(this.member(by), 'POST', '/api/groups', body);
    this.state.bodies[alias] = body;
    this.state.groups[id] = {
      id,
      alias,
      name,
      createdBy: this.member(by),
      memberIds,
      usualSplit: split,
      version: 1,
      seq: rev,
      rev,
      lastRequestId: requestId,
      lastRequestHash: requestHash(body),
    };
  }

  /** Renames a group or changes its members, following the rules in section 7. */
  updateGroup(alias, { name, members }) {
    const group = this.state.groups[this.group(alias)];
    const memberIds = members ? members.map(this.member) : group.memberIds;
    const removed = group.memberIds.filter((id) => !memberIds.includes(id));

    const pairs = this.pairs();
    for (const memberId of removed) {
      const open = standingsFor(pairs, memberId).flatMap((row) =>
        row.entries.filter((entry) => entry.groupId === group.id),
      );
      if (open.length > 0) throw new Error(`${alias}: removed member still has an open balance`);
    }

    let usualSplit = group.usualSplit;
    if (removed.length > 0) usualSplit = undefined;
    else if (usualSplit) {
      usualSplit = Object.fromEntries(memberIds.map((id) => [id, usualSplit[id] ?? 0]));
    }

    const requestId = this.newId('request');
    const version = group.version;
    const body = { requestId, name: name ?? group.name, memberIds, usualSplit, version };
    const rev = this.commit([`GROUP#${group.id}`]);
    this.record(group.createdBy, 'PUT', `/api/groups/${group.id}`, body);
    Object.assign(group, {
      name: body.name,
      memberIds,
      usualSplit,
      version: version + 1,
      rev,
      lastRequestId: requestId,
      lastRequestHash: requestHash(body),
    });
  }

  enterRates(alias, { by, usdCad, cadClp, date }) {
    const id = this.newId('rate', alias);
    const body = { requestId: id, usdCad, cadClp, date };
    const latest = this.state.rates[this.state.rates.length - 1]?.date ?? date;
    const effective = date < latest ? latest : date;
    const rev = this.commit([`RATE#${id}`]);
    this.record(this.member(by), 'POST', '/api/exchange-rates', body);
    this.state.rates.push({
      id,
      alias,
      usdCad,
      cadClp,
      date: effective,
      enteredBy: this.member(by),
      seq: rev,
      rev,
      lastRequestId: id,
      lastRequestHash: requestHash(body),
    });
  }

  percentMap(percents) {
    return Object.fromEntries(Object.entries(percents).map(([alias, value]) => [this.member(alias), value]));
  }

  // Participants in group order. Someone who left the group stays where the expense had them.
  orderedParticipants(group, participantIds, previous = []) {
    const order = [...group.memberIds, ...previous.filter((id) => !group.memberIds.includes(id))];
    return order.filter((id) => participantIds.includes(id));
  }

  computeShares(amountMinor, participantIds, splitMode, percents) {
    return splitMode === 'equal'
      ? splitEqual(amountMinor, participantIds)
      : splitPercent(amountMinor, participantIds, percents);
  }

  checkExpense({ title, note, amountMinor, currency, otherAmount, splitMode, percents, participantIds }) {
    if (title.trim().length === 0 || title.length > 40) throw new Error(`bad title: ${title}`);
    if ((note ?? '').length > 200) throw new Error(`bad note: ${title}`);
    if (amountMinor <= 0 || amountMinor > LIMITS[currency]) throw new Error(`bad amount: ${title}`);
    if (otherAmount && otherAmount.currency === currency) throw new Error(`same currency: ${title}`);
    if (otherAmount && otherAmount.amountMinor > LIMITS[otherAmount.currency]) {
      throw new Error(`bad second amount: ${title}`);
    }
    if (splitMode === 'percent') {
      const sum = participantIds.reduce((total, id) => total + percents[id], 0);
      if (sum !== 100) throw new Error(`percentages must add up to 100: ${title}`);
    }
  }

  addExpense(alias, input) {
    const { by, payer, group: groupAlias, participants, percents, usualSplit, ...fields } = input;
    const id = this.newId('expense', alias);
    const group = this.state.groups[this.group(groupAlias)];
    const participantIds = this.orderedParticipants(group, participants.map(this.member));
    const percentById = percents && this.percentMap(percents);
    const splitMode = percents ? 'percent' : 'equal';
    this.checkExpense({ ...fields, splitMode, percents: percentById, participantIds });

    const split = usualSplit && this.percentMap(usualSplit);
    const body = {
      requestId: id,
      title: fields.title,
      kind: fields.kind,
      groupId: group.id,
      payerId: this.member(payer),
      amountMinor: fields.amountMinor,
      currency: fields.currency,
      date: fields.date,
      transactionDate: fields.transactionDate,
      splitMode,
      participantIds,
      percents: percentById,
      otherAmount: fields.otherAmount,
      chargedCurrency: fields.chargedCurrency,
      note: fields.note,
      usualSplit: split,
    };
    const keys = [`EXPENSE#${id}`, ...(split ? [`GROUP#${group.id}`] : [])];
    const rev = this.commit(keys);
    const hash = requestHash(body);
    this.record(this.member(by ?? payer), 'POST', '/api/expenses', body);
    this.state.bodies[alias] = body;
    this.state.expenses[id] = {
      ...fields,
      // A browser that predates transaction dates sends none, and the entry day stands in.
      transactionDate: fields.transactionDate ?? fields.date,
      id,
      alias,
      groupId: group.id,
      payerId: body.payerId,
      addedBy: this.member(by ?? payer),
      splitMode,
      participantIds,
      percents: percentById,
      shares: this.computeShares(fields.amountMinor, participantIds, splitMode, percentById),
      recordedRates: this.currentRates(),
      recordedAt: stamp(fields.date, rev),
      version: 1,
      seq: rev,
      rev,
      lastRequestId: id,
      lastRequestHash: hash,
    };
    if (split) {
      Object.assign(group, {
        usualSplit: split,
        version: group.version + 1,
        rev,
        lastRequestId: id,
        lastRequestHash: hash,
      });
    }
  }

  /**
   * An edit keeps the entry date, who added it, its place in the replay and the rates it recorded.
   * It may change the transaction date, which only moves where the expense is listed.
   */
  editExpense(alias, changes) {
    const expense = this.state.expenses[this.expenseId(alias)];
    const updated = { ...expense, ...changes };
    updated.shares = this.computeShares(
      updated.amountMinor,
      updated.participantIds,
      updated.splitMode,
      updated.percents,
    );
    this.checkExpense(updated);

    const requestId = this.newId('request');
    const body = {
      requestId,
      title: updated.title,
      kind: updated.kind,
      groupId: updated.groupId,
      payerId: updated.payerId,
      amountMinor: updated.amountMinor,
      currency: updated.currency,
      transactionDate: changes.transactionDate,
      splitMode: updated.splitMode,
      participantIds: updated.participantIds,
      percents: updated.percents,
      otherAmount: updated.otherAmount,
      chargedCurrency: updated.chargedCurrency,
      note: updated.note,
      version: expense.version,
    };
    const rev = this.commit([`EXPENSE#${expense.id}`]);
    this.record(expense.addedBy, 'PUT', `/api/expenses/${expense.id}`, body);
    this.state.expenses[expense.id] = {
      ...updated,
      version: expense.version + 1,
      rev,
      lastRequestId: requestId,
      lastRequestHash: requestHash(body),
    };
  }

  pay(alias, { from, to, amountMinor, currency, method, date, transactionDate, group, credited, by }) {
    const id = this.newId('payment', alias);
    const paid = { amountMinor, currency };
    const rates = this.currentRates();
    const accepted = credited && withinTolerance(paid, credited, rates) ? credited : paid;
    const groupId = group ? this.group(group) : undefined;
    const body = {
      requestId: id,
      fromId: this.member(from),
      toId: this.member(to),
      paid,
      credited,
      method,
      date,
      transactionDate,
      groupId,
    };
    const rev = this.commit([`PAYMENT#${id}`]);
    this.record(this.member(by ?? from), 'POST', '/api/payments', body);
    this.state.bodies[alias] = body;
    this.state.payments[id] = {
      id,
      alias,
      fromId: body.fromId,
      toId: body.toId,
      paid,
      credited: accepted,
      method,
      date,
      transactionDate: transactionDate ?? date,
      groupId,
      recordedRates: rates,
      recordedBy: this.member(by ?? from),
      recordedAt: stamp(date, rev),
      version: 1,
      seq: rev,
      rev,
      lastRequestId: id,
      lastRequestHash: requestHash(body),
    };
  }

  /** Corrects the day a payment's money was given. Nothing else about it can change. */
  editPayment(alias, { transactionDate, by }) {
    const payment = this.state.payments[this.id('payment', alias)];
    const requestId = this.newId('request');
    const body = { requestId, transactionDate, version: payment.version };
    const rev = this.commit([`PAYMENT#${payment.id}`]);
    this.record(by ? this.member(by) : payment.recordedBy, 'PUT', `/api/payments/${payment.id}`, body);
    Object.assign(payment, {
      transactionDate,
      version: payment.version + 1,
      rev,
      lastRequestId: requestId,
      lastRequestHash: requestHash(body),
    });
  }

  debt(expenseAlias, x, y) {
    return debtBetween(this.pairs(), this.expenseId(expenseAlias), this.member(x), this.member(y));
  }
}

for (const name of [
  'profile',
  'createGroup',
  'updateGroup',
  'enterRates',
  'addExpense',
  'editExpense',
  'pay',
  'editPayment',
]) {
  const write = Ledger.prototype[name];
  Ledger.prototype[name] = function writeAndStamp(...args) {
    write.apply(this, args);
    this.refreshDerived();
  };
}

/** The family as it stands at the start of the worked example in section 6. */
export function baseLedger() {
  const l = new Ledger();

  l.profile('carlos', { displayName: 'Carlos', homeCurrency: 'CAD', tone: 'honey' });
  l.profile('lucia', { displayName: 'Lucía', homeCurrency: 'CLP', tone: 'clay' });
  l.profile('diego', { displayName: 'Diego', homeCurrency: 'USD', tone: 'lagoon' });
  l.profile('mama', { displayName: 'Mamá', homeCurrency: 'CLP', tone: 'sage' });
  l.profile('papa', { displayName: 'Papá', homeCurrency: 'CLP', tone: 'cocoa' });
  l.profile('beto', { displayName: 'Tío Beto', homeCurrency: 'USD' });
  l.profile('rosa', { displayName: 'Rosa', homeCurrency: 'CLP', tone: 'clay', invited: false });
  l.invite('nina');

  l.createGroup('family', {
    name: 'Toda la familia',
    by: 'carlos',
    members: ['carlos', 'lucia', 'diego', 'mama', 'papa', 'beto'],
  });
  l.createGroup('meals', {
    name: 'Comidas familiares',
    by: 'lucia',
    members: ['carlos', 'lucia', 'diego', 'mama', 'papa'],
  });
  l.createGroup('care', {
    name: 'Cuidado de Mamá y Papá',
    by: 'carlos',
    members: ['carlos', 'lucia', 'diego'],
    usualSplit: { carlos: 50, lucia: 25, diego: 25 },
  });
  l.createGroup('club', { name: 'Club de lectura', by: 'rosa', members: ['rosa', 'mama'] });

  // Recorded before anyone entered rates.
  l.addExpense('te', {
    title: 'Té para la once',
    kind: 'meal',
    group: 'family',
    payer: 'mama',
    amountMinor: 10000,
    currency: 'CLP',
    date: '2026-09-20',
    participants: ['mama', 'papa'],
  });

  // With no rates yet, Papá's credit in dollars cannot pay a debt in pesos, so it waits. The flowers
  // are in dollars, so it pays part of those later.
  l.pay('papa-beto', {
    from: 'papa',
    to: 'beto',
    amountMinor: 500,
    currency: 'USD',
    method: 'cash',
    date: '2026-09-21',
  });
  l.addExpense('pan', {
    title: 'Pan amasado',
    kind: 'meal',
    group: 'family',
    payer: 'beto',
    amountMinor: 4000,
    currency: 'CLP',
    date: '2026-09-22',
    participants: ['papa', 'beto'],
  });

  l.enterRates('october', { by: 'carlos', usdCad: '1.38', cadClp: '660', date: '2026-10-01' });

  l.addExpense('calefon', {
    title: 'Arreglo del calefón',
    kind: 'parents',
    group: 'care',
    payer: 'carlos',
    amountMinor: 210000,
    currency: 'CLP',
    date: '2026-10-04',
    participants: ['carlos', 'lucia', 'diego'],
    percents: { carlos: 50, lucia: 25, diego: 25 },
  });
  l.pay('lucia-calefon', {
    from: 'lucia',
    to: 'carlos',
    amountMinor: 52500,
    currency: 'CLP',
    method: 'transfer',
    date: '2026-10-05',
    group: 'care',
  });
  // Paid in dollars, credited at the debt's exact value because it is within tolerance.
  l.pay('diego-calefon', {
    from: 'diego',
    to: 'carlos',
    amountMinor: 5764,
    currency: 'USD',
    method: 'transfer',
    date: '2026-10-06',
    group: 'care',
    credited: { amountMinor: 52500, currency: 'CLP' },
  });

  l.addExpense('cena', {
    title: 'Cena de cumpleaños de Papá',
    kind: 'meal',
    group: 'family',
    payer: 'mama',
    amountMinor: 150000,
    currency: 'CLP',
    date: '2026-10-11',
    participants: ['carlos', 'lucia', 'diego', 'mama', 'papa', 'beto'],
  });
  for (const [from, method] of [['carlos', 'transfer'], ['lucia', 'cash'], ['diego', 'other'], ['beto', 'cash']]) {
    l.pay(`${from}-cena`, {
      from,
      to: 'mama',
      amountMinor: 25000,
      currency: 'CLP',
      method,
      date: '2026-10-12',
    });
  }
  // Oldest first: CLP 5.000 closes the tea, and CLP 20.000 leaves the dinner partly paid.
  l.pay('papa-cena', {
    from: 'papa',
    to: 'mama',
    amountMinor: 25000,
    currency: 'CLP',
    method: 'cash',
    date: '2026-10-13',
    by: 'mama',
  });

  // Credit between two people who share no expense belongs to no group.
  l.pay('papa-rosa', {
    from: 'papa',
    to: 'rosa',
    amountMinor: 2000,
    currency: 'CLP',
    method: 'cash',
    date: '2026-10-14',
  });

  // Beto joins this trip, is paid back and then leaves the group.
  l.createGroup('trip', {
    name: 'Viaje a Pucón',
    by: 'diego',
    members: ['diego', 'lucia', 'beto'],
    usualSplit: { diego: 50, lucia: 25, beto: 25 },
  });
  l.addExpense('cabana', {
    title: 'Cabaña en Pucón',
    kind: 'other',
    group: 'trip',
    payer: 'beto',
    amountMinor: 9000,
    currency: 'USD',
    date: '2026-10-20',
    participants: ['diego', 'lucia', 'beto'],
  });
  l.addExpense('gasolina', {
    title: 'Gasolina del viaje',
    kind: 'other',
    group: 'trip',
    payer: 'diego',
    amountMinor: 3000,
    currency: 'USD',
    date: '2026-10-21',
    participants: ['diego', 'lucia', 'beto'],
  });
  l.pay('lucia-cabana', {
    from: 'lucia',
    to: 'beto',
    amountMinor: 3000,
    currency: 'USD',
    method: 'transfer',
    date: '2026-10-22',
    group: 'trip',
  });
  l.pay('lucia-gasolina', {
    from: 'lucia',
    to: 'diego',
    amountMinor: 1000,
    currency: 'USD',
    method: 'transfer',
    date: '2026-10-22',
    group: 'trip',
  });
  // Diego owes USD 30,00 and is owed USD 10,00, so USD 20,00 brings the group's net to zero.
  l.pay('diego-cabana', {
    from: 'diego',
    to: 'beto',
    amountMinor: 2000,
    currency: 'USD',
    method: 'transfer',
    date: '2026-10-23',
    group: 'trip',
  });
  l.updateGroup('trip', { members: ['diego', 'lucia'] });
  l.updateGroup('trip', { members: ['diego', 'lucia', 'mama'] });

  l.enterRates('november-first', { by: 'lucia', usdCad: '1.39', cadClp: '668', date: '2026-11-01' });
  l.enterRates('november', { by: 'diego', usdCad: '1.40', cadClp: '670', date: '2026-11-01' });

  l.addExpense('pizzas', {
    title: 'Pizzas en casa de Mamá',
    kind: 'meal',
    group: 'meals',
    payer: 'papa',
    amountMinor: 45000,
    currency: 'CLP',
    date: '2026-11-01',
    participants: ['carlos', 'lucia', 'diego', 'mama', 'papa'],
  });
  for (const from of ['carlos', 'lucia', 'diego', 'mama']) {
    l.pay(`${from}-pizzas`, {
      from,
      to: 'papa',
      amountMinor: 9000,
      currency: 'CLP',
      method: 'transfer',
      date: '2026-11-02',
      group: 'meals',
    });
  }

  // Added by someone who has since lost access, and the payer is not a participant.
  l.addExpense('libro', {
    title: 'Libro del club',
    kind: 'other',
    group: 'club',
    payer: 'rosa',
    amountMinor: 16000,
    currency: 'CLP',
    date: '2026-11-03',
    participants: ['mama'],
  });

  l.addExpense('flores', {
    title: 'Flores para el cumpleaños de Mamá',
    kind: 'gift',
    group: 'family',
    payer: 'beto',
    amountMinor: 6000,
    currency: 'USD',
    date: '2026-11-06',
    participants: ['carlos', 'lucia', 'diego', 'papa', 'beto'],
  });
  l.addExpense('almuerzo', {
    title: 'Almuerzo familiar del domingo',
    kind: 'meal',
    group: 'meals',
    payer: 'lucia',
    amountMinor: 84000,
    currency: 'CLP',
    date: '2026-11-08',
    participants: ['carlos', 'lucia', 'diego', 'mama', 'papa'],
  });

  // Mamá overpays by CLP 3.200, and that credit pays part of the next expense she shares with Lucía.
  l.pay('mama-almuerzo', {
    from: 'mama',
    to: 'lucia',
    amountMinor: 20000,
    currency: 'CLP',
    method: 'cash',
    date: '2026-11-09',
  });
  l.addExpense('remedios', {
    title: 'Remedios de Mamá',
    kind: 'parents',
    group: 'meals',
    payer: 'lucia',
    amountMinor: 10000,
    currency: 'CLP',
    date: '2026-11-10',
    participants: ['lucia', 'mama'],
  });

  l.addExpense('tablet', {
    title: 'Tablet para las videollamadas',
    kind: 'parents',
    group: 'care',
    payer: 'carlos',
    amountMinor: 30000,
    currency: 'CAD',
    date: '2026-11-12',
    participants: ['carlos', 'lucia', 'diego'],
    percents: { carlos: 50, lucia: 25, diego: 25 },
  });
  l.addExpense('kinesiologia', {
    title: 'Kinesiología de Mamá',
    kind: 'parents',
    group: 'care',
    payer: 'lucia',
    amountMinor: 120000,
    currency: 'CLP',
    date: '2026-11-14',
    participants: ['carlos', 'lucia', 'diego'],
    percents: { carlos: 50, lucia: 25, diego: 25 },
    note: 'Sesión 2 de 6.',
  });
  l.editExpense('kinesiologia', { note: 'Sesión 2 de 6. Mismo reparto para las demás.' });
  l.pay('diego-kinesiologia', {
    from: 'diego',
    to: 'lucia',
    amountMinor: 3198,
    currency: 'USD',
    method: 'transfer',
    date: '2026-11-15',
    group: 'care',
    credited: { amountMinor: 30000, currency: 'CLP' },
  });

  // The purchase in section 5, once with the debt in each currency.
  l.addExpense('compra-cad', {
    title: 'Compra con tarjeta canadiense',
    kind: 'other',
    group: 'trip',
    payer: 'diego',
    amountMinor: 18540,
    currency: 'CAD',
    otherAmount: { amountMinor: 120000, currency: 'CLP' },
    chargedCurrency: 'CAD',
    date: '2026-11-16',
    participants: ['diego', 'lucia', 'mama'],
    percents: { diego: 50, lucia: 25, mama: 25 },
    usualSplit: { diego: 50, lucia: 25, mama: 25 },
  });
  l.addExpense('compra-clp', {
    title: 'Compra con deuda en pesos',
    kind: 'other',
    group: 'trip',
    payer: 'diego',
    amountMinor: 120000,
    currency: 'CLP',
    otherAmount: { amountMinor: 18540, currency: 'CAD' },
    chargedCurrency: 'CAD',
    date: '2026-11-16',
    participants: ['diego', 'lucia', 'mama'],
    percents: { diego: 50, lucia: 25, mama: 25 },
  });

  // Split rounding: a remainder, an amount the largest share absorbs, and a tie.
  l.addExpense('taxi', {
    title: 'Taxi al aeropuerto',
    kind: 'other',
    group: 'trip',
    payer: 'lucia',
    amountMinor: 10000,
    currency: 'CLP',
    date: '2026-11-17',
    participants: ['diego', 'lucia', 'mama'],
  });
  l.addExpense('farmacia', {
    title: 'Farmacia del viaje',
    kind: 'other',
    group: 'trip',
    payer: 'lucia',
    amountMinor: 10001,
    currency: 'CLP',
    date: '2026-11-17',
    participants: ['diego', 'lucia', 'mama'],
    percents: { diego: 33, lucia: 33, mama: 34 },
  });
  l.addExpense('peaje', {
    title: 'Peaje de vuelta',
    kind: 'other',
    group: 'trip',
    payer: 'diego',
    amountMinor: 10001,
    currency: 'CLP',
    date: '2026-11-17',
    participants: ['diego', 'lucia'],
    percents: { diego: 50, lucia: 50 },
  });

  return l;
}

const carlosPays = (l, amountMinor, group, { alias = 'carlos-lucia', ...extra } = {}) =>
  l.pay(alias, {
    from: 'carlos',
    to: 'lucia',
    amountMinor,
    currency: 'CLP',
    method: 'transfer',
    date: '2026-11-18',
    group,
    ...extra,
  });

/**
 * Situations layered on top of the base data. `expect` holds figures taken from the requirements,
 * written by hand so that the build fails if the replay ever disagrees with them.
 */
export const SCENARIOS = [
  {
    name: 'payment-no-group',
    requirement: 'Section 6, scenario 1',
    description: 'Carlos pays Lucía CLP 10.000 and chooses no group',
    apply: (l) => carlosPays(l, 10000),
    expect: { almuerzo: 6800, kinesiologia: 60000, groupsCad: { meals: -1015, care: 6045 } },
  },
  {
    name: 'payment-chosen-group',
    requirement: 'Section 6, scenario 2',
    description: 'Carlos pays Lucía CLP 10.000 and chooses Cuidado',
    apply: (l) => carlosPays(l, 10000, 'care'),
    expect: { almuerzo: 16550, kinesiologia: 'settled', groupsCad: { meals: -2470, care: 7500 } },
  },
  {
    name: 'payment-full',
    requirement: 'Section 6, scenario 3',
    description: 'Carlos pays Lucía exactly the CLP 26.550 he owes',
    apply: (l) => carlosPays(l, 26550),
    views: ['mama'],
    expect: {
      almuerzo: 'settled',
      kinesiologia: 'settled',
      groupsCad: { care: 7500 },
      // The payment spans two groups, and Mamá is only in Comidas.
      seenBy: {
        mama: { applied: ['almuerzo', 'carlos-lucia', 16800], hiddenExpense: 'kinesiologia', hiddenPayment: 'carlos-lucia' },
      },
    },
  },
  {
    name: 'payment-over',
    requirement: 'Section 6, scenario 4',
    description: 'Carlos pays Lucía CLP 30.000, leaving CLP 3.450 of credit in Cuidado',
    apply: (l) => carlosPays(l, 30000),
    expect: {
      almuerzo: 'settled',
      kinesiologia: 'settled',
      groupsCad: { care: 8015 },
      credit: { minor: 3450, currency: 'CLP', group: 'care' },
    },
  },
  {
    name: 'edit-after-payment',
    requirement: 'Section 6, when an expense is edited',
    description: 'After a CLP 10.000 payment, Lucía corrects the lunch from CLP 84.000 to CLP 40.000',
    apply: (l) => {
      carlosPays(l, 10000);
      l.editExpense('almuerzo', { amountMinor: 40000 });
    },
    expect: { almuerzo: 'settled', kinesiologia: 58000 },
  },
  {
    name: 'edit-share-grows',
    requirement: 'Section 6, when an expense is edited',
    description: 'Papá raises the pizzas to CLP 60.000, so Carlos\'s settled share reopens for CLP 3.000',
    apply: (l) => l.editExpense('pizzas', { amountMinor: 60000 }),
    expect: { pairs: [['pizzas', 'carlos', 'papa', 3000]] },
  },
  {
    name: 'edit-changes-payer',
    requirement: 'Section 6, when an expense is edited',
    description: 'The tablet turns out to be paid by Lucía, and Diego\'s payment moves to the older debt',
    apply: (l) => l.editExpense('tablet', { payerId: l.member('lucia') }),
    expect: {
      pairs: [
        ['tablet', 'carlos', 'lucia', 15000],
        ['tablet', 'carlos', 'diego', 'none'],
        ['tablet', 'diego', 'lucia', 3022],
        ['kinesiologia', 'diego', 'lucia', 30000],
      ],
    },
  },
  {
    name: 'edit-changes-participants',
    requirement: 'Section 6, when an expense is edited',
    description: 'Diego is taken off the lunch, so the other four shares grow to CLP 21.000',
    apply: (l) =>
      l.editExpense('almuerzo', {
        participantIds: ['carlos', 'lucia', 'mama', 'papa'].map(l.member),
      }),
    expect: {
      pairs: [
        ['almuerzo', 'carlos', 'lucia', 21000],
        ['almuerzo', 'diego', 'lucia', 'none'],
        ['almuerzo', 'mama', 'lucia', 1000],
        ['remedios', 'mama', 'lucia', 5000],
      ],
    },
  },
  {
    name: 'edit-changes-group',
    requirement: 'Section 6, when an expense is edited',
    description: 'The tablet moves from Cuidado to Toda la familia',
    apply: (l) => l.editExpense('tablet', { groupId: l.group('family') }),
    expect: { groupsCad: { meals: -2507, care: -8955, family: 13320 } },
  },
  {
    name: 'edit-changes-currency',
    requirement: 'Section 6, when an expense is edited',
    description: 'The therapy is corrected to CAD 200,00, and Diego\'s CLP 30.000 covers CAD 44,78 of it',
    apply: (l) => l.editExpense('kinesiologia', { amountMinor: 20000, currency: 'CAD' }),
    expect: {
      pairs: [
        ['kinesiologia', 'carlos', 'lucia', 10000],
        ['kinesiologia', 'diego', 'lucia', 522],
      ],
    },
  },
  {
    name: 'remove-member-clears-split',
    requirement: 'Section 7, changing a group',
    description: 'Removing a member from a group with a usual split clears the split',
    apply: (l) => {
      l.createGroup('nuevo', {
        name: 'Grupo nuevo',
        by: 'carlos',
        members: ['carlos', 'lucia', 'papa'],
        usualSplit: { carlos: 50, lucia: 25, papa: 25 },
      });
      l.updateGroup('nuevo', { members: ['carlos', 'lucia'] });
    },
    expect: { group: { alias: 'nuevo', version: 2, usualSplit: null } },
  },
  {
    name: 'add-member-keeps-split',
    requirement: 'Section 12, changing groups',
    description: 'A member added to a group with a usual split is stored with 0',
    apply: (l) => l.updateGroup('care', { members: ['carlos', 'lucia', 'diego', 'mama'] }),
    expect: {
      group: { alias: 'care', version: 2, usualSplit: { carlos: 50, lucia: 25, diego: 25, mama: 0 } },
    },
  },
  {
    name: 'credit-pays-later-debt',
    requirement: 'Section 12, credit pays later debts',
    description: 'A new CLP 5.000 Comidas debt consumes the CLP 3.450 of credit held in Cuidado',
    apply: (l) => {
      carlosPays(l, 30000);
      l.addExpense('nueva', {
        title: 'Once en casa de Lucía',
        kind: 'meal',
        group: 'meals',
        payer: 'lucia',
        amountMinor: 10000,
        currency: 'CLP',
        date: '2026-11-19',
        participants: ['carlos', 'lucia'],
      });
    },
    expect: { nueva: 1550, credit: { minor: 0, currency: 'CLP', group: 'care' } },
  },
  {
    name: 'credit-after-debts-closed',
    requirement: 'Section 6, allocating a payment',
    description: 'With every debt already closed, new credit still belongs to the group of the newest expense',
    apply: (l) => {
      carlosPays(l, 26550);
      carlosPays(l, 1000, undefined, { alias: 'carlos-lucia-2' });
    },
    expect: { credit: { minor: 1000, currency: 'CLP', group: 'care' } },
  },
  {
    name: 'credit-order',
    requirement: 'Section 12, credit pays later debts',
    description: 'Credit in the expense\'s own group goes first, oldest first, before credit in other groups',
    apply: (l) => {
      carlosPays(l, 30000);
      carlosPays(l, 1000, 'meals', { alias: 'carlos-lucia-2' });
      carlosPays(l, 500, 'meals', { alias: 'carlos-lucia-3' });
      l.addExpense('nueva', {
        title: 'Once en casa de Lucía',
        kind: 'meal',
        group: 'meals',
        payer: 'lucia',
        amountMinor: 2400,
        currency: 'CLP',
        date: '2026-11-19',
        participants: ['carlos', 'lucia'],
      });
    },
    expect: {
      nueva: 'settled',
      credits: [
        { minor: 3450, currency: 'CLP', group: 'care' },
        { minor: 0, currency: 'CLP', group: 'meals' },
        { minor: 300, currency: 'CLP', group: 'meals' },
      ],
    },
  },
  {
    name: 'reverse-payment-reduces-credit',
    requirement: 'Section 12, reverse payments',
    description: 'Lucía pays back CLP 2.000 of the credit she owes Carlos',
    apply: (l) => {
      carlosPays(l, 30000);
      l.pay('lucia-carlos', {
        from: 'lucia',
        to: 'carlos',
        amountMinor: 2000,
        currency: 'CLP',
        method: 'cash',
        date: '2026-11-19',
      });
    },
    expect: { credit: { minor: 1450, currency: 'CLP', group: 'care' } },
  },
  {
    name: 'advance-against-open-debt',
    requirement: 'Section 3, record an advance',
    description:
      'Lucía gives Carlos CLP 10.000 while he owes her: his debts stay open and it all becomes her credit',
    apply: (l) => {
      l.pay('lucia-carlos', {
        from: 'lucia',
        to: 'carlos',
        amountMinor: 10000,
        currency: 'CLP',
        method: 'transfer',
        date: '2026-11-19',
      });
    },
    // In Cuidado Carlos owes Lucía more than the tablet she owes him, so the group has no room for
    // her payment, and even the tablet debt is left as it was.
    expect: {
      almuerzo: 16800,
      kinesiologia: 60000,
      tablet: 7500,
      credit: { minor: -10000, currency: 'CLP', group: 'care' },
    },
  },
  {
    name: 'backdated-expense',
    requirement: 'Section 12, events are replayed in the order they were recorded',
    description: 'An expense with an older date does not capture a payment recorded before it',
    apply: (l) => {
      carlosPays(l, 10000);
      l.addExpense('antigua', {
        title: 'Gasto anotado tarde',
        kind: 'other',
        group: 'meals',
        payer: 'lucia',
        amountMinor: 8000,
        currency: 'CLP',
        date: '2026-10-01',
        participants: ['carlos', 'lucia'],
      });
    },
    expect: { antigua: 4000, almuerzo: 6800 },
  },
  {
    name: 'transaction-date-in-the-past',
    requirement: 'Section 7, the day the money changed hands',
    description: 'An expense and an advance entered today for money spent and given in August',
    views: ['lucia'],
    apply: (l) => {
      l.addExpense('mercado', {
        title: 'Mercado de agosto',
        kind: 'parents',
        group: 'care',
        payer: 'lucia',
        amountMinor: 20000,
        currency: 'CLP',
        date: '2026-11-18',
        transactionDate: '2026-08-03',
        participants: ['carlos', 'lucia'],
      });
      carlosPays(l, 10000, undefined, { alias: 'adelanto-agosto', transactionDate: '2026-08-05' });
    },
    // Debts are paid in the order they were entered, so the advance pays Almuerzo, entered earlier,
    // and leaves Mercado open even though its money was spent first.
    expect: { mercado: 10000, almuerzo: 6800 },
  },
  {
    name: 'transaction-date-corrected',
    requirement: 'Section 7, the day the money changed hands',
    description: 'Correcting the day of an expense and of a payment moves them in the lists and no money',
    views: ['lucia'],
    apply: (l) => {
      l.editExpense('tablet', { transactionDate: '2026-10-30' });
      l.editPayment('lucia-calefon', { transactionDate: '2026-09-30', by: 'carlos' });
    },
    expect: { groupsCad: { meals: -2507, care: 6045, family: -1680 } },
  },
  {
    name: 'new-rates-keep-debts-closed',
    requirement: 'Section 6, rates and history',
    description: 'A later rate entry neither reopens the closed debts nor moves the open ones',
    apply: (l) => {
      carlosPays(l, 10000, 'care');
      l.enterRates('later', { by: 'lucia', usdCad: '1.40', cadClp: '655', date: '2026-11-19' });
    },
    expect: { almuerzo: 16550, kinesiologia: 'settled', tablet: 'settled' },
  },
  {
    name: 'full-payment-other-currency',
    requirement: 'Section 7, full payments in another currency',
    description: 'Carlos pays CAD 39,63 and the exact CLP 26.550 is credited',
    apply: (l) =>
      carlosPays(l, 3963, undefined, {
        currency: 'CAD',
        credited: { amountMinor: 26550, currency: 'CLP' },
      }),
    expect: { almuerzo: 'settled', kinesiologia: 'settled', groupsCad: { care: 7500 } },
  },
  {
    name: 'credited-outside-tolerance',
    requirement: 'Section 7, full payments in another currency',
    description: 'Carlos pays CAD 40,00 claiming CLP 26.550, so exactly what was paid is credited',
    apply: (l) =>
      carlosPays(l, 4000, undefined, {
        currency: 'CAD',
        credited: { amountMinor: 26550, currency: 'CLP' },
      }),
    expect: { almuerzo: 'settled', kinesiologia: 'settled', creditCurrency: 'CAD' },
  },
  {
    name: 'credit-exact-paid-share',
    requirement: 'Section 12, amounts stay whole',
    description: 'Credit from a payment credited at another value pays a later debt in a third currency',
    apply: (l) => {
      l.addExpense('dolares', {
        title: 'Compra en dólares',
        kind: 'other',
        group: 'family',
        payer: 'papa',
        amountMinor: 301,
        currency: 'USD',
        date: '2026-11-18',
        participants: ['carlos'],
      });
      l.pay('carlos-papa', {
        from: 'carlos',
        to: 'papa',
        amountMinor: 3963,
        currency: 'CAD',
        method: 'transfer',
        date: '2026-11-18',
        credited: { amountMinor: 26550, currency: 'CLP' },
      });
      l.addExpense('pesos', {
        title: 'Compra en pesos',
        kind: 'other',
        group: 'family',
        payer: 'papa',
        amountMinor: 952,
        currency: 'CLP',
        date: '2026-11-19',
        participants: ['carlos'],
      });
    },
    // Rounding the credit first would give CAD 1,42.
    expect: { paidSlice: ['pesos', 'carlos-papa', 143] },
  },
  {
    name: 'zero-share',
    requirement: 'Section 5, splits',
    description: 'CLP 1 split equally between two people leaves Lucía with a share of zero and no debt',
    views: ['lucia'],
    apply: (l) =>
      l.addExpense('peso', {
        title: 'Un peso',
        kind: 'other',
        group: 'care',
        payer: 'carlos',
        amountMinor: 1,
        currency: 'CLP',
        date: '2026-11-18',
        participants: ['carlos', 'lucia'],
      }),
    expect: {
      standing: ['peso', 'lucia', { involved: true, openMinor: 0, settled: true }, 'paid'],
    },
  },
];

/** Requests to send against the base data, each with the answer the API must give. */
export function requestCases(l) {
  const m = l.member;
  const g = l.group;
  const e = l.expenseId;
  const p = (alias) => l.id('payment', alias);
  let counter = 0;
  const requestId = () => {
    counter += 1;
    return `90000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };

  const expense = (overrides = {}) => ({
    requestId: requestId(),
    title: 'Caso de prueba',
    kind: 'other',
    groupId: g('care'),
    payerId: m('carlos'),
    amountMinor: 1000,
    currency: 'CAD',
    date: '2026-11-18',
    splitMode: 'equal',
    participantIds: [m('carlos'), m('lucia')],
    ...overrides,
  });
  const edit = (alias, overrides = {}) => {
    const item = l.state.expenses[e(alias)];
    return {
      requestId: requestId(),
      title: item.title,
      kind: item.kind,
      groupId: item.groupId,
      payerId: item.payerId,
      amountMinor: item.amountMinor,
      currency: item.currency,
      splitMode: item.splitMode,
      participantIds: item.participantIds,
      percents: item.percents,
      version: item.version,
      ...overrides,
    };
  };
  const payment = (overrides = {}) => ({
    requestId: requestId(),
    fromId: m('carlos'),
    toId: m('lucia'),
    paid: { amountMinor: 1000, currency: 'CLP' },
    method: 'transfer',
    date: '2026-11-18',
    ...overrides,
  });
  const newGroup = (overrides = {}) => ({
    requestId: requestId(),
    name: 'Grupo de prueba',
    memberIds: [m('carlos'), m('lucia')],
    ...overrides,
  });
  const groupEdit = (alias, overrides = {}) => {
    const group = l.state.groups[g(alias)];
    return {
      requestId: requestId(),
      name: group.name,
      memberIds: group.memberIds,
      version: group.version,
      ...overrides,
    };
  };
  const rates = (overrides = {}) => ({
    requestId: requestId(),
    usdCad: '1.41',
    cadClp: '672',
    date: '2026-11-19',
    ...overrides,
  });

  const POST_EXPENSE = ['POST', '/api/expenses'];
  const POST_PAYMENT = ['POST', '/api/payments'];
  const POST_GROUP = ['POST', '/api/groups'];
  const POST_RATES = ['POST', '/api/exchange-rates'];
  const putExpense = (alias) => ['PUT', `/api/expenses/${e(alias)}`];
  const putPayment = (alias) => ['PUT', `/api/payments/${p(alias)}`];
  const paymentEdit = (alias, overrides = {}) => ({
    requestId: requestId(),
    transactionDate: '2026-09-30',
    version: l.state.payments[p(alias)].version,
    ...overrides,
  });
  const putGroup = (alias) => ['PUT', `/api/groups/${g(alias)}`];

  const INVALID = { status: 400, code: 'validation_error' };
  const FORBIDDEN = { status: 403, code: 'forbidden' };
  const NOT_FOUND = { status: 404, code: 'not_found' };
  const CONFLICT = { status: 409, code: 'conflict' };
  const CREATED = { status: 201 };
  const OK = { status: 200 };

  const tablet = l.state.bodies.tablet;
  const savedPayment = l.state.bodies['lucia-calefon'];

  const cases = [
    // Controls: these must succeed, which proves the refusals below fail for the stated reason.
    ['a valid expense is saved', 'carlos', POST_EXPENSE, expense(), CREATED],
    ['a valid payment is saved', 'carlos', POST_PAYMENT, payment(), CREATED],
    ['a valid group is saved', 'carlos', POST_GROUP, newGroup(), CREATED],
    ['valid rates are saved', 'lucia', POST_RATES, rates(), CREATED],

    // Section 7, saving an expense.
    ['a blank title', 'carlos', POST_EXPENSE, expense({ title: '   ' }), INVALID],
    ['a title of 41 characters', 'carlos', POST_EXPENSE, expense({ title: 'x'.repeat(41) }), INVALID],
    ['a title of 40 characters', 'carlos', POST_EXPENSE, expense({ title: 'x'.repeat(40) }), CREATED],
    ['a note of 201 characters', 'carlos', POST_EXPENSE, expense({ note: 'x'.repeat(201) }), INVALID],
    ['a note of 200 characters', 'carlos', POST_EXPENSE, expense({ note: 'x'.repeat(200) }), CREATED],
    ['an amount of zero', 'carlos', POST_EXPENSE, expense({ amountMinor: 0 }), INVALID],
    ['a fractional amount', 'carlos', POST_EXPENSE, expense({ amountMinor: 10.5 }), INVALID],
    ['CAD over the maximum', 'carlos', POST_EXPENSE, expense({ amountMinor: 1000001 }), INVALID],
    ['CAD at the maximum', 'carlos', POST_EXPENSE, expense({ amountMinor: 1000000 }), CREATED],
    ['CLP over the maximum', 'carlos', POST_EXPENSE, expense({ amountMinor: 10000001, currency: 'CLP' }), INVALID],
    ['CLP at the maximum', 'carlos', POST_EXPENSE, expense({ amountMinor: 10000000, currency: 'CLP' }), CREATED],
    ['an unsupported currency', 'carlos', POST_EXPENSE, expense({ currency: 'EUR' }), INVALID],
    ['a second amount in the same currency', 'carlos', POST_EXPENSE, expense({ otherAmount: { amountMinor: 500, currency: 'CAD' }, chargedCurrency: 'CAD' }), INVALID],
    ['a second amount over the maximum', 'carlos', POST_EXPENSE, expense({ otherAmount: { amountMinor: 10000001, currency: 'CLP' }, chargedCurrency: 'CAD' }), INVALID],
    ['a charged currency that is neither amount', 'carlos', POST_EXPENSE, expense({ otherAmount: { amountMinor: 500, currency: 'CLP' }, chargedCurrency: 'USD' }), INVALID],
    ['an unknown kind', 'carlos', POST_EXPENSE, expense({ kind: 'travel' }), INVALID],
    ['an unknown split mode', 'carlos', POST_EXPENSE, expense({ splitMode: 'shares' }), INVALID],
    ['a group that does not exist', 'carlos', POST_EXPENSE, expense({ groupId: 'b0000000-0000-4000-8000-000000009999' }), NOT_FOUND],
    ['a group the caller is not in', 'mama', POST_EXPENSE, expense({ payerId: m('mama'), participantIds: [m('carlos')] }), NOT_FOUND],
    ['a payer outside the group', 'carlos', POST_EXPENSE, expense({ payerId: m('mama') }), INVALID],
    ['a participant outside the group', 'carlos', POST_EXPENSE, expense({ participantIds: [m('carlos'), m('mama')] }), INVALID],
    ['no participants', 'carlos', POST_EXPENSE, expense({ participantIds: [] }), INVALID],
    ['a participant who has not finished signing up', 'carlos', POST_EXPENSE, expense({ participantIds: [m('carlos'), 'a0000000-0000-4000-8000-000000009999'] }), INVALID],
    ['percentages missing', 'carlos', POST_EXPENSE, expense({ splitMode: 'percent' }), INVALID],
    ['percentages adding up to 99', 'carlos', POST_EXPENSE, expense({ splitMode: 'percent', percents: { [m('carlos')]: 50, [m('lucia')]: 49 } }), INVALID],
    ['fractional percentages', 'carlos', POST_EXPENSE, expense({ splitMode: 'percent', percents: { [m('carlos')]: 50.5, [m('lucia')]: 49.5 } }), INVALID],
    ['a date that does not exist', 'carlos', POST_EXPENSE, expense({ date: '2026-02-30' }), INVALID],
    ['a transaction date in the past', 'carlos', POST_EXPENSE, expense({ transactionDate: '2026-08-03' }), { status: 201, body: { date: '2026-11-18', transactionDate: '2026-08-03' } }],
    ['a transaction date that does not exist', 'carlos', POST_EXPENSE, expense({ transactionDate: '2026-02-30' }), INVALID],
    ['no transaction date, from a browser that predates it', 'carlos', POST_EXPENSE, expense(), { status: 201, body: { transactionDate: '2026-11-18' } }],
    ['shares sent by the browser', 'carlos', POST_EXPENSE, expense({ shares: { [m('carlos')]: 1000 } }), INVALID],
    ['a usual split missing a member', 'carlos', POST_EXPENSE, expense({ splitMode: 'percent', percents: { [m('carlos')]: 50, [m('lucia')]: 50 }, usualSplit: { [m('carlos')]: 50, [m('lucia')]: 50 } }), INVALID],

    // Section 7, editing.
    ['editing an expense someone else added', 'carlos', putExpense('almuerzo'), edit('almuerzo'), FORBIDDEN],
    ['editing with a stale version', 'carlos', putExpense('tablet'), edit('tablet', { version: 99 }), CONFLICT],
    ['changing the date on an edit', 'carlos', putExpense('tablet'), edit('tablet', { date: '2026-11-13' }), INVALID],
    ['changing the transaction date on an edit', 'carlos', putExpense('tablet'), edit('tablet', { transactionDate: '2026-10-30' }), { status: 200, body: { date: '2026-11-12', transactionDate: '2026-10-30', version: 2 } }],
    ['an edit that sends no transaction date keeps it', 'carlos', putExpense('tablet'), edit('tablet', { title: 'Tablet' }), { status: 200, body: { transactionDate: '2026-11-12' } }],
    ['an edit with a transaction date that does not exist', 'carlos', putExpense('tablet'), edit('tablet', { transactionDate: '2026-11-31' }), INVALID],
    ['editing an expense in a group the caller is not in', 'mama', putExpense('tablet'), edit('tablet'), NOT_FOUND],
    ['editing after leaving the group', 'beto', putExpense('cabana'), edit('cabana'), NOT_FOUND],
    ['an edit that changes what a former member owes', 'diego', putExpense('gasolina'), edit('gasolina', { amountMinor: 6000 }), INVALID],
    ['an edit that leaves a former member untouched', 'diego', putExpense('gasolina'), edit('gasolina', { title: 'Bencina del viaje' }), OK],
    ['moving an expense to a group a participant is not in', 'diego', putExpense('compra-cad'), edit('compra-cad', { groupId: g('care') }), INVALID],
    ['adding a participant from outside the group', 'carlos', putExpense('tablet'), edit('tablet', { splitMode: 'equal', percents: undefined, participantIds: [m('carlos'), m('lucia'), m('diego'), m('mama')] }), INVALID],

    // Section 7, recording a payment.
    ['paying yourself', 'carlos', POST_PAYMENT, payment({ toId: m('carlos') }), INVALID],
    ['a payment between two other people', 'carlos', POST_PAYMENT, payment({ fromId: m('lucia'), toId: m('diego') }), INVALID],
    ['recording a payment made to you', 'carlos', POST_PAYMENT, payment({ fromId: m('lucia'), toId: m('carlos') }), CREATED],
    ['a payment of zero', 'carlos', POST_PAYMENT, payment({ paid: { amountMinor: 0, currency: 'CLP' } }), INVALID],
    ['a payment above the expense maximum', 'carlos', POST_PAYMENT, payment({ paid: { amountMinor: 20000000, currency: 'CLP' } }), CREATED],
    ['an unsupported payment currency', 'carlos', POST_PAYMENT, payment({ paid: { amountMinor: 100, currency: 'EUR' } }), INVALID],
    ['an unknown method', 'carlos', POST_PAYMENT, payment({ method: 'cheque' }), INVALID],
    ['a chosen group the caller is not in', 'mama', POST_PAYMENT, payment({ fromId: m('mama'), toId: m('lucia'), groupId: g('care') }), NOT_FOUND],
    ['a chosen group the other person is not in', 'carlos', POST_PAYMENT, payment({ toId: m('beto'), groupId: g('care') }), INVALID],
    ['a payment given in the past', 'carlos', POST_PAYMENT, payment({ transactionDate: '2026-08-05' }), { status: 201, body: { date: '2026-11-18', transactionDate: '2026-08-05', version: 1 } }],
    ['a payment transaction date that does not exist', 'carlos', POST_PAYMENT, payment({ transactionDate: '2026-13-01' }), INVALID],

    // Section 7, correcting the day a payment was given.
    ['correcting a payment made to you', 'carlos', putPayment('lucia-calefon'), paymentEdit('lucia-calefon'), { status: 200, body: { date: '2026-10-05', transactionDate: '2026-09-30', version: 2 } }],
    ['correcting a payment you made', 'lucia', putPayment('lucia-calefon'), paymentEdit('lucia-calefon'), OK],
    ['correcting a payment between two other people', 'diego', putPayment('lucia-calefon'), paymentEdit('lucia-calefon'), NOT_FOUND],
    ['correcting a payment that does not exist', 'carlos', ['PUT', '/api/payments/d0000000-0000-4000-8000-000000009999'], paymentEdit('lucia-calefon'), NOT_FOUND],
    ['correcting a payment with a stale version', 'carlos', putPayment('lucia-calefon'), paymentEdit('lucia-calefon', { version: 99 }), CONFLICT],
    ['correcting a payment to a day that does not exist', 'carlos', putPayment('lucia-calefon'), paymentEdit('lucia-calefon', { transactionDate: '2026-09-31' }), INVALID],
    ['changing the amount of a payment', 'carlos', putPayment('lucia-calefon'), paymentEdit('lucia-calefon', { paid: { amountMinor: 1, currency: 'CLP' } }), INVALID],
    ['changing the entry date of a payment', 'carlos', putPayment('lucia-calefon'), paymentEdit('lucia-calefon', { date: '2026-09-30' }), INVALID],

    // Section 7, home currency.
    ['an unsupported home currency', 'carlos', ['PUT', '/api/me/profile'], { homeCurrency: 'EUR' }, INVALID],
    ['changing the home currency', 'carlos', ['PUT', '/api/me/profile'], { homeCurrency: 'USD' }, OK],
    ['finishing sign-up without a display name', 'nina', ['PUT', '/api/me/profile'], { homeCurrency: 'CLP' }, INVALID],
    ['finishing sign-up', 'nina', ['PUT', '/api/me/profile'], { homeCurrency: 'CLP', displayName: 'Nina' }, OK],

    // Section 7, creating and changing groups.
    ['a blank group name', 'carlos', POST_GROUP, newGroup({ name: '  ' }), INVALID],
    ['a group name of 41 characters', 'carlos', POST_GROUP, newGroup({ name: 'x'.repeat(41) }), INVALID],
    ['a group of one', 'carlos', POST_GROUP, newGroup({ memberIds: [m('carlos')] }), INVALID],
    ['a group without the caller', 'carlos', POST_GROUP, newGroup({ memberIds: [m('lucia'), m('diego')] }), INVALID],
    ['a group with an unknown member', 'carlos', POST_GROUP, newGroup({ memberIds: [m('carlos'), 'a0000000-0000-4000-8000-000000009999'] }), INVALID],
    ['a group with a former member', 'carlos', POST_GROUP, newGroup({ memberIds: [m('carlos'), m('rosa')] }), INVALID],
    ['renaming a group someone else created', 'lucia', putGroup('care'), groupEdit('care', { name: 'Otro nombre' }), FORBIDDEN],
    ['changing a group whose creator lost access', 'mama', putGroup('club'), groupEdit('club', { name: 'Otro nombre' }), FORBIDDEN],
    ['removing the creator', 'carlos', putGroup('care'), groupEdit('care', { memberIds: [m('lucia'), m('diego')] }), INVALID],
    ['removing a member with an open balance', 'carlos', putGroup('care'), groupEdit('care', { memberIds: [m('carlos'), m('lucia')] }), { status: 409, code: 'member_has_open_balance' }],
    ['changing a group with a stale version', 'carlos', putGroup('care'), groupEdit('care', { name: 'Otro nombre', version: 99 }), CONFLICT],
    ['renaming your own group', 'carlos', putGroup('care'), groupEdit('care', { name: 'Cuidado de los papás' }), OK],

    // Section 7, entering exchange rates.
    ['a missing rate', 'carlos', POST_RATES, rates({ cadClp: undefined }), INVALID],
    ['a rate of zero', 'carlos', POST_RATES, rates({ usdCad: '0' }), INVALID],
    ['a negative rate', 'carlos', POST_RATES, rates({ usdCad: '-1.40' }), INVALID],
    ['a rate that is not a number', 'carlos', POST_RATES, rates({ cadClp: 'mucho' }), INVALID],
    ['a rate date that does not exist', 'carlos', POST_RATES, rates({ date: '2026-13-01' }), INVALID],
    ['a rate dated before the latest entry', 'carlos', POST_RATES, rates({ date: '2026-10-15' }), { status: 201, body: { date: '2026-11-01' } }],

    // Section 8, access.
    ['a member removed from the allowlist', 'rosa', ['GET', '/api/ledger'], undefined, FORBIDDEN],
    ['the ledger before finishing sign-up', 'nina', ['GET', '/api/ledger'], undefined, FORBIDDEN],
    ['who am I before finishing sign-up', 'nina', ['GET', '/api/me'], undefined, { status: 200, body: { memberId: null, displayName: null, homeCurrency: null } }],

    // Section 9, pages and filters.
    ['the first page of expenses', 'carlos', ['GET', '/api/expenses?limit=2'], undefined, { status: 200, expenses: [e('kinesiologia'), e('tablet')], morePages: true }],
    ['one group, newest first', 'carlos', ['GET', `/api/expenses?groupId=${g('meals')}`], undefined, { status: 200, expenses: [e('remedios'), e('almuerzo'), e('pizzas')], morePages: false }],
    ['one kind across groups', 'carlos', ['GET', '/api/expenses?kind=gift'], undefined, { status: 200, expenses: [e('flores')], morePages: false }],
    ['one group and one kind', 'carlos', ['GET', `/api/expenses?groupId=${g('family')}&kind=meal`], undefined, { status: 200, expenses: [e('cena'), e('pan'), e('te')], morePages: false }],
    ['a page size of zero', 'carlos', ['GET', '/api/expenses?limit=0'], undefined, INVALID],
    ['a page size over the maximum', 'carlos', ['GET', '/api/expenses?limit=101'], undefined, INVALID],
    ['an unknown kind filter', 'carlos', ['GET', '/api/expenses?kind=travel'], undefined, INVALID],
    ['a malformed cursor', 'carlos', ['GET', '/api/expenses?cursor=not-a-cursor'], undefined, INVALID],
    ['a group filter the caller is not in', 'carlos', ['GET', `/api/expenses?groupId=${g('trip')}`], undefined, NOT_FOUND],
    ['opening an expense', 'carlos', ['GET', `/api/expenses/${e('tablet')}`], undefined, OK],
    ['opening an expense in another group', 'mama', ['GET', `/api/expenses/${e('tablet')}`], undefined, NOT_FOUND],

    // Section 4, the caller's own payments.
    ['my payments, newest first', 'carlos', ['GET', '/api/payments?limit=2'], undefined, { status: 200, payments: [p('carlos-pizzas'), p('carlos-cena')], morePages: true }],
    ['my payments with one person', 'carlos', ['GET', `/api/payments?memberId=${m('lucia')}`], undefined, { status: 200, payments: [p('lucia-calefon')], morePages: false }],
    ['a payment that became pure credit', 'papa', ['GET', `/api/payments?memberId=${m('rosa')}`], undefined, { status: 200, payments: [p('papa-rosa')], morePages: false }],
    ['payments with an unknown member', 'carlos', ['GET', '/api/payments?memberId=a0000000-0000-4000-8000-000000009999'], undefined, NOT_FOUND],
    ['a payment page size of zero', 'carlos', ['GET', '/api/payments?limit=0'], undefined, INVALID],

    // Section 9, retries.
    ['repeating a saved expense', 'carlos', POST_EXPENSE, tablet, CREATED],
    ['reusing a request id with different content', 'carlos', POST_EXPENSE, { ...tablet, title: 'Otra cosa' }, CONFLICT],
    ['repeating a saved payment', 'lucia', POST_PAYMENT, savedPayment, CREATED],
  ];

  return cases.map(([name, caller, [method, path], body, expect]) => ({
    name,
    caller,
    method,
    path,
    ...(body === undefined ? {} : { body }),
    expect,
  }));
}

/** Where each requirement is represented. Names refer to the aliases in expected.json. */
export const COVERAGE = [
  ['4', 'A member with no avatar tone', 'member `beto`'],
  ['4', 'Invited, but has not finished the first sign-in step', 'allowlist entry `nina`'],
  ['4, 8', 'A former member stays in the history', 'member `rosa`, expense `libro`, group `club`'],
  ['4', 'Every expense kind', 'expenses `cena` (meal), `tablet` (parents), `flores` (gift), `libro` (other)'],
  ['4', 'Every payment method', 'payments `carlos-cena` (transfer), `lucia-cena` (cash), `diego-cena` (other)'],
  ['4', 'Expenses on the same date keep a stable order', 'expenses `compra-cad`, `compra-clp`'],
  ['4', 'Rates in force on a past date, and several entries on one day', 'rates `october`, `november-first`, `november`'],
  ['4', 'An expense recorded before any rates existed', 'expense `te`'],
  ['4', 'The payer is not a participant', 'expense `libro`'],
  ['4', 'List entries carry the split and each participant\'s share', 'the list entries of every expense, `farmacia` (percent), `taxi` (equal)'],
  ['4', 'A note on an expense', 'expense `kinesiologia`'],
  ['4', 'A caller who is not part of an expense in their group', 'expense `remedios`, seen by `carlos`'],
  ['4', 'A partly paid share', 'expense `cena`, participant `papa`'],
  ['5', 'Equal split with a remainder, in group order', 'expense `taxi`'],
  ['5', 'Percent split where the largest share absorbs the difference', 'expense `farmacia`'],
  ['5', 'Percent split where tied shares resolve in group order', 'expense `peaje`'],
  ['5', 'A purchase charged in another currency, debt in the charged currency', 'expense `compra-cad`'],
  ['5', 'The same purchase with the debt in the receipt currency', 'expense `compra-clp`'],
  ['6', 'The starting balances of the worked example', 'base data, seen by `carlos`'],
  ['6', 'Oldest debt first across two expenses', 'payment `papa-cena`'],
  ['6', 'A debt closed because the group net reached zero', 'expenses `cabana`, `gasolina`, payment `diego-cabana`'],
  ['6', 'Allocation scenarios 1 to 4', 'scenarios `payment-no-group`, `payment-chosen-group`, `payment-full`, `payment-over`'],
  ['6', 'An edit re-applies later payments', 'scenario `edit-after-payment`'],
  ['6', 'A share that grows reopens a settled expense', 'scenario `edit-share-grows`'],
  ['6', 'An edit changes the payer', 'scenario `edit-changes-payer`'],
  ['6', 'An edit changes the participants', 'scenario `edit-changes-participants`'],
  ['6', 'An edit changes the group', 'scenario `edit-changes-group`'],
  ['6', 'An edit changes the currency', 'scenario `edit-changes-currency`'],
  ['6', 'New rates never reopen a closed debt', 'scenario `new-rates-keep-debts-closed`'],
  ['7', 'A full payment credited at the exact debt', 'payments `diego-calefon`, `diego-kinesiologia`, scenario `full-payment-other-currency`'],
  ['7', 'A credited value outside the tolerance', 'scenario `credited-outside-tolerance`'],
  ['7', 'An expense whose author left the group', 'expense `cabana`'],
  ['7', 'A former group member stays on an expense', 'expense `gasolina`, participant `beto`'],
  ['7', 'Saving a usual split through an expense', 'expense `compra-cad`, group `trip`'],
  ['7', 'Removing a member clears the usual split', 'scenario `remove-member-clears-split`'],
  ['4, 12', 'A member added to a usual split is stored with 0', 'scenario `add-member-keeps-split`'],
  ['7', 'Someone added later sees past expenses and owes nothing for them', 'group `trip`, member `mama`'],
  ['7', 'A group whose creator lost access', 'group `club`'],
  ['7', 'An edited expense', 'expense `kinesiologia`, version 2'],
  ['7, 9', 'Every validation rule, refusal and retry', '`requests.json`'],
  ['8', 'Members only see their own groups', '`callers` in `expected.json`'],
  ['8', 'A payment across groups only shows its part to others', 'scenario `payment-full`, seen by `mama`'],
  ['12', 'Credit pays a later debt in the base data', 'payment `mama-almuerzo`, expense `remedios`'],
  ['12', 'Credit pays a later debt in another group', 'scenario `credit-pays-later-debt`'],
  ['12', 'Own-group credit goes first, oldest first', 'scenario `credit-order`'],
  ['6', 'Credit after every debt has closed goes to the newest expense\'s group', 'scenario `credit-after-debts-closed`'],
  ['12', 'Credit in another currency waits while there are no rates', 'payment `papa-beto`, expense `pan`'],
  ['12', 'A reverse payment reduces credit', 'scenario `reverse-payment-reduces-credit`'],
  ['3, 12', 'An advance against the giver\'s own open debts becomes credit and pays nothing', 'scenario `advance-against-open-debt`'],
  ['12', 'A backdated expense cannot capture an earlier payment', 'scenario `backdated-expense`'],
  ['7', 'An expense and an advance whose money changed hands before they were entered', 'scenario `transaction-date-in-the-past`'],
  ['7, 9', 'Correcting the day of an expense or a payment moves it in the lists and moves no money', 'scenario `transaction-date-corrected`'],
  ['12', 'Credit between two people with no shared group', 'payment `papa-rosa`'],
  ['9', 'Expenses load in pages, and filters run on the server', '`requests.json`, `lists` in `expected.json`'],
  ['9', 'Moving an expense to another group retires its old list entries', 'scenario `edit-changes-group`'],
  ['4', 'A payment that became pure credit can still be listed', 'payment `papa-rosa`, `requests.json`'],
  ['12', 'A later slice of credit keeps the exact share of what was paid', 'scenario `credit-exact-paid-share`'],
  ['5', 'A share that rounds to zero creates no debt', 'scenario `zero-share`'],
];

/** Requirements that stored data cannot show, and what has to test them instead. */
export const NOT_REPRESENTED = [
  ['8', 'Responses are never cached', 'Assert the `Cache-Control: no-store` header on each route'],
  ['8', 'Identity comes from the verified token', 'Handler tests with claims that disagree with the request'],
  ['9', 'A failed read is an error, never an empty result', 'Handler tests with a failing fake'],
  ['9', 'Every figure comes from one point in time', 'A concurrency test of the read protocol in `docs/dynamodb-schema.md`'],
  ['9', 'Concurrent saves are detected', 'A concurrency test of the write protocol. `requests.json` covers only a stale `version`'],
  ['11', 'Frontend changes', 'Frontend tests'],
];
