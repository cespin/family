import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLedger } from '../lib/expenses.js';
import { RATES_FOLLOW_UP_MS, useLedger } from './useLedger.js';
import { useSession } from './useSession.js';

vi.mock('../lib/expenses.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLedger: vi.fn(),
}));
vi.mock('./useSession.js', () => ({ useSession: vi.fn() }));

// The same functions on every render, as the provider gives them, so the effect runs once.
const SESSION = { getToken: () => 'token', renewToken: async () => 'token' };

const ledger = (ratesUpdating) => ({ revision: 1, rates: null, ratesUpdating });

/** Lets the mocked fetch resolve and its state update land. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useLedger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchLedger).mockReset();
    vi.mocked(useSession).mockReturnValue(SESSION);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads again once the update the server started has had time to finish', async () => {
    vi.mocked(fetchLedger).mockResolvedValueOnce(ledger(true)).mockResolvedValue(ledger(false));
    const { result } = renderHook(() => useLedger());
    await settle();
    expect(result.current.ledger.ratesUpdating).toBe(true);
    expect(fetchLedger).toHaveBeenCalledTimes(1);

    await settle(RATES_FOLLOW_UP_MS);
    expect(fetchLedger).toHaveBeenCalledTimes(2);
    expect(result.current.ledger.ratesUpdating).toBe(false);
  });

  it('never turns a slow update into polling', async () => {
    vi.mocked(fetchLedger).mockResolvedValue(ledger(true));
    renderHook(() => useLedger());
    await settle();
    await settle(RATES_FOLLOW_UP_MS);
    await settle(RATES_FOLLOW_UP_MS * 3);
    expect(fetchLedger).toHaveBeenCalledTimes(2);
  });

  it('reads only once when no update was started', async () => {
    vi.mocked(fetchLedger).mockResolvedValue(ledger(false));
    renderHook(() => useLedger());
    await settle();
    await settle(RATES_FOLLOW_UP_MS * 2);
    expect(fetchLedger).toHaveBeenCalledTimes(1);
  });
});
