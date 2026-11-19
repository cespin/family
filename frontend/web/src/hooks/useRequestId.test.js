import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRequestId } from './useRequestId.js';

describe('useRequestId', () => {
  it('replays the first attempt, date included, when the same save is retried after midnight', () => {
    const { result } = renderHook(() => useRequestId());
    const first = result.current.prepare({ title: 'Pan', date: '2026-11-18' });
    const retry = result.current.prepare({ title: 'Pan', date: '2026-11-19' });
    expect(retry).toEqual(first);
    expect(retry.date).toBe('2026-11-18');
  });

  it('treats a changed transaction date as a new save, which the API would refuse under the old id', () => {
    const { result } = renderHook(() => useRequestId());
    const first = result.current.prepare({ title: 'Pan', date: '2026-11-18', transactionDate: '2026-11-18' });
    const corrected = result.current.prepare({
      title: 'Pan',
      date: '2026-11-18',
      transactionDate: '2026-08-03',
    });
    expect(corrected.requestId).not.toBe(first.requestId);
    expect(corrected.transactionDate).toBe('2026-08-03');
  });

  it('treats changed content as a new save', () => {
    const { result } = renderHook(() => useRequestId());
    const first = result.current.prepare({ title: 'Pan' });
    const changed = result.current.prepare({ title: 'Pan dulce' });
    expect(changed.requestId).not.toBe(first.requestId);
  });

  it('starts a new save after one succeeds, even with the same content', () => {
    const { result } = renderHook(() => useRequestId());
    const first = result.current.prepare({ title: 'Pan' });
    result.current.done();
    expect(result.current.prepare({ title: 'Pan' }).requestId).not.toBe(first.requestId);
  });
});
