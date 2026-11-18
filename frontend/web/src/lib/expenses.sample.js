// Sample ledger for `npm run dev`, taken from the design. It lives in memory and resets on reload.
// Only src/lib/expenses.js may import this file, behind its dev-only condition.

const TO_BASE = { CAD: 1, USD: 1.4, CLP: 1 / 670 };
const ratesOn = (asOf) => ({ base: 'CAD', asOf, toBase: TO_BASE });

const USUAL_CARE = { carlos: 50, lucia: 25, diego: 25 };

const state = {
  me: 'carlos',
  rates: ratesOn('2026-11-18'),
  members: [
    { id: 'carlos', name: 'Carlos', tone: 'honey', currency: 'CAD' },
    { id: 'lucia', name: 'Lucía', tone: 'clay', currency: 'CLP' },
    { id: 'diego', name: 'Diego', tone: 'lagoon', currency: 'USD' },
    { id: 'mama', name: 'Mamá', tone: 'sage', currency: 'CLP' },
    { id: 'papa', name: 'Papá', tone: 'cocoa', currency: 'CLP' },
    { id: 'beto', name: 'Tío Beto', currency: 'USD' },
  ],
  groups: [
    {
      id: 'family',
      name: 'Toda la familia',
      memberIds: ['carlos', 'lucia', 'diego', 'mama', 'papa', 'beto'],
    },
    {
      id: 'meals',
      name: 'Comidas familiares',
      memberIds: ['carlos', 'lucia', 'diego', 'mama', 'papa'],
    },
    {
      id: 'care',
      name: 'Cuidado de Mamá y Papá',
      memberIds: ['carlos', 'lucia', 'diego'],
      usual: USUAL_CARE,
    },
  ],
  settlements: [],
  expenses: [
    {
      id: 'kinesiologia',
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
      rates: ratesOn('2026-11-14'),
      payments: [
        {
          id: 'diego-kinesiologia',
          fromId: 'diego',
          toId: 'lucia',
          amountMinor: 3200,
          currency: 'USD',
          coversMinor: 30000,
          date: '2026-11-15',
        },
      ],
    },
    {
      id: 'tablet',
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
      title: 'Flores para el cumpleaños de Mamá',
      kind: 'gift',
      groupId: 'family',
      payerId: 'beto',
      addedById: 'beto',
      amountMinor: 6000,
      currency: 'USD',
      date: '2026-11-06',
      splitMode: 'equal',
      hiddenFromId: 'mama',
      shares: { carlos: 1200, lucia: 1200, diego: 1200, papa: 1200, beto: 1200 },
    },
    {
      id: 'pizzas',
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

export function sampleLedger() {
  return structuredClone(state);
}

export function saveSampleExpense({ saveUsual, ...expense }) {
  const saved = { ...expense, id: expense.id ?? crypto.randomUUID() };
  const index = state.expenses.findIndex((item) => item.id === saved.id);
  if (index >= 0) state.expenses[index] = { ...state.expenses[index], ...saved };
  else state.expenses.unshift({ ...saved, addedById: state.me });

  if (saveUsual && saved.splitMode === 'percent') {
    const group = state.groups.find((item) => item.id === saved.groupId);
    group.usual = saved.percents;
  }
  return structuredClone(saved);
}

export function saveSampleSettlement(settlement) {
  const saved = { ...settlement, id: crypto.randomUUID() };
  state.settlements.push(saved);
  return structuredClone(saved);
}
