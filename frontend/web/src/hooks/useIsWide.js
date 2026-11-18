import { useSyncExternalStore } from 'react';

// Wide enough for the balances and the expenses to sit side by side.
const WIDE_QUERY = '(min-width: 60rem)';

function subscribe(onChange) {
  const query = window.matchMedia?.(WIDE_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function isWideNow() {
  return window.matchMedia?.(WIDE_QUERY).matches ?? false;
}

export function useIsWide() {
  return useSyncExternalStore(subscribe, isWideNow);
}
