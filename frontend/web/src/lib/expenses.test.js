import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api.js';
import {
  fetchExpense,
  fetchExpenses,
  fetchLedger,
  fetchPayments,
  recordPayment,
  refreshExchangeRates,
  saveExpense,
  saveGroup,
  saveProfile,
  updatePayment,
} from './expenses.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}));

const LEDGER = {
  revision: 42,
  me: 'ana',
  members: [
    { id: 'ana', displayName: 'Ana', homeCurrency: 'CAD', tone: 'sage', avatar: '🐸', active: true },
    { id: 'leo', displayName: 'Leo', homeCurrency: 'CLP', tone: null, avatar: null, active: false },
  ],
  groups: [
    {
      id: 'casa',
      name: 'Casa',
      createdBy: 'ana',
      memberIds: ['ana', 'leo'],
      usualSplit: { ana: 60, leo: 40 },
      version: 3,
    },
  ],
  exchangeRates: [
    { id: 'new', usdCad: '1.40', cadClp: '670', date: '2026-11-18', enteredBy: 'leo' },
    { id: 'old', usdCad: '1.35', cadClp: '650', date: '2026-10-01', enteredBy: 'ana' },
  ],
  standings: [
    {
      memberId: 'leo',
      overall: [{ amountMinor: -26550, currency: 'CLP' }],
      groups: [{ groupId: 'casa', amounts: [{ amountMinor: -26550, currency: 'CLP' }] }],
    },
  ],
};

function session(overrides = {}) {
  return { getToken: vi.fn(() => 'token-1'), renewToken: vi.fn(), ...overrides };
}

