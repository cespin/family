import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/index.js';
import { formatCurrency, formatMinor } from '../i18n/format.js';
import { useSession } from '../hooks/useSession.js';
import { ApiError } from '../lib/api.js';
import {
  fetchExpense,
  fetchExpenses,
  fetchLedger,
  fetchPayments,
  recordPayment,
  saveExpense,
  saveProfile,
  updatePayment,
} from '../lib/expenses.js';
import { todayIso } from '../lib/ledger.js';
import { ratesFromEntry } from '../lib/money.js';
import { DashboardScreen } from './DashboardScreen.jsx';

vi.mock('../hooks/useSession.js', () => ({ useSession: vi.fn() }));
vi.mock('../lib/expenses.js', () => ({
  fetchLedger: vi.fn(),
  fetchExpenses: vi.fn(),
  fetchExpense: vi.fn(),
  saveExpense: vi.fn(),
  recordPayment: vi.fn(),
  fetchPayments: vi.fn(),
  updatePayment: vi.fn(),
  saveGroup: vi.fn(),
  saveExchangeRates: vi.fn(),
  saveProfile: vi.fn(),
}));

const RATES = ratesFromEntry({
  id: 'r1',
  usdCad: '1.40',
  cadClp: '670',
  date: '2026-11-18',
  enteredBy: 'leo',
});

const debt = (minor, currency, groupId = 'casa') => ({
  overall: [{ minor, currency }],
  groups: [{ groupId, amounts: [{ minor, currency }] }],
});

function ledger(overrides = {}) {
  return {
    revision: 1,
    me: 'ana',
    rates: RATES,
    rateEntries: [RATES],
    members: [
      { id: 'ana', name: 'Ana Pérez', tone: 'honey', currency: 'CAD', active: true },
      { id: 'leo', name: 'Leo', tone: 'clay', currency: 'CLP', active: true },
    ],
    groups: [
      { id: 'casa', name: 'Casa', createdBy: 'ana', memberIds: ['ana', 'leo'], usual: null, version: 1 },
    ],
    standings: [{ memberId: 'leo', ...debt(-33500, 'CLP') }],
    ...overrides,
  };
}

const LUNCH = {
  id: 'lunch',
  title: 'Almuerzo',
  kind: 'meal',
  groupId: 'casa',
  payerId: 'leo',
  addedBy: 'leo',
  amountMinor: 67000,
  currency: 'CLP',
  date: '2026-11-14',
  participantIds: ['ana', 'leo'],
  standing: { involved: true, openMinor: -33500, settled: false },
};

function detail(overrides = {}) {
  const { participantIds: _ids, ...item } = LUNCH;
  return {
    ...item,
    revision: 1,
    splitMode: 'equal',
    note: null,
    ratesId: 'r1',
    version: 4,
    participants: [
      { memberId: 'ana', shareMinor: 33500, status: 'owes' },
      { memberId: 'leo', shareMinor: 33500, status: 'paid' },
    ],
    appliedPayments: [],
    ...overrides,
  };
}

const page = (expenses = [LUNCH], nextCursor = null, revision = 1) => ({
  revision,
  expenses,
  nextCursor,
});

const SESSION = {
  member: { displayName: 'Ana Pérez', memberId: 'ana', homeCurrency: 'CAD' },
  signOut: vi.fn(),
  getToken: () => 'token',
  renewToken: vi.fn(),
  updateMember: vi.fn(),
};

const button = (name) => screen.findByRole('button', { name });

const TODAY = todayIso();

/** A day `days` after today, in the reader's time zone, as YYYY-MM-DD. */
function dayFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return todayIso(date);
}

/** Replaces the day in the date field, which starts at today. */
async function chooseDay(day) {
  const field = screen.getByLabelText(i18n.t('expenses:when.label'));
  await userEvent.clear(field);
  await userEvent.type(field, day);
}

// Currency formats use non-breaking spaces, which Testing Library collapses before comparing.
const shown = (text) => text.replace(/\s+/g, ' ');

function renderWith(data = ledger(), expenses = page()) {
  vi.mocked(fetchLedger).mockResolvedValue(data);
  vi.mocked(fetchExpenses).mockResolvedValue(expenses);
  render(<DashboardScreen />);
}

