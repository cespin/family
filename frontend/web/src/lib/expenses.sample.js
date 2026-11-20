// A stand-in for the expenses API in `npm run dev`, with the family from the design. It answers in
// the API's own shapes (backend/docs/api-contract.md), lives in memory and resets on reload.
// Only src/lib/expenses.js may import this file, behind its dev-only condition.
//
// Balances come from src/lib/sampleEngine.js, which is not the API's allocation: payments recorded
// here move the balances but do not appear in an expense's activity, and some edge cases differ.

import { ApiError } from './api.js';
import { pairEntries, expenseNet, expenseStanding, pairCleared } from './sampleEngine.js';
import { ratesFromEntry, splitByPercent, splitEqual } from './money.js';

const ME = 'carlos';
const USUAL_CARE = { carlos: 50, lucia: 25, diego: 25 };

const state = {
  revision: 1,
  nextSeq: 100,
  requests: new Map(),
  rateEntries: [{ id: 'rates-oct', usdCad: '1.40', cadClp: '670', date: '2026-10-01', enteredBy: 'lucia' }],
  members: [
    { id: 'carlos', name: 'Carlos', tone: 'honey', avatar: '🐵', currency: 'CAD', active: true },
    { id: 'lucia', name: 'Lucía', tone: 'clay', avatar: '🦊', currency: 'CLP', active: true },
    { id: 'diego', name: 'Diego', tone: 'lagoon', avatar: '🦍', currency: 'USD', active: true },
    { id: 'mama', name: 'Mamá', tone: 'sage', avatar: '🌻', currency: 'CLP', active: true },
    { id: 'papa', name: 'Papá', tone: 'cocoa', avatar: '🦧', currency: 'CLP', active: true },
    // Saved before avatars, so he shows his initials.
    { id: 'beto', name: 'Tío Beto', currency: 'USD', active: true },
  ],
  groups: [
    {
      id: 'family',
      name: 'Toda la familia',
      createdBy: 'mama',
      memberIds: ['carlos', 'lucia', 'diego', 'mama', 'papa', 'beto'],
      usual: null,
      version: 1,
    },
    {
      id: 'meals',
      name: 'Comidas familiares',
      createdBy: 'lucia',
      memberIds: ['carlos', 'lucia', 'diego', 'mama', 'papa'],
      usual: null,
      version: 1,
    },
    {
      id: 'care',
      name: 'Cuidado de Mamá y Papá',
      createdBy: 'carlos',
      memberIds: ['carlos', 'lucia', 'diego'],
      usual: USUAL_CARE,
      version: 2,
    },
  ],
  settlements: [],
  expenses: [
    {
      id: 'kinesiologia',
      seq: 13,
      title: 'Kinesiología de Mamá',
      kind: 'parents',
      groupId: 'care',
      payerId: 'lucia',
      addedById: 'lucia',
      amountMinor: 120000,
      currency: 'CLP',
      date: '2026-11-14',
      note: 'Sesión 2 de 6. Mismo reparto para las demás.',
      splitMode: 'percent',
      percents: USUAL_CARE,
      shares: { carlos: 60000, lucia: 30000, diego: 30000 },
      payments: [
        {
          id: 'diego-kinesiologia',
          fromId: 'diego',
          toId: 'lucia',
          amountMinor: 3198,
          currency: 'USD',
          coversMinor: 30000,
          method: 'transfer',
          date: '2026-11-15',
        },
      ],
    },
    {
      id: 'tablet',
      seq: 12,
      title: 'Tablet para las videollamadas',
      kind: 'parents',
      groupId: 'care',
      payerId: 'carlos',
      addedById: 'carlos',
      amountMinor: 30000,
      currency: 'CAD',
      date: '2026-11-12',
      splitMode: 'percent',
      percents: USUAL_CARE,
      shares: { carlos: 15000, lucia: 7500, diego: 7500 },
    },
    {
      id: 'almuerzo',
      seq: 10,
      title: 'Almuerzo familiar del domingo',
      kind: 'meal',
      groupId: 'meals',
      payerId: 'lucia',
      addedById: 'lucia',
      amountMinor: 84000,
      currency: 'CLP',
      date: '2026-11-08',
      splitMode: 'equal',
      shares: { carlos: 16800, lucia: 16800, diego: 16800, mama: 16800, papa: 16800 },
    },
    {
      id: 'flores',
      seq: 9,
      title: 'Flores para el cumpleaños de Mamá',
      kind: 'gift',
      groupId: 'family',
      payerId: 'beto',
      addedById: 'beto',
      amountMinor: 6000,
      currency: 'USD',
      date: '2026-11-06',
      splitMode: 'equal',
      shares: { carlos: 1200, lucia: 1200, diego: 1200, papa: 1200, beto: 1200 },
    },
    {
      id: 'pizzas',
      seq: 7,
      title: 'Pizzas en casa de Mamá',
      kind: 'meal',
      groupId: 'meals',
      payerId: 'papa',
      addedById: 'papa',
      amountMinor: 45000,
      currency: 'CLP',
      date: '2026-11-01',
      splitMode: 'equal',
      settled: true,
      shares: { carlos: 9000, lucia: 9000, diego: 9000, mama: 9000, papa: 9000 },
    },
    {
      id: 'cena',
      seq: 4,
      title: 'Cena de cumpleaños de Papá',
      kind: 'meal',
      groupId: 'family',
      payerId: 'mama',
      addedById: 'mama',
      amountMinor: 150000,
      currency: 'CLP',
      date: '2026-10-11',
      splitMode: 'equal',
      settled: true,
      shares: { carlos: 25000, lucia: 25000, diego: 25000, mama: 25000, papa: 25000, beto: 25000 },
    },
    {
      id: 'calefon',
      seq: 3,
      title: 'Arreglo del calefón',
      kind: 'parents',
      groupId: 'care',
      payerId: 'carlos',
      addedById: 'carlos',
      amountMinor: 210000,
      currency: 'CLP',
      date: '2026-10-04',
      splitMode: 'percent',
      percents: USUAL_CARE,
      settled: true,
      shares: { carlos: 105000, lucia: 52500, diego: 52500 },
    },
  ],
};

