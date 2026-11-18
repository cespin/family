import { describe, expect, it } from 'vitest';
import { UNAVAILABLE, fetchLedger, saveExpense, saveSettlement } from './expenses.js';

// Outside `npm run dev` nothing may look like real data, and no write may look like it worked.
describe('the expenses module without an API', () => {
  it.each([
    ['reading the ledger', () => fetchLedger()],
    ['saving an expense', () => saveExpense({ title: 'Almuerzo' })],
    ['recording a payment', () => saveSettlement({ amountMinor: 100 })],
  ])('reports %s as unavailable', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: UNAVAILABLE });
  });
});
