import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchExpenses } from '../lib/expenses.js';
import { useTitleHistory } from './useTitleHistory.js';
import { useSession } from './useSession.js';

vi.mock('../lib/expenses.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchExpenses: vi.fn(),
}));
vi.mock('./useSession.js', () => ({ useSession: vi.fn() }));

// The same functions on every render, as the provider gives them, so the effect runs once.
const SESSION = { getToken: () => 'token', renewToken: async () => 'token' };

const page = (titles, nextCursor) => ({
  revision: 1,
  expenses: titles.map((title) => ({ title, transactionDate: '2026-11-04', kind: 'other' })),
  nextCursor,
});

describe('useTitleHistory', () => {
  beforeEach(() => {
    vi.mocked(fetchExpenses).mockReset();
    vi.mocked(useSession).mockReturnValue(SESSION);
  });

  it('follows the cursor and joins the pages, newest first', async () => {
    vi.mocked(fetchExpenses)
      .mockResolvedValueOnce(page(['Jumbo El Llano'], 'next'))
      .mockResolvedValueOnce(page(['Jumbo Ñuñoa Santiago'], null));
    const { result } = renderHook(() => useTitleHistory());
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((entry) => entry.title)).toEqual([
      'Jumbo El Llano',
      'Jumbo Ñuñoa Santiago',
    ]);
    expect(fetchExpenses).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchExpenses).mock.calls[0][1]).toEqual({ limit: 100, cursor: null });
    expect(vi.mocked(fetchExpenses).mock.calls[1][1]).toEqual({ limit: 100, cursor: 'next' });
  });

  it('stops after 1000 expenses', async () => {
    vi.mocked(fetchExpenses).mockImplementation(async () => page(['Té'], 'more'));
    const { result } = renderHook(() => useTitleHistory());
    await waitFor(() => expect(result.current).toHaveLength(10));
    expect(fetchExpenses).toHaveBeenCalledTimes(10);
  });

  it('keeps the titles already read when a later page fails', async () => {
    vi.mocked(fetchExpenses)
      .mockResolvedValueOnce(page(['Jumbo El Llano'], 'next'))
      .mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'generic' }));
    const { result } = renderHook(() => useTitleHistory());
    await waitFor(() => expect(fetchExpenses).toHaveBeenCalledTimes(2));
    expect(result.current.map((entry) => entry.title)).toEqual(['Jumbo El Llano']);
  });
});