const fail = (status, code) => {
  throw new ApiError(status, code);
};

const clone = (value) => structuredClone(value);

function latestRates() {
  return state.rateEntries[state.rateEntries.length - 1] ?? null;
}

function ratesOn(date) {
  return state.rateEntries.filter((entry) => entry.date <= date).pop() ?? null;
}

/** The engine's view of the ledger, from the caller's side. */
function engineLedger() {
  return {
    me: ME,
    members: state.members,
    expenses: state.expenses,
    settlements: state.settlements,
    rates: ratesFromEntry(latestRates()),
  };
}

function myGroups() {
  return state.groups.filter((group) => group.memberIds.includes(ME));
}

function findGroup(id) {
  return myGroups().find((group) => group.id === id) ?? fail(404, 'not_found');
}

function findExpense(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense || !myGroups().some((group) => group.id === expense.groupId)) fail(404, 'not_found');
  return expense;
}

function sumByCurrency(entries) {
  const totals = new Map();
  for (const { minor, currency } of entries) {
    totals.set(currency, (totals.get(currency) ?? 0) + Math.round(minor));
  }
  return [...totals]
    .filter(([, minor]) => minor !== 0)
    .map(([currency, amountMinor]) => ({ amountMinor, currency }));
}

function standingsJson() {
  const ledger = engineLedger();
  return state.members
    .filter((member) => member.id !== ME)
    .map((member) => {
      const entries = pairEntries(ledger, member.id);
      const groupIds = [...new Set(entries.map((entry) => entry.groupId ?? null))];
      return {
        memberId: member.id,
        overall: sumByCurrency(entries),
        groups: groupIds
          .map((groupId) => ({
            groupId,
            amounts: sumByCurrency(entries.filter((entry) => (entry.groupId ?? null) === groupId)),
          }))
          .filter((group) => group.amounts.length > 0),
      };
    })
    .filter((standing) => standing.overall.length > 0);
}

function ledgerJson() {
  return {
    revision: state.revision,
    me: ME,
    members: state.members.map((member) => ({
      id: member.id,
      displayName: member.name,
      homeCurrency: member.currency,
      tone: member.tone ?? null,
      avatar: member.avatar ?? null,
      active: member.active,
    })),
    groups: myGroups().map(groupJson),
    exchangeRates: [...state.rateEntries].reverse(),
    standings: standingsJson(),
  };
}

