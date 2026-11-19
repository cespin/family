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
  recordPayment,
  saveExpense,
} from '../lib/expenses.js';
import { ratesFromEntry } from '../lib/money.js';
import { DashboardScreen } from './DashboardScreen.jsx';

vi.mock('../hooks/useSession.js', () => ({ useSession: vi.fn() }));
vi.mock('../lib/expenses.js', () => ({
  fetchLedger: vi.fn(),
  fetchExpenses: vi.fn(),
  fetchExpense: vi.fn(),
  saveExpense: vi.fn(),
  recordPayment: vi.fn(),
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

// Currency formats use non-breaking spaces, which Testing Library collapses before comparing.
const shown = (text) => text.replace(/\s+/g, ' ');

function renderWith(data = ledger(), expenses = page()) {
  vi.mocked(fetchLedger).mockResolvedValue(data);
  vi.mocked(fetchExpenses).mockResolvedValue(expenses);
  render(<DashboardScreen />);
}

describe('DashboardScreen', () => {
  beforeEach(() => {
    for (const fn of [fetchLedger, fetchExpenses, fetchExpense, saveExpense, recordPayment]) {
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
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        splitMode: 'equal',
        participantIds: ['ana', 'leo'],
      });
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

    it('uses a new requestId for the next expense', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();
      await fillIn('Farmacia', '100');
      await submit();
      await waitFor(() =>
        expect(screen.getByLabelText(i18n.t('expenses:add.what')).value).toBe(''),
      );
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

    it('shows a failure to load it, not an empty expense', async () => {
      vi.mocked(fetchExpense).mockRejectedValue(new ApiError(404, 'not_found'));
      renderWith();
      await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
      expect(await screen.findByText(i18n.t('common:errors.not_found'))).toBeTruthy();
    });

    it('offers no Edit button to someone who did not add it', async () => {
      await openLunch();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:detail.edit') })).toBeNull();
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

    it('edits it with its version and without a date', async () => {
      const mine = detail({ addedBy: 'ana', payerId: 'ana' });
      vi.mocked(saveExpense).mockResolvedValue(mine);
      await openLunch(mine);
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:detail.edit') }));

      const title = await screen.findByLabelText(i18n.t('expenses:add.what'));
      expect(title.value).toBe('Almuerzo');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.save') }));

      const [, body, expenseId] = vi.mocked(saveExpense).mock.calls[0];
      expect(expenseId).toBe('lunch');
      expect(body.version).toBe(4);
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
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
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
});