describe('DashboardScreen', () => {
  beforeEach(() => {
    for (const fn of [
      fetchLedger,
      fetchExpenses,
      fetchExpense,
      saveExpense,
      recordPayment,
      fetchPayments,
      updatePayment,
    ]) {
      vi.mocked(fn).mockReset();
    }
    vi.mocked(useSession).mockReturnValue(SESSION);
  });

  describe('when the ledger cannot be read', () => {
    it('shows the failure, not an empty list or a balance of zero', async () => {
      vi.mocked(fetchLedger).mockRejectedValue(new ApiError(500, 'internal_error'));
      render(<DashboardScreen />);

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(i18n.t('common:errors.internal_error'))).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:balance.even'))).toBeNull();
      expect(screen.queryByText(i18n.t('expenses:home.emptyTitle'))).toBeNull();
      expect(screen.queryByText(shown(formatCurrency(0, 'CAD')))).toBeNull();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:nav.add') })).toBeNull();
    });

    it('lets the family retry', async () => {
      vi.mocked(fetchLedger).mockRejectedValueOnce(new ApiError(500, 'internal_error'));
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(fetchExpenses).mockResolvedValue(page());
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('common:actions.retry')));
      expect(await screen.findByText(i18n.t('expenses:balance.youOwe'))).toBeTruthy();
    });
  });

  it('keeps the balances on screen when a reload after a save fails', async () => {
    vi.mocked(fetchLedger)
      .mockResolvedValueOnce(ledger())
      .mockRejectedValue(new ApiError(500, 'internal_error'));
    vi.mocked(fetchExpenses).mockResolvedValue(page());
    vi.mocked(recordPayment).mockResolvedValue({});
    render(<DashboardScreen />);

    await userEvent.click(await button(i18n.t('expenses:balance.settle')));
    await userEvent.click(
      screen.getByRole('button', {
        name: i18n.t('expenses:settle.submit', { amount: formatMinor(33500, 'CLP') }),
      }),
    );

    const reason = i18n.t('common:errors.internal_error');
    expect(await screen.findByText(i18n.t('expenses:home.stale', { reason }))).toBeTruthy();
    expect(screen.getByRole('heading', { name: i18n.t('expenses:settle.title') })).toBeTruthy();
    expect(screen.queryByText(i18n.t('expenses:home.failedBadge'))).toBeNull();
  });

  describe('balances', () => {
    it('shows what I owe in my currency and follows the chosen one', async () => {
      renderWith();

      expect(
        await screen.findByText(i18n.t('expenses:balance.youOweThem', { name: 'Leo' })),
      ).toBeTruthy();
      expect(screen.getAllByText(shown(formatMinor(5000, 'CAD'))).length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CLP') }));
      expect(screen.getAllByText(shown(formatMinor(33500, 'CLP'))).length).toBeGreaterThan(0);
    });

    it('marks the total as incomplete when there are no rates yet', async () => {
      renderWith(ledger({ rates: null, rateEntries: [] }));

      expect(await screen.findByText(i18n.t('expenses:balance.incomplete'))).toBeTruthy();
      expect(screen.getAllByText(i18n.t('common:status.noData')).length).toBeGreaterThan(0);
      expect(screen.getByText(i18n.t('expenses:rates.none'))).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:balance.even'))).toBeNull();
      expect(screen.queryByText(shown(formatCurrency(0, 'CAD')))).toBeNull();
    });

    it('still offers every currency when there are no rates yet', async () => {
      renderWith(ledger({ rates: null, rateEntries: [] }));
      await screen.findByText(i18n.t('expenses:balance.incomplete'));
      for (const code of ['CAD', 'USD', 'CLP']) {
        expect(screen.getByRole('button', { name: i18n.t(`expenses:currencies.${code}`) })).toBeTruthy();
      }
    });

    it('says everyone is square only when that is true', async () => {
      renderWith(ledger({ standings: [] }));
      expect(await screen.findByText(i18n.t('expenses:balance.even'))).toBeTruthy();
    });

    it('shows credit that has no group in a group both people belong to, and says so', async () => {
      // Leo gave Ana CAD 20 before they shared any expense, so the credit has no group.
      renderWith(
        ledger({
          standings: [
            {
              memberId: 'leo',
              overall: [{ minor: -2000, currency: 'CAD' }],
              groups: [{ groupId: null, amounts: [{ minor: -2000, currency: 'CAD' }] }],
            },
          ],
        }),
      );
      await screen.findByText(i18n.t('expenses:balance.youOweThem', { name: 'Leo' }));
      const ungrouped = i18n.t('expenses:balance.ungroupedPart', {
        amount: formatMinor(-2000, 'CAD'),
      });
      expect(screen.queryByText(shown(ungrouped), { exact: false })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Casa' }));
      expect(screen.getByText(i18n.t('expenses:balance.youOweThem', { name: 'Leo' }))).toBeTruthy();
      expect(screen.getByText(shown(ungrouped), { exact: false })).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:balance.even'))).toBeNull();
    });

    it('shows when the rates were entered, not that they are today’s', async () => {
      renderWith();
      expect(await screen.findByText(/1 USD = 1,40 CAD/)).toBeTruthy();
    });
  });

  describe('expenses', () => {
    it('shows a failure to load them, not an empty list', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(fetchExpenses).mockRejectedValue(new ApiError(0, 'generic'));
      render(<DashboardScreen />);

      expect(await screen.findByText(i18n.t('common:errors.generic'))).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:home.emptyTitle'))).toBeNull();
    });

    it('asks the API for the chosen kind and group instead of filtering in the browser', async () => {
      renderWith();
      await screen.findByRole('button', { name: /Almuerzo/ });

      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:filters.meal') }));
      await userEvent.click(screen.getByRole('button', { name: 'Casa' }));

      await waitFor(() =>
        expect(vi.mocked(fetchExpenses).mock.calls.at(-1)[1]).toMatchObject({
          groupId: 'casa',
          kind: 'meal',
        }),
      );
      expect(vi.mocked(fetchExpenses).mock.calls[0][1]).toMatchObject({ groupId: null, kind: null });
    });

    it('does not show a slow answer for filters that are no longer chosen', async () => {
      let answerAll;
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(fetchExpenses)
        .mockReturnValueOnce(new Promise((resolve) => (answerAll = resolve)))
        .mockResolvedValue(page([]));
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:filters.gift')));
      expect(await screen.findByText(i18n.t('expenses:home.emptyTitle'))).toBeTruthy();
      answerAll(page());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole('button', { name: /Almuerzo/ })).toBeNull();
    });

    it('shows a settled expense without an amount', async () => {
      const settled = { ...LUNCH, standing: { involved: true, openMinor: 0, settled: true } };
      renderWith(ledger(), page([settled]));

      const row = await screen.findByRole('button', { name: /Almuerzo/ });
      expect(within(row).getByText(i18n.t('expenses:row.settled'))).toBeTruthy();
      expect(within(row).queryByText(shown(formatMinor(0, 'CLP')))).toBeNull();
    });

    it('shows the reader’s part of an expense the list sent a split for', async () => {
      const split = {
        ...LUNCH,
        splitMode: 'equal',
        participants: [
          { memberId: 'ana', shareMinor: 33500 },
          { memberId: 'leo', shareMinor: 33500 },
        ],
      };
      renderWith(ledger(), page([split]));

      const row = await screen.findByRole('button', { name: /Almuerzo/ });
      expect(within(row).getByText(i18n.t('expenses:row.yourShareEqual', { total: 2 }))).toBeTruthy();
    });

    it('loads the next page after the ones on screen', async () => {
      const second = { ...LUNCH, id: 'taxi', title: 'Taxi', date: '2026-11-01' };
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(fetchExpenses)
        .mockResolvedValueOnce(page([LUNCH], 'next'))
        .mockResolvedValueOnce(page([second], null));
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:home.seeAll')));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:home.loadMore') }));

      expect(await screen.findByRole('button', { name: /Taxi/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Almuerzo/ })).toBeTruthy();
      expect(vi.mocked(fetchExpenses).mock.calls[1][1]).toMatchObject({ cursor: 'next' });
    });

    it('starts again from the first page when the ledger changed between pages', async () => {
      const stale = { ...LUNCH, id: 'taxi', title: 'Taxi' };
      const fresh = { ...LUNCH, id: 'cine', title: 'Cine' };
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(fetchExpenses)
        .mockResolvedValueOnce(page([LUNCH], 'next', 1))
        .mockResolvedValueOnce(page([stale], null, 2))
        .mockResolvedValueOnce(page([fresh, LUNCH], null, 2));
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:home.seeAll')));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:home.loadMore') }));

      expect(await screen.findByRole('button', { name: /Cine/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Taxi/ })).toBeNull();
      expect(vi.mocked(fetchExpenses).mock.calls[2][1].cursor).toBeUndefined();
    });

    it('offers to create the first group when there is none', async () => {
      renderWith(ledger({ groups: [], standings: [] }), page([]));

      expect(await screen.findByText(i18n.t('expenses:home.noGroupsTitle'))).toBeTruthy();
      expect(screen.getByRole('button', { name: i18n.t('expenses:groups.new') })).toBeTruthy();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:nav.add') })).toBeNull();
      expect(fetchExpenses).not.toHaveBeenCalled();
    });
  });

  describe('adding an expense', () => {
    async function openForm(data = ledger()) {
      renderWith(data);
      await userEvent.click(await button(i18n.t('expenses:nav.add')));
    }

    async function fillIn(title, amount) {
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.what')), title);
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.howMuch')), amount);
    }

    const submit = () =>
      userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.ready') }));

    it('sends exactly the fields the API takes, and no shares', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100,01');
      await submit();

      expect(saveExpense).toHaveBeenCalledOnce();
      const [auth, body, expenseId] = vi.mocked(saveExpense).mock.calls[0];
      expect(auth).toBe(SESSION);
      expect(expenseId).toBeUndefined();
      expect(body).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        title: 'Farmacia',
        kind: 'meal',
        groupId: 'casa',
        payerId: 'ana',
        amountMinor: 10001,
        currency: 'CAD',
        date: TODAY,
        transactionDate: TODAY,
        splitMode: 'equal',
        participantIds: ['ana', 'leo'],
      });
    });

    it('records the day the money was spent apart from the day it is entered', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Mercado de agosto', '50');
      await chooseDay('2026-08-03');
      await submit();

      const body = vi.mocked(saveExpense).mock.calls[0][1];
      expect(body.transactionDate).toBe('2026-08-03');
      expect(body.date).toBe(TODAY);
    });

    it('cannot be saved for a day that has not come yet', async () => {
      await openForm();
      await fillIn('Farmacia', '100');
      await chooseDay(dayFromToday(1));

      const save = screen.getByRole('button', { name: i18n.t('expenses:when.submitNeedDate') });
      expect(save.disabled).toBe(true);
      await userEvent.click(save);
      expect(saveExpense).not.toHaveBeenCalled();
    });

    it('sends the same requestId when retrying a save that failed', async () => {
      vi.mocked(saveExpense)
        .mockRejectedValueOnce(new ApiError(0, 'generic'))
        .mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();
      await screen.findByRole('alert');
      await submit();

      const [first, second] = vi.mocked(saveExpense).mock.calls.map((call) => call[1].requestId);
      expect(second).toBe(first);
    });

    const savedNote = () =>
      i18n.t('expenses:add.saved', {
        group: 'Casa',
        audience: i18n.t('expenses:add.audienceOne', { name: 'Leo' }),
      });

    it('goes back home once saved, and says where the expense went', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();

      expect(await screen.findByText(savedNote())).toBeTruthy();
      expect(screen.queryByLabelText(i18n.t('expenses:add.what'))).toBeNull();
      expect(screen.getByRole('button', { name: i18n.t('expenses:nav.add') })).toBeTruthy();
    });

    it('stays on the form, with no saved note, when the save fails', async () => {
      vi.mocked(saveExpense).mockRejectedValue(new ApiError(0, 'generic'));
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();

      await screen.findByRole('alert');
      expect(screen.getByLabelText(i18n.t('expenses:add.what')).value).toBe('Farmacia');
      expect(screen.queryByText(savedNote())).toBeNull();
    });

    it('drops the saved note on the next navigation', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();
      await screen.findByText(savedNote());

      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:nav.add') }));
      await userEvent.click(await button(i18n.t('expenses:add.close')));

      await button(i18n.t('expenses:nav.add'));
      expect(screen.queryByText(savedNote())).toBeNull();
    });

    it('uses a new requestId for the next expense', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();
      await userEvent.click(await button(i18n.t('expenses:nav.add')));
      await fillIn('Farmacia', '100');
      await submit();

      const [first, second] = vi.mocked(saveExpense).mock.calls.map((call) => call[1].requestId);
      expect(second).not.toBe(first);
    });

    it('sends percentages and a usual split that names every group member', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.modePercent') }));
      await submit();

      const body = vi.mocked(saveExpense).mock.calls[0][1];
      expect(body.percents).toEqual({ ana: 50, leo: 50 });
      expect(body.usualSplit).toEqual({ ana: 50, leo: 50 });
    });

    it('refuses to save percentages that do not reach 100', async () => {
      await openForm();
      await fillIn('Farmacia', '100');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.modePercent') }));
      await userEvent.click(
        screen.getByRole('button', { name: i18n.t('expenses:add.less', { name: 'Leo' }) }),
      );

      const percent = i18n.t('expenses:percent', { value: '5' });
      const submitButton = screen.getByRole('button', {
        name: i18n.t('expenses:add.submit.missing', { percent }),
      });
      expect(submitButton.disabled).toBe(true);
    });

    it('refuses an amount over the limit for its currency', async () => {
      await openForm();
      await fillIn('Auto', '10.000,01');
      const submitButton = screen.getByRole('button', {
        name: i18n.t('expenses:add.submit.checkAmount'),
      });
      expect(submitButton.disabled).toBe(true);
    });

    it('records a purchase charged in another currency, owed in what was charged', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Compra', '120.000');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CLP') }));
      await userEvent.click(screen.getByLabelText(i18n.t('expenses:add.chargedToggle')));
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.chargedAmount')), '185,40');
      await submit();

      expect(vi.mocked(saveExpense).mock.calls[0][1]).toMatchObject({
        amountMinor: 18540,
        currency: 'CAD',
        otherAmount: { amountMinor: 120000, currency: 'CLP' },
        chargedCurrency: 'CAD',
      });
    });

    it('can keep the debt in the receipt’s currency instead', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Compra', '120.000');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CLP') }));
      await userEvent.click(screen.getByLabelText(i18n.t('expenses:add.chargedToggle')));
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.chargedAmount')), '185,40');
      await userEvent.click(
        screen.getByRole('button', { name: i18n.t('expenses:add.debtReceipt', { currency: 'CLP' }) }),
      );
      await submit();

      expect(vi.mocked(saveExpense).mock.calls[0][1]).toMatchObject({
        amountMinor: 120000,
        currency: 'CLP',
        otherAmount: { amountMinor: 18540, currency: 'CAD' },
        chargedCurrency: 'CAD',
      });
    });

    const choose = (key) => userEvent.click(screen.getByRole('button', { name: i18n.t(key) }));
    const pressed = (key) =>
      screen.getByRole('button', { name: i18n.t(key) }).getAttribute('aria-pressed');

    it('sends "I pay nothing" as an equal split among everyone else', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await choose('expenses:add.modeTheirs');
      await submit();

      const body = vi.mocked(saveExpense).mock.calls[0][1];
      expect(body).toMatchObject({ payerId: 'ana', splitMode: 'equal', participantIds: ['leo'] });
      expect(body).not.toHaveProperty('percents');
      expect(body).not.toHaveProperty('usualSplit');
    });

    it('sends "I pay all" as a debt to whoever paid, which an advance can cover', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await userEvent.selectOptions(screen.getByLabelText(i18n.t('expenses:add.payer')), 'leo');
      await choose('expenses:add.modeMine');
      expect(
        screen.getByText(i18n.t('expenses:add.modeMineHint', { name: 'Leo' })),
      ).toBeTruthy();
      await submit();

      const body = vi.mocked(saveExpense).mock.calls[0][1];
      expect(body).toMatchObject({ payerId: 'leo', splitMode: 'equal', participantIds: ['ana'] });
      expect(body).not.toHaveProperty('percents');
    });

    it('reads "I" as me, not the payer, when someone else paid', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      const base = ledger();
      await openForm(
        ledger({
          members: [
            ...base.members,
            { id: 'mama', name: 'Mamá', tone: 'sage', currency: 'CLP', active: true },
          ],
          groups: [{ ...base.groups[0], memberIds: ['ana', 'leo', 'mama'] }],
        }),
      );
      const payer = () =>
        userEvent.selectOptions(screen.getByLabelText(i18n.t('expenses:add.payer')), 'leo');
      await fillIn('Farmacia', '100');
      await payer();
      await choose('expenses:add.modeTheirs');
      await submit();
      // A save goes home, so the next expense starts on a fresh form, with me as the payer again.
      await userEvent.click(await button(i18n.t('expenses:nav.add')));
      await fillIn('Farmacia', '100');
      await payer();
      await choose('expenses:add.modeMine');
      await submit();

      const [nothing, all] = vi.mocked(saveExpense).mock.calls.map((call) => call[1]);
      expect(nothing).toMatchObject({ payerId: 'leo', participantIds: ['leo', 'mama'] });
      expect(all).toMatchObject({ payerId: 'leo', participantIds: ['ana'] });
    });

    it('shows who is ticked as the choice, and ticks everyone again on an equal split', async () => {
      await openForm();
      await userEvent.click(screen.getByRole('checkbox', { name: /Leo/ }));
      expect(pressed('expenses:add.modeMine')).toBe('true');

      await choose('expenses:add.modeEqual');
      expect(pressed('expenses:add.modeEqual')).toBe('true');
      expect(screen.getByRole('checkbox', { name: /Leo/ }).checked).toBe(true);
    });

    it('keeps the form and explains when saving fails', async () => {
      vi.mocked(saveExpense).mockRejectedValue(new ApiError(403, 'forbidden'));
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(i18n.t('common:errors.forbidden'))).toBeTruthy();
      expect(screen.getByLabelText(i18n.t('expenses:add.what')).value).toBe('Farmacia');
    });
  });

  describe('an expense', () => {
    async function openLunch(full = detail()) {
      vi.mocked(fetchExpense).mockResolvedValue(full);
      renderWith();
      await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
      await screen.findByRole('heading', { name: 'Almuerzo' });
    }

    it('shows how it was split', async () => {
      await openLunch();
      expect(vi.mocked(fetchExpense).mock.calls[0][1]).toBe('lunch');
      expect(screen.getByRole('heading', { name: i18n.t('expenses:detail.splitTitle') })).toBeTruthy();
    });

    it('names who covers it all when only one person shares it', async () => {
      await openLunch(
        detail({ participants: [{ memberId: 'ana', shareMinor: 67000, status: 'owes' }] }),
      );
      expect(screen.getByText(i18n.t('expenses:detail.splitSingleYou'))).toBeTruthy();
    });

    it('shows a failure to load it, not an empty expense', async () => {
      vi.mocked(fetchExpense).mockRejectedValue(new ApiError(404, 'not_found'));
      renderWith();
      await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
      expect(await screen.findByText(i18n.t('common:errors.not_found'))).toBeTruthy();
    });

    it('offers no Edit button to someone who neither added nor paid it', async () => {
      await openLunch();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:detail.edit') })).toBeNull();
    });

    it('lets the payer who did not add it correct only the amounts, date and note', async () => {
      const paidByMe = detail({ payerId: 'ana', addedBy: 'leo' });
      vi.mocked(saveExpense).mockResolvedValue(paidByMe);
      await openLunch(paidByMe);
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:detail.edit') }));

      expect(
        await screen.findByText(i18n.t('expenses:add.payerOnly', { name: 'Leo' })),
      ).toBeTruthy();
      // `:disabled` also covers controls disabled through their fieldset.
      const locked = (element) => element.matches(':disabled');
      expect(locked(screen.getByLabelText(i18n.t('expenses:add.what')))).toBe(true);
      expect(locked(screen.getByLabelText(i18n.t('expenses:add.payer')))).toBe(true);
      expect(locked(screen.getByRole('checkbox', { name: /Leo/ }))).toBe(true);
      expect(locked(screen.getByRole('button', { name: 'Casa' }))).toBe(true);
      expect(locked(screen.getByLabelText(i18n.t('expenses:add.howMuch')))).toBe(false);

      const amount = screen.getByLabelText(i18n.t('expenses:add.howMuch'));
      await userEvent.clear(amount);
      await userEvent.type(amount, '70000');
      await chooseDay('2026-11-13');
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.note')), 'Con la tarjeta');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.save') }));

      const [, body, expenseId] = vi.mocked(saveExpense).mock.calls[0];
      expect(expenseId).toBe('lunch');
      expect(body).toMatchObject({
        title: 'Almuerzo',
        kind: 'meal',
        groupId: 'casa',
        payerId: 'ana',
        splitMode: 'equal',
        participantIds: ['ana', 'leo'],
        amountMinor: 70000,
        currency: 'CLP',
        transactionDate: '2026-11-13',
        note: 'Con la tarjeta',
        version: 4,
      });
      expect(body).not.toHaveProperty('usualSplit');
    });

    it('shows a payment in another currency with what it covered', async () => {
      await openLunch(
        detail({
          participants: [
            { memberId: 'ana', shareMinor: 33500, status: 'partly_paid' },
            { memberId: 'leo', shareMinor: 33500, status: 'paid' },
          ],
          standing: { involved: true, openMinor: -23500, settled: false },
          appliedPayments: [
            {
              paymentId: 'p1',
              fromId: 'ana',
              toId: 'leo',
              paidMinor: 1493,
              paidCurrency: 'CAD',
              coveredMinor: 10000,
              method: 'transfer',
              date: '2026-11-15',
            },
          ],
        }),
      );
      expect(screen.getByText(i18n.t('expenses:detail.status.partlyPaid'))).toBeTruthy();
      const covers = i18n.t('expenses:detail.amountCovers', {
        paid: formatMinor(1493, 'CAD'),
        covered: formatMinor(10000, 'CLP'),
      });
      expect(
        screen.getByText(shown(i18n.t('expenses:detail.activityYouPaid', { amount: covers, to: 'Leo' }))),
      ).toBeTruthy();
    });

    it('reads the new version after losing to someone else’s edit, keeping what was typed', async () => {
      const mine = detail({ addedBy: 'ana', payerId: 'ana' });
      vi.mocked(fetchExpense).mockResolvedValueOnce(mine).mockResolvedValueOnce(mine);
      vi.mocked(fetchExpense).mockResolvedValue({ ...mine, version: 5 });
      vi.mocked(saveExpense)
        .mockRejectedValueOnce(new ApiError(409, 'conflict'))
        .mockResolvedValue(mine);
      renderWith();
      await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
      await userEvent.click(await button(i18n.t('expenses:detail.edit')));

      const title = await screen.findByLabelText(i18n.t('expenses:add.what'));
      await userEvent.type(title, ' largo');
      const save = () =>
        userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.save') }));
      await save();
      expect(await screen.findByText(i18n.t('expenses:add.conflict'))).toBeTruthy();
      await waitFor(() => expect(fetchExpense).toHaveBeenCalledTimes(3));
      expect(title.value).toBe('Almuerzo largo');

      await save();
      const [first, second] = vi.mocked(saveExpense).mock.calls.map((call) => call[1]);
      expect(first.version).toBe(4);
      expect(second.version).toBe(5);
      expect(second.title).toBe('Almuerzo largo');
    });

    it('retries a payer’s correction with what the adder changed meanwhile', async () => {
      const paidByMe = detail({ payerId: 'ana', addedBy: 'leo' });
      vi.mocked(fetchExpense).mockResolvedValueOnce(paidByMe).mockResolvedValueOnce(paidByMe);
      vi.mocked(fetchExpense).mockResolvedValue({ ...paidByMe, title: 'Almuerzo del domingo', version: 5 });
      vi.mocked(saveExpense)
        .mockRejectedValueOnce(new ApiError(409, 'conflict'))
        .mockResolvedValue(paidByMe);
      renderWith();
      await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
      await userEvent.click(await button(i18n.t('expenses:detail.edit')));

      const note = await screen.findByLabelText(i18n.t('expenses:add.note'));
      await userEvent.type(note, 'Con la tarjeta');
      const save = () =>
        userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.save') }));
      await save();
      expect(await screen.findByText(i18n.t('expenses:add.conflict'))).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByLabelText(i18n.t('expenses:add.what')).value).toBe('Almuerzo del domingo'),
      );
      expect(note.value).toBe('Con la tarjeta');

      await save();
      const second = vi.mocked(saveExpense).mock.calls[1][1];
      expect(second.version).toBe(5);
      expect(second.title).toBe('Almuerzo del domingo');
      expect(second.note).toBe('Con la tarjeta');
    });

    it('edits it with its version and transaction date, and without the entry date', async () => {
      const mine = detail({ addedBy: 'ana', payerId: 'ana', transactionDate: '2026-11-10' });
      vi.mocked(saveExpense).mockResolvedValue(mine);
      await openLunch(mine);
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:detail.edit') }));

      const title = await screen.findByLabelText(i18n.t('expenses:add.what'));
      expect(title.value).toBe('Almuerzo');
      expect(screen.getByLabelText(i18n.t('expenses:when.label')).value).toBe('2026-11-10');
      await chooseDay('2026-10-30');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.save') }));

      const [, body, expenseId] = vi.mocked(saveExpense).mock.calls[0];
      expect(expenseId).toBe('lunch');
      expect(body.version).toBe(4);
      expect(body.transactionDate).toBe('2026-10-30');
      expect(body).not.toHaveProperty('date');
      expect(body.amountMinor).toBe(67000);
      expect(body.participantIds).toEqual(['ana', 'leo']);
    });
  });

  describe('settling up', () => {
    async function openSettle(data = ledger()) {
      vi.mocked(recordPayment).mockResolvedValue({});
      renderWith(data);
      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
    }

    const pay = (minor, currency) =>
      userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:settle.submit', { amount: formatMinor(minor, currency) }),
        }),
      );

    it('sends the exact debt as credited when paying it in full in another currency', async () => {
      await openSettle();
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CAD') }));
      await pay(5000, 'CAD');

      expect(recordPayment).toHaveBeenCalledOnce();
      expect(vi.mocked(recordPayment).mock.calls[0][1]).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        fromId: 'ana',
        toId: 'leo',
        paid: { amountMinor: 5000, currency: 'CAD' },
        credited: { amountMinor: 33500, currency: 'CLP' },
        method: 'transfer',
        date: TODAY,
        transactionDate: TODAY,
      });
    });

    it('sends only what was paid for a partial payment', async () => {
      await openSettle();
      const amount = screen.getByLabelText(i18n.t('expenses:settle.amountYouPay'));
      await userEvent.clear(amount);
      await userEvent.type(amount, '10.000');
      await pay(10000, 'CLP');

      const body = vi.mocked(recordPayment).mock.calls[0][1];
      expect(body.paid).toEqual({ amountMinor: 10000, currency: 'CLP' });
      expect(body).not.toHaveProperty('credited');
      expect(body).not.toHaveProperty('groupId');
    });

    describe('with debts in two groups', () => {
      function twoGroups() {
        const data = ledger();
        data.groups = [
          ...data.groups,
          { id: 'viaje', name: 'Viaje', createdBy: 'leo', memberIds: ['ana', 'leo'], usual: null, version: 1 },
        ];
        data.standings = [
          {
            memberId: 'leo',
            overall: [{ minor: -67000, currency: 'CLP' }],
            groups: [
              { groupId: 'casa', amounts: [{ minor: -33500, currency: 'CLP' }] },
              { groupId: 'viaje', amounts: [{ minor: -33500, currency: 'CLP' }] },
            ],
          },
        ];
        return data;
      }

      it('sends no group when the person does not choose one', async () => {
        await openSettle(twoGroups());
        await pay(67000, 'CLP');
        expect(vi.mocked(recordPayment).mock.calls[0][1]).not.toHaveProperty('groupId');
      });

      it('sends the group the person chose', async () => {
        await openSettle(twoGroups());
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await pay(67000, 'CLP');
        expect(vi.mocked(recordPayment).mock.calls[0][1].groupId).toBe('viaje');
      });

      it('lets the person undo the choice', async () => {
        await openSettle(twoGroups());
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await pay(67000, 'CLP');
        expect(vi.mocked(recordPayment).mock.calls[0][1]).not.toHaveProperty('groupId');
      });
    });

    it('does not ask for a group when the debt is in only one', async () => {
      await openSettle();
      expect(screen.queryByText(i18n.t('expenses:settle.groupQuestion'))).toBeNull();
    });

    it('does not move on to another person after a debt is cleared', async () => {
      const mia = { id: 'mia', name: 'Mía', tone: 'sage', currency: 'CAD', active: true };
      const before = ledger();
      before.members = [...before.members, mia];
      before.standings = [...before.standings, { memberId: 'mia', ...debt(-2000, 'CAD') }];
      const after = { ...before, standings: [{ memberId: 'mia', ...debt(-2000, 'CAD') }] };
      vi.mocked(fetchLedger).mockResolvedValueOnce(before).mockResolvedValue(after);
      vi.mocked(fetchExpenses).mockResolvedValue(page());
      vi.mocked(recordPayment).mockResolvedValue({});
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      await pay(33500, 'CLP');

      await screen.findByRole('button', {
        name: new RegExp(i18n.t('expenses:balance.youOweThem', { name: 'Mía' })),
      });
      expect(screen.queryByLabelText(i18n.t('expenses:settle.amountYouPay'))).toBeNull();
      expect(recordPayment).toHaveBeenCalledOnce();
    });
  });

  describe('settings', () => {
    const avatarOption = (emoji) =>
      screen.getByRole('radio', { name: i18n.t('common:avatar.option', { emoji }) });

    beforeEach(() => {
      vi.mocked(saveProfile).mockReset();
      vi.mocked(SESSION.updateMember).mockReset();
      vi.mocked(useSession).mockReturnValue({
        ...SESSION,
        member: { ...SESSION.member, avatar: '🐵' },
      });
    });

    async function openSettings() {
      renderWith();
      await userEvent.click(await button(i18n.t('expenses:settings.open')));
      await screen.findByRole('heading', { name: i18n.t('expenses:settings.title') });
    }

    it('starts at the saved avatar and saves only when it changes', async () => {
      await openSettings();
      expect(avatarOption('🐵').getAttribute('aria-checked')).toBe('true');
      const save = screen.getByRole('button', { name: i18n.t('expenses:settings.avatarSave') });
      expect(save.disabled).toBe(true);
      await userEvent.click(avatarOption('🦊'));
      expect(save.disabled).toBe(false);
    });

    it('changes the avatar and keeps the saved currency, even with another one picked', async () => {
      const answer = { ...SESSION.member, avatar: '🦊' };
      vi.mocked(saveProfile).mockResolvedValue(answer);
      await openSettings();
      // A currency picked but not saved must not ride along with the avatar.
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.USD') }));
      await userEvent.click(avatarOption('🦊'));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:settings.avatarSave') }));

      await waitFor(() => expect(SESSION.updateMember).toHaveBeenCalledWith(answer));
      const [auth, body] = vi.mocked(saveProfile).mock.calls[0];
      expect(auth.getToken).toBe(SESSION.getToken);
      expect(body).toEqual({ homeCurrency: 'CAD', avatar: '🦊' });
      expect(await screen.findByText(i18n.t('expenses:settings.avatarSaved', { avatar: '🦊' }))).toBeTruthy();
    });

    it('explains a refused avatar next to the avatar, not the currency', async () => {
      vi.mocked(saveProfile).mockRejectedValue(new ApiError(400, 'validation_error'));
      await openSettings();
      await userEvent.click(avatarOption('🦊'));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:settings.avatarSave') }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(i18n.t('common:errors.validation_error'));
      const avatarCard = screen.getByRole('radiogroup').closest('form');
      expect(within(avatarCard).getByRole('alert')).toBe(alert);
      expect(SESSION.updateMember).not.toHaveBeenCalled();
    });
  });

  describe('payments and advances', () => {
    const ADVANCE = {
      id: 'p1',
      fromId: 'leo',
      toId: 'ana',
      paid: { amountMinor: 20000, currency: 'CLP' },
      credited: { amountMinor: 20000, currency: 'CLP' },
      method: 'cash',
      date: '2026-11-19',
      transactionDate: '2026-11-19',
      groupId: null,
      version: 1,
    };
    const title = i18n.t('expenses:payments.gaveYou', {
      name: 'Leo',
      amount: formatMinor(20000, 'CLP'),
    });

    async function openPayments(payments = [ADVANCE]) {
      vi.mocked(fetchPayments).mockResolvedValue({ revision: 1, payments, nextCursor: null });
      renderWith();
      await userEvent.click(await button(i18n.t('expenses:balance.payments')));
      await screen.findByRole('heading', { name: i18n.t('expenses:payments.title') });
    }

    it('corrects the day an advance was given, sending only the day and its version', async () => {
      vi.mocked(updatePayment).mockResolvedValue({ ...ADVANCE, transactionDate: '2026-08-05', version: 2 });
      await openPayments();
      await userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
      expect(screen.getByLabelText(i18n.t('expenses:when.label')).value).toBe('2026-11-19');
      await chooseDay('2026-08-05');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:payments.save') }));

      expect(updatePayment).toHaveBeenCalledOnce();
      const [auth, id, body] = vi.mocked(updatePayment).mock.calls[0];
      expect(auth).toBe(SESSION);
      expect(id).toBe('p1');
      expect(body).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        transactionDate: '2026-08-05',
        version: 1,
      });
      await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
      expect(screen.queryByLabelText(i18n.t('expenses:when.label'))).toBeNull();
    });

    it('reloads the payment when someone else changed it first', async () => {
      vi.mocked(updatePayment).mockRejectedValue(new ApiError(409, 'conflict'));
      await openPayments();
      await userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
      await chooseDay('2026-08-05');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:payments.save') }));

      expect(await screen.findByText(i18n.t('expenses:payments.conflict'))).toBeTruthy();
      await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
    });

    it('cannot move a payment to a day that has not come yet', async () => {
      await openPayments();
      await userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
      await chooseDay(dayFromToday(1));
      const save = screen.getByRole('button', { name: i18n.t('expenses:when.submitNeedDate') });
      expect(save.disabled).toBe(true);
      expect(updatePayment).not.toHaveBeenCalled();
    });

    it('shows a failed load as a failure, not as having no payments', async () => {
      vi.mocked(fetchPayments).mockRejectedValue(new ApiError(500, 'internal_error'));
      renderWith();
      await userEvent.click(await button(i18n.t('expenses:balance.payments')));

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(i18n.t('common:errors.internal_error'))).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:payments.emptyTitle'))).toBeNull();
    });
  });

  describe('recording an advance', () => {
    const PAPA = { id: 'papa', name: 'Papá', tone: 'sage', currency: 'USD', active: true };
    const ROSA = { id: 'rosa', name: 'Rosa', tone: 'clay', currency: 'CLP', active: false };

    // Everyone is even, and Papá shares no expense with Ana, so he has no standing at all.
    function evenLedger(overrides = {}) {
      const data = ledger({ standings: [], ...overrides });
      data.members = [...data.members, PAPA, ROSA];
      return data;
    }

    async function openAdvance(data = evenLedger()) {
      renderWith(data);
      await userEvent.click(await button(i18n.t('expenses:balance.advance')));
      await screen.findByRole('heading', { name: i18n.t('expenses:advance.title') });
    }

    const pick = (name) => userEvent.click(screen.getByRole('button', { name }));

    async function fill({ person = 'Papá', direction = 'theyGave', amount = '2.000', currency }) {
      await pick(person);
      await pick(i18n.t(`expenses:advance.${direction}`, { name: person }));
      if (currency) await pick(i18n.t(`expenses:currencies.${currency}`));
      const label =
        direction === 'theyGave'
          ? i18n.t('expenses:advance.amountTheyGave')
          : i18n.t('expenses:advance.amountIGave');
      await userEvent.type(screen.getByLabelText(label), amount);
    }

    const submit = (minor, currency) =>
      userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:advance.submit', { amount: formatMinor(minor, currency) }),
        }),
      );

    it('is offered when every balance is even, where settling up is not', async () => {
      renderWith(evenLedger());
      expect(await button(i18n.t('expenses:balance.advance'))).toBeTruthy();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:balance.settle') })).toBeNull();
    });

    it('offers only other active members', async () => {
      await openAdvance();
      expect(screen.getByRole('button', { name: 'Leo' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Papá' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Rosa' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ana Pérez' })).toBeNull();
    });

    it('cannot be saved until the person, who gave the money and the amount are all chosen', async () => {
      await openAdvance();
      const disabled = (key) => screen.getByRole('button', { name: i18n.t(key) }).disabled;
      expect(disabled('expenses:advance.submitNeedPerson')).toBe(true);

      await pick('Papá');
      expect(disabled('expenses:advance.submitNeedDirection')).toBe(true);
      // Nothing is chosen for them: money recorded the wrong way would flip the balance.
      for (const option of ['theyGave', 'iGave']) {
        const choice = screen.getByRole('button', {
          name: i18n.t(`expenses:advance.${option}`, { name: 'Papá' }),
        });
        expect(choice.getAttribute('aria-pressed')).toBe('false');
      }

      await pick(i18n.t('expenses:advance.theyGave', { name: 'Papá' }));
      expect(disabled('expenses:advance.submitNeedAmount')).toBe(true);
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it('records money they gave me, in their currency, with nothing else', async () => {
      vi.mocked(recordPayment).mockResolvedValue({});
      await openAdvance();
      await fill({});
      await submit(200000, 'USD');

      expect(recordPayment).toHaveBeenCalledOnce();
      expect(vi.mocked(recordPayment).mock.calls[0][1]).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        fromId: 'papa',
        toId: 'ana',
        paid: { amountMinor: 200000, currency: 'USD' },
        method: 'transfer',
        date: TODAY,
        transactionDate: TODAY,
      });
    });

    it('records an advance given months ago on the day it was given', async () => {
      vi.mocked(recordPayment).mockResolvedValue({});
      await openAdvance();
      await fill({});
      await chooseDay('2026-08-05');
      await submit(200000, 'USD');

      const body = vi.mocked(recordPayment).mock.calls[0][1];
      expect(body.transactionDate).toBe('2026-08-05');
      expect(body.date).toBe(TODAY);
    });

    it('records money I gave them the other way round', async () => {
      vi.mocked(recordPayment).mockResolvedValue({});
      await openAdvance();
      await fill({ direction: 'iGave', amount: '500' });
      await submit(50000, 'CAD');

      const body = vi.mocked(recordPayment).mock.calls[0][1];
      expect(body.fromId).toBe('ana');
      expect(body.toId).toBe('papa');
      expect(body.paid).toEqual({ amountMinor: 50000, currency: 'CAD' });
    });

    it('says the whole advance becomes credit, exactly as given, when nothing is owed', async () => {
      await openAdvance();
      // Papá uses USD: the credit is kept in CAD, so it must not show as a conversion.
      await fill({ currency: 'CAD', amount: '100' });
      const amount = formatMinor(10000, 'CAD');
      expect(
        screen.getByText(
          shown(
            i18n.t('expenses:advance.status.creditTheyGave', {
              name: 'Papá',
              amount,
              credit: amount,
            }),
          ),
        ),
      ).toBeTruthy();
    });

    it('says it first covers what the giver owes, and how much is left as credit', async () => {
      // Ana owes Leo CLP 33.500, and gives him CLP 50.000.
      await openAdvance(evenLedger({ standings: [{ memberId: 'leo', ...debt(-33500, 'CLP') }] }));
      await fill({ person: 'Leo', direction: 'iGave', amount: '50.000', currency: 'CLP' });
      expect(
        screen.getByText(
          shown(
            i18n.t('expenses:advance.status.coversIGave', {
              name: 'Leo',
              amount: formatMinor(50000, 'CLP'),
              covered: formatMinor(33500, 'CLP'),
              credit: formatMinor(16500, 'CLP'),
            }),
          ),
        ),
      ).toBeTruthy();
    });

    it('says the debt grows when the person already owed gives money the other way', async () => {
      // Ana owes Leo CLP 33.500, and Leo gives her CLP 10.000 more.
      await openAdvance(evenLedger({ standings: [{ memberId: 'leo', ...debt(-33500, 'CLP') }] }));
      await fill({ person: 'Leo', amount: '10.000', currency: 'CLP' });
      expect(
        screen.getByText(
          shown(
            i18n.t('expenses:advance.status.growsTheyGave', {
              name: 'Leo',
              amount: formatMinor(10000, 'CLP'),
              owed: formatMinor(33500, 'CLP'),
              total: formatMinor(43500, 'CLP'),
            }),
          ),
        ),
      ).toBeTruthy();
    });

    it('is offered from settling up once the last debt is cleared', async () => {
      vi.mocked(fetchLedger).mockResolvedValueOnce(ledger()).mockResolvedValue(evenLedger());
      vi.mocked(fetchExpenses).mockResolvedValue(page());
      vi.mocked(recordPayment).mockResolvedValue({});
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      await userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:settle.submit', { amount: formatMinor(33500, 'CLP') }),
        }),
      );
      await screen.findByText(i18n.t('expenses:settle.evenTitle'));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:balance.advance') }));
      expect(
        await screen.findByRole('heading', { name: i18n.t('expenses:advance.title') }),
      ).toBeTruthy();
    });

    it('can be saved without exchange rates, and then gives no figure it cannot work out', async () => {
      vi.mocked(recordPayment).mockResolvedValue({});
      await openAdvance(evenLedger({ rates: null, rateEntries: [] }));
      await fill({ currency: 'CAD', amount: '100' });

      const amount = formatMinor(10000, 'CAD');
      expect(
        screen.getByText(
          shown(i18n.t('expenses:advance.status.plainTheyGave', { name: 'Papá', amount })),
        ),
      ).toBeTruthy();
      await submit(10000, 'CAD');
      expect(vi.mocked(recordPayment).mock.calls[0][1].paid).toEqual({
        amountMinor: 10000,
        currency: 'CAD',
      });
    });

    it('empties the form after saving, so a second tap cannot record it twice', async () => {
      vi.mocked(recordPayment).mockResolvedValue({});
      await openAdvance();
      await fill({});
      await submit(200000, 'USD');

      expect(
        await screen.findByText(
          shown(
            i18n.t('expenses:advance.doneTheyGave', {
              name: 'Papá',
              amount: formatMinor(200000, 'USD'),
            }),
          ),
        ),
      ).toBeTruthy();
      const papa = await screen.findByRole('button', { name: 'Papá' });
      expect(papa.getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByLabelText(i18n.t('expenses:advance.amountTheyGave'))).toBeNull();
      expect(
        screen.getByRole('button', { name: i18n.t('expenses:advance.submitNeedPerson') }).disabled,
      ).toBe(true);
      expect(recordPayment).toHaveBeenCalledOnce();
    });

    it('sends the same requestId when retrying a save that failed', async () => {
      vi.mocked(recordPayment)
        .mockRejectedValueOnce(new ApiError(0, 'generic'))
        .mockResolvedValue({});
      await openAdvance();
      await fill({});
      await submit(200000, 'USD');
      await screen.findByRole('alert');
      await submit(200000, 'USD');

      const [first, second] = vi.mocked(recordPayment).mock.calls.map((call) => call[1]);
      expect(second.requestId).toBe(first.requestId);
    });
  });
});