function groupJson(group) {
  return {
    id: group.id,
    name: group.name,
    createdBy: group.createdBy,
    memberIds: group.memberIds,
    usualSplit: group.usual,
    version: group.version,
  };
}

function standingJson(expense) {
  const gross = expenseNet(expense, ME);
  if (gross == null) return { involved: false, openMinor: null, settled: false };
  const { netMinor, settled } = expenseStanding(engineLedger(), expense);
  return { involved: true, openMinor: settled ? 0 : netMinor, settled };
}

function participantIds(expense) {
  return Object.keys(expense.shares);
}

// Seed items predate transaction dates, so they read their entry date, as the API's old items do.
const transactionDay = (item) => item.transactionDate ?? item.date;

/** One participant's part, as both the list and the detail return it. */
function shareJson(expense, id) {
  const row = { memberId: id, shareMinor: expense.shares[id] };
  if (expense.splitMode === 'percent') row.percent = expense.percents[id];
  return row;
}

function listItemJson(expense) {
  return {
    id: expense.id,
    title: expense.title,
    kind: expense.kind,
    groupId: expense.groupId,
    payerId: expense.payerId,
    addedBy: expense.addedById,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    date: expense.date,
    transactionDate: transactionDay(expense),
    participantIds: participantIds(expense),
    splitMode: expense.splitMode,
    participants: participantIds(expense).map((id) => shareJson(expense, id)),
    standing: standingJson(expense),
  };
}

function participantStatus(expense, id, standing) {
  if (expense.settled || id === expense.payerId) return 'paid';
  if (id === ME) {
    if (standing.settled) return 'paid';
    return Math.abs(standing.openMinor) < expense.shares[id] ? 'partly_paid' : 'owes';
  }
  if (expense.payerId === ME) return pairCleared(engineLedger(), expense, id) ? 'paid' : 'owes';
  return (expense.payments ?? []).some((payment) => payment.fromId === id) ? 'paid' : 'owes';
}

function detailJson(expense) {
  const standing = standingJson(expense);
  const other = expense.otherAmount;
  const body = {
    ...listItemJson(expense),
    revision: state.revision,
    note: expense.note ?? null,
    ratesId: ratesOn(expense.date)?.id ?? null,
    version: expense.version ?? 1,
    participants: participantIds(expense).map((id) => {
      const row = { ...shareJson(expense, id), status: participantStatus(expense, id, standing) };
      if (other) row.otherShareMinor = Math.round((expense.shares[id] * other.amountMinor) / expense.amountMinor);
      return row;
    }),
    appliedPayments: (expense.payments ?? []).map((payment) => ({
      paymentId: payment.id,
      fromId: payment.fromId,
      toId: payment.toId,
      paidMinor: payment.amountMinor,
      paidCurrency: payment.currency,
      coveredMinor: payment.coversMinor ?? payment.amountMinor,
      method: payment.method,
      date: payment.date,
      transactionDate: transactionDay(payment),
    })),
  };
  delete body.participantIds;
  if (other) {
    body.otherAmount = clone(other);
    body.chargedCurrency = expense.chargedCurrency;
  }
  return body;
}

function listExpenses(params) {
  const groupId = params.get('groupId');
  const kind = params.get('kind');
  if (groupId) findGroup(groupId);
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('cursor') ?? 0);
  const groupIds = myGroups().map((group) => group.id);
  const matches = state.expenses
    .filter((expense) => groupIds.includes(expense.groupId))
    .filter((expense) => (!groupId || expense.groupId === groupId) && (!kind || expense.kind === kind))
    .sort((a, b) => transactionDay(b).localeCompare(transactionDay(a)) || b.seq - a.seq);
  const page = matches.slice(offset, offset + limit);
  return {
    revision: state.revision,
    expenses: page.map(listItemJson),
    nextCursor: offset + limit < matches.length ? String(offset + limit) : null,
  };
}

function shareOut(body, group) {
  const ordered = group.memberIds.filter((id) => body.participantIds.includes(id));
  return body.splitMode === 'percent'
    ? splitByPercent(body.amountMinor, ordered, body.percents)
    : splitEqual(body.amountMinor, ordered);
}

