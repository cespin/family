import { ApiError } from './api.js';

// The expenses API does not exist yet. Until it does, a deployed build reports the module as
// unavailable instead of showing an empty ledger or a balance of zero. Replace the three throws
// below with apiFetch calls when the routes land. Sample data only ever loads in `npm run dev`:
// the condition is repeated in each function so the production build drops the import entirely.

export const UNAVAILABLE = 'expenses_unavailable';

export async function fetchLedger() {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_SESSION === '1') {
    const { sampleLedger } = await import('./expenses.sample.js');
    return sampleLedger();
  }
  throw new ApiError(0, UNAVAILABLE);
}

export async function saveExpense(expense) {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_SESSION === '1') {
    const { saveSampleExpense } = await import('./expenses.sample.js');
    return saveSampleExpense(expense);
  }
  throw new ApiError(0, UNAVAILABLE);
}

export async function saveSettlement(settlement) {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_SESSION === '1') {
    const { saveSampleSettlement } = await import('./expenses.sample.js');
    return saveSampleSettlement(settlement);
  }
  throw new ApiError(0, UNAVAILABLE);
}
