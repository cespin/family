import { apiFetch } from './api.js';
import { ratesFromEntry } from './money.js';

// The seam between the expense screens and the expenses API. Every call goes through here, and
// API field names become the ones the screens use (`displayName` becomes `name`, and so on).
// The contract is backend/docs/api-contract.md.
//
// `auth` is the session from useSession: `getToken()` reads the ID token when the call is made,
// and `renewToken()` replaces an expired one. Under `npm run dev` with the mock session, calls go to
// the in-memory sample instead. The condition is spelled out so the production build drops the
// sample's import entirely.

async function call(auth, path, options = {}) {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_SESSION === '1') {
    const { sampleApi } = await import('./expenses.sample.js');
    return sampleApi(path, options);
  }
  try {
    return await apiFetch(path, { ...options, token: auth.getToken() });
  } catch (error) {
    // A 401 means the ID token expired before the scheduled renewal. The authorizer refused the
    // request before any handler ran, so sending it again with a fresh token cannot repeat a write.
    if (error?.status !== 401 || !auth.renewToken) throw error;
    const token = await auth.renewToken();
    if (!token) throw error;
    return apiFetch(path, { ...options, token });
  }
}

const money = ({ amountMinor, currency }) => ({ minor: amountMinor, currency });

function toMember(member) {
  return {
    id: member.id,
    name: member.displayName,
    currency: member.homeCurrency,
    tone: member.tone ?? undefined,
    active: member.active,
  };
}

function toGroup(group) {
  return {
    id: group.id,
    name: group.name,
    createdBy: group.createdBy,
    memberIds: group.memberIds,
    usual: group.usualSplit ?? null,
    version: group.version,
  };
}

function toStanding(standing) {
  return {
    memberId: standing.memberId,
    overall: standing.overall.map(money),
    groups: standing.groups.map((group) => ({
      groupId: group.groupId,
      amounts: group.amounts.map(money),
    })),
  };
}

/** Members, groups, exchange rates and the caller's standings with everyone. */
export async function fetchLedger(auth) {
  const data = await call(auth, '/ledger');
  const rateEntries = data.exchangeRates.map(ratesFromEntry).filter(Boolean);
  return {
    revision: data.revision,
    me: data.me,
    members: data.members.map(toMember),
    groups: data.groups.map(toGroup),
    // Newest first, so the first entry is the one in force today. Null until rates are entered.
    rates: rateEntries[0] ?? null,
    rateEntries,
    standings: data.standings.map(toStanding),
  };
}

/** One page of expenses, newest first. `groupId` and `kind` are left out to mean every one. */
export async function fetchExpenses(auth, { groupId, kind, cursor, limit } = {}) {
  const query = new URLSearchParams();
  if (groupId) query.set('groupId', groupId);
  if (kind) query.set('kind', kind);
  if (limit) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  const search = query.toString();
  return call(auth, `/expenses${search ? `?${search}` : ''}`);
}

/** One expense in full: shares, payments applied to it, and its `version` for editing. */
export async function fetchExpense(auth, expenseId) {
  return call(auth, `/expenses/${encodeURIComponent(expenseId)}`);
}

/** Adds an expense, or edits one when `expenseId` is given. The server computes the shares. */
export async function saveExpense(auth, body, expenseId) {
  return expenseId
    ? call(auth, `/expenses/${encodeURIComponent(expenseId)}`, { method: 'PUT', body })
    : call(auth, '/expenses', { method: 'POST', body });
}

export async function recordPayment(auth, body) {
  return call(auth, '/payments', { method: 'POST', body });
}

/** Creates a group, or changes one when `groupId` is given. */
export async function saveGroup(auth, body, groupId) {
  return groupId
    ? call(auth, `/groups/${encodeURIComponent(groupId)}`, { method: 'PUT', body })
    : call(auth, '/groups', { method: 'POST', body });
}

export async function saveExchangeRates(auth, body) {
  return call(auth, '/exchange-rates', { method: 'POST', body });
}

/** The first sign-in step, and later changes of home currency. Answers in the `GET /api/me` shape. */
export async function saveProfile(auth, body) {
  return call(auth, '/me/profile', { method: 'PUT', body });
}