function expenseFields(body, group) {
  return {
    title: body.title.trim(),
    kind: body.kind,
    groupId: body.groupId,
    payerId: body.payerId,
    amountMinor: body.amountMinor,
    currency: body.currency,
    splitMode: body.splitMode,
    percents: body.percents,
    otherAmount: body.otherAmount,
    chargedCurrency: body.otherAmount ? (body.chargedCurrency ?? body.currency) : undefined,
    note: body.note,
    shares: shareOut(body, group),
  };
}

function saveUsual(body, group) {
  if (!body.usualSplit) return;
  group.usual = body.usualSplit;
  group.version += 1;
}

function addExpense(body) {
  const group = findGroup(body.groupId);
  if (!body.title?.trim()) fail(400, 'validation_error');
  const expense = {
    id: body.requestId,
    seq: state.nextSeq++,
    addedById: ME,
    date: body.date,
    transactionDate: body.transactionDate ?? body.date,
    version: 1,
    ...expenseFields(body, group),
  };
  state.expenses.push(expense);
  saveUsual(body, group);
  return detailJson(expense);
}

// A payer who did not add an expense may change only its amounts, transaction date and note.
function changesTheSplit(expense, body) {
  const samePeople =
    [...participantIds(expense)].sort().join() === [...body.participantIds].sort().join();
  const samePercents =
    JSON.stringify(Object.entries(expense.percents ?? {}).sort()) ===
    JSON.stringify(Object.entries(body.percents ?? {}).sort());
  return (
    expense.title !== body.title.trim() ||
    expense.kind !== body.kind ||
    expense.groupId !== body.groupId ||
    expense.payerId !== body.payerId ||
    expense.splitMode !== body.splitMode ||
    !samePeople ||
    !samePercents ||
    Boolean(body.usualSplit)
  );
}

function editExpense(id, body) {
  const expense = findExpense(id);
  if (expense.addedById !== ME) {
    if (expense.payerId !== ME || changesTheSplit(expense, body)) fail(403, 'forbidden');
  }
  if (body.version !== (expense.version ?? 1)) fail(409, 'conflict');
  const group = findGroup(body.groupId);
  Object.assign(expense, expenseFields(body, group), {
    transactionDate: body.transactionDate ?? transactionDay(expense),
    version: body.version + 1,
  });
  saveUsual(body, group);
  return detailJson(expense);
}

function addPayment(body) {
  if (body.fromId !== ME && body.toId !== ME) fail(403, 'forbidden');
  const counted = body.credited ?? body.paid;
  const payment = {
    id: body.requestId,
    fromId: body.fromId,
    toId: body.toId,
    amountMinor: counted.amountMinor,
    currency: counted.currency,
    groupId: body.groupId,
    method: body.method,
    date: body.date,
    transactionDate: body.transactionDate ?? body.date,
    paid: clone(body.paid),
    version: 1,
  };
  state.settlements.push(payment);
  return paymentJson(payment);
}

function paymentJson(payment) {
  const counted = { amountMinor: payment.amountMinor, currency: payment.currency };
  return {
    id: payment.id,
    fromId: payment.fromId,
    toId: payment.toId,
    paid: clone(payment.paid ?? counted),
    credited: counted,
    method: payment.method,
    date: payment.date,
    transactionDate: transactionDay(payment),
    groupId: payment.groupId ?? null,
    version: payment.version ?? 1,
  };
}

// Every payment with me, once each: those recorded here and those the seed puts on expenses.
function myPayments() {
  const all = [...state.settlements, ...state.expenses.flatMap((expense) => expense.payments ?? [])];
  const byId = new Map();
  for (const payment of all) {
    if ((payment.fromId === ME || payment.toId === ME) && !byId.has(payment.id)) {
      byId.set(payment.id, payment);
    }
  }
  return [...byId.values()];
}

function listPayments(params) {
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('cursor') ?? 0);
  const matches = myPayments().sort(
    (a, b) => transactionDay(b).localeCompare(transactionDay(a)) || b.id.localeCompare(a.id),
  );
  return {
    revision: state.revision,
    payments: matches.slice(offset, offset + limit).map(paymentJson),
    nextCursor: offset + limit < matches.length ? String(offset + limit) : null,
  };
}