describe('the expenses seam', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  describe('reading the ledger', () => {
    it('sends the current token and renames fields for the screens', async () => {
      vi.mocked(apiFetch).mockResolvedValue(LEDGER);
      const ledger = await fetchLedger(session());

      expect(apiFetch).toHaveBeenCalledWith('/ledger', { token: 'token-1' });
      expect(ledger.members).toEqual([
        { id: 'ana', name: 'Ana', currency: 'CAD', tone: 'sage', avatar: '🐸', active: true },
        { id: 'leo', name: 'Leo', currency: 'CLP', tone: undefined, avatar: undefined, active: false },
      ]);
      expect(ledger.groups[0]).toEqual({
        id: 'casa',
        name: 'Casa',
        createdBy: 'ana',
        memberIds: ['ana', 'leo'],
        usual: { ana: 60, leo: 40 },
        version: 3,
      });
      expect(ledger.standings[0].groups[0].amounts).toEqual([{ minor: -26550, currency: 'CLP' }]);
    });

    it('uses the newest rates and keeps the older ones for past expenses', async () => {
      vi.mocked(apiFetch).mockResolvedValue(LEDGER);
      const ledger = await fetchLedger(session());

      expect(ledger.rates).toMatchObject({ id: 'new', asOf: '2026-11-18', enteredBy: 'leo' });
      expect(ledger.rates.toBase).toEqual({ CAD: 1, USD: 1.4, CLP: 1 / 670 });
      expect(ledger.rateEntries.map((entry) => entry.id)).toEqual(['new', 'old']);
    });

    it('says when the rates were checked and whether an update is on its way', async () => {
      vi.mocked(apiFetch).mockResolvedValue({
        ...LEDGER,
        exchangeRatesCheckedAt: '2026-11-18T09:00:00Z',
        exchangeRatesUpdating: true,
      });
      const ledger = await fetchLedger(session());
      expect(ledger.ratesCheckedAt).toBe('2026-11-18T09:00:00Z');
      expect(ledger.ratesUpdating).toBe(true);
    });

    it('expects no update from a server that does not say one started', async () => {
      vi.mocked(apiFetch).mockResolvedValue(LEDGER);
      const ledger = await fetchLedger(session());
      expect(ledger.ratesCheckedAt).toBeNull();
      expect(ledger.ratesUpdating).toBe(false);
    });

    it('has no rates, rather than made-up ones, until the first ones arrive', async () => {
      vi.mocked(apiFetch).mockResolvedValue({ ...LEDGER, exchangeRates: [] });
      const ledger = await fetchLedger(session());
      expect(ledger.rates).toBeNull();
    });

    it('lets a failure through instead of returning an empty ledger', async () => {
      vi.mocked(apiFetch).mockRejectedValue(new ApiError(500, 'internal_error'));
      await expect(fetchLedger(session())).rejects.toMatchObject({ code: 'internal_error' });
    });
  });

  describe('an expired token', () => {
    it('renews the token once and repeats the call', async () => {
      vi.mocked(apiFetch)
        .mockRejectedValueOnce(new ApiError(401, 'unauthorized'))
        .mockResolvedValue(LEDGER);
      const auth = session({ renewToken: vi.fn().mockResolvedValue('token-2') });

      await fetchLedger(auth);
      expect(auth.renewToken).toHaveBeenCalledOnce();
      expect(vi.mocked(apiFetch).mock.calls[1]).toEqual(['/ledger', { token: 'token-2' }]);
    });

    it('reports the session as ended when it cannot be renewed', async () => {
      vi.mocked(apiFetch).mockRejectedValue(new ApiError(401, 'unauthorized'));
      const auth = session({ renewToken: vi.fn().mockResolvedValue(null) });

      await expect(fetchLedger(auth)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(apiFetch).toHaveBeenCalledOnce();
    });

    it('does not renew for any other refusal', async () => {
      vi.mocked(apiFetch).mockRejectedValue(new ApiError(403, 'forbidden'));
      const auth = session();
      await expect(fetchLedger(auth)).rejects.toMatchObject({ code: 'forbidden' });
      expect(auth.renewToken).not.toHaveBeenCalled();
    });
  });

  describe('reading expenses', () => {
    it('leaves out the filters that are not set', async () => {
      vi.mocked(apiFetch).mockResolvedValue({ revision: 1, expenses: [], nextCursor: null });
      await fetchExpenses(session(), { groupId: null, kind: null, limit: 50 });
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/expenses?limit=50');
    });

    it('sends the filters and the cursor', async () => {
      vi.mocked(apiFetch).mockResolvedValue({ revision: 1, expenses: [], nextCursor: null });
      await fetchExpenses(session(), { groupId: 'casa', kind: 'meal', cursor: 'abc+/=' });
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(
        '/expenses?groupId=casa&kind=meal&cursor=abc%2B%2F%3D',
      );
    });

    it('reads a later page of payments', async () => {
      vi.mocked(apiFetch).mockResolvedValue({ revision: 1, payments: [], nextCursor: null });
      await fetchPayments(session(), { limit: 50, cursor: 'abc' });
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/payments?limit=50&cursor=abc');
    });

    it('opens one expense by id', async () => {
      vi.mocked(apiFetch).mockResolvedValue({ id: 'e/1' });
      await fetchExpense(session(), 'e/1');
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/expenses/e%2F1');
    });
  });

  describe('writes', () => {
    beforeEach(() => {
      vi.mocked(apiFetch).mockResolvedValue({});
    });

    it.each([
      ['adds an expense', () => saveExpense(session(), { title: 'x' }), 'POST', '/expenses'],
      ['edits an expense', () => saveExpense(session(), { title: 'x' }, 'e1'), 'PUT', '/expenses/e1'],
      ['records a payment', () => recordPayment(session(), { title: 'x' }), 'POST', '/payments'],
      ['corrects a payment', () => updatePayment(session(), 'p/1', { title: 'x' }), 'PUT', '/payments/p%2F1'],
      ['creates a group', () => saveGroup(session(), { title: 'x' }), 'POST', '/groups'],
      ['changes a group', () => saveGroup(session(), { title: 'x' }, 'g1'), 'PUT', '/groups/g1'],
      ['saves the profile', () => saveProfile(session(), { title: 'x' }), 'PUT', '/me/profile'],
    ])('%s with the body unchanged', async (_name, write, method, path) => {
      await write();
      expect(apiFetch).toHaveBeenCalledWith(path, {
        method,
        body: { title: 'x' },
        token: 'token-1',
      });
    });

    it('asks for fresh rates with no body', async () => {
      await refreshExchangeRates(session());
      expect(apiFetch).toHaveBeenCalledWith('/exchange-rates/refresh', {
        method: 'POST',
        token: 'token-1',
      });
    });
  });
});