// The seed repeats a payment on each expense it covers, so every copy gets the new day.
function editPayment(id, body) {
  const copies = [...state.settlements, ...state.expenses.flatMap((expense) => expense.payments ?? [])]
    .filter((payment) => payment.id === id);
  if (copies.length === 0 || !myPayments().some((payment) => payment.id === id)) {
    fail(404, 'not_found');
  }
  if (body.version !== (copies[0].version ?? 1)) fail(409, 'conflict');
  for (const payment of copies) {
    Object.assign(payment, { transactionDate: body.transactionDate, version: body.version + 1 });
  }
  return paymentJson(copies[0]);
}

function addGroup(body) {
  const group = {
    id: body.requestId,
    name: body.name.trim(),
    createdBy: ME,
    memberIds: body.memberIds,
    usual: body.usualSplit ?? null,
    version: 1,
  };
  state.groups.push(group);
  return groupJson(group);
}

function editGroup(id, body) {
  const group = findGroup(id);
  if (group.createdBy !== ME) fail(403, 'forbidden');
  if (body.version !== group.version) fail(409, 'conflict');
  const removed = group.memberIds.some((memberId) => !body.memberIds.includes(memberId));
  let usual = body.usualSplit ?? null;
  if (!usual && group.usual && !removed) {
    usual = Object.fromEntries(body.memberIds.map((memberId) => [memberId, group.usual[memberId] ?? 0]));
  }
  Object.assign(group, {
    name: body.name.trim(),
    memberIds: body.memberIds,
    usual,
    version: group.version + 1,
  });
  return groupJson(group);
}

function addRates(body) {
  const latest = latestRates();
  const entry = {
    id: body.requestId,
    usdCad: body.usdCad,
    cadClp: body.cadClp,
    date: latest && body.date < latest.date ? latest.date : body.date,
    enteredBy: ME,
  };
  state.rateEntries.push(entry);
  return clone(entry);
}

function saveProfile(body) {
  const member = state.members.find((item) => item.id === ME);
  member.currency = body.homeCurrency;
  if (body.tone) member.tone = body.tone;
  if (body.avatar) member.avatar = body.avatar;
  return {
    sub: 'sample',
    email: 'dev@example.test',
    name: member.name,
    memberId: member.id,
    displayName: member.name,
    homeCurrency: member.currency,
    avatar: member.avatar ?? null,
  };
}

// Writes keyed by requestId, so a retried save answers the same way, as the API does.
const WRITES = [
  ['POST', /^\/expenses$/, (body) => addExpense(body)],
  ['PUT', /^\/expenses\/([^/]+)$/, (body, id) => editExpense(id, body)],
  ['POST', /^\/payments$/, (body) => addPayment(body)],
  ['PUT', /^\/payments\/([^/]+)$/, (body, id) => editPayment(id, body)],
  ['POST', /^\/groups$/, (body) => addGroup(body)],
  ['PUT', /^\/groups\/([^/]+)$/, (body, id) => editGroup(id, body)],
  ['POST', /^\/exchange-rates$/, (body) => addRates(body)],
];

export async function sampleApi(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://sample.invalid');
  const route = url.pathname;

  if (method === 'GET' && route === '/ledger') return clone(ledgerJson());
  if (method === 'GET' && route === '/expenses') return clone(listExpenses(url.searchParams));
  if (method === 'GET' && route === '/payments') return clone(listPayments(url.searchParams));
  const detail = route.match(/^\/expenses\/([^/]+)$/);
  if (method === 'GET' && detail) {
    return clone(detailJson(findExpense(decodeURIComponent(detail[1]))));
  }
  if (method === 'PUT' && route === '/me/profile') return saveProfile(body);

  for (const [verb, pattern, write] of WRITES) {
    const match = route.match(pattern);
    if (verb === method && match) {
      const key = `${method} ${route} ${body.requestId}`;
      if (state.requests.has(key)) return clone(state.requests.get(key));
      const saved = write(body, match[1] && decodeURIComponent(match[1]));
      state.revision += 1;
      state.requests.set(key, saved);
      return clone(saved);
    }
  }
  return fail(404, 'not_found');
}
