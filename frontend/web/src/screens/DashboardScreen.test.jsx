import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/index.js';
import { formatCurrency, formatMinor } from '../i18n/format.js';
import { useSession } from '../hooks/useSession.js';
import { ApiError } from '../lib/api.js';
import { UNAVAILABLE, fetchLedger, saveExpense, saveSettlement } from '../lib/expenses.js';
import { DashboardScreen } from './DashboardScreen.jsx';

vi.mock('../hooks/useSession.js', () => ({ useSession: vi.fn() }));
vi.mock('../lib/expenses.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLedger: vi.fn(),
  saveExpense: vi.fn(),
  saveSettlement: vi.fn(),
}));

const RATES = { base: 'CAD', asOf: '2026-11-18', toBase: { CAD: 1, USD: 1.4, CLP: 1 / 670 } };

function ledger(overrides = {}) {
  return {
    me: 'ana',
    rates: RATES,
    members: [
      { id: 'ana', name: 'Ana Pérez', tone: 'honey', currency: 'CAD' },
      { id: 'leo', name: 'Leo', tone: 'clay', currency: 'CLP' },
    ],
    groups: [{ id: 'casa', name: 'Casa', memberIds: ['ana', 'leo'] }],
    settlements: [],
    expenses: [
      {
        id: 'lunch',
        title: 'Almuerzo',
        kind: 'meal',
        groupId: 'casa',
        payerId: 'leo',
        addedById: 'leo',
        amountMinor: 67000,
        currency: 'CLP',
        date: '2026-11-14',
        splitMode: 'equal',
        shares: { ana: 33500, leo: 33500 },
      },
    ],
    ...overrides,
  };
}

const button = (name) => screen.findByRole('button', { name });

// Currency formats use non-breaking spaces, which Testing Library collapses before comparing.
const shown = (text) => text.replace(/\s+/g, ' ');

describe('DashboardScreen', () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReset();
    vi.mocked(fetchLedger).mockReset();
    vi.mocked(saveExpense).mockReset();
    vi.mocked(saveSettlement).mockReset();
    vi.mocked(useSession).mockReturnValue({
      member: { name: 'Ana Pérez' },
      signOut: vi.fn(),
    });
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
    });

    it('offers no way to add an expense that could not be saved', async () => {
      vi.mocked(fetchLedger).mockRejectedValue(new ApiError(0, UNAVAILABLE));
      render(<DashboardScreen />);

      expect(await screen.findByText(i18n.t('common:errors.expenses_unavailable'))).toBeTruthy();
      expect(screen.queryByText(i18n.t('expenses:balance.even'))).toBeNull();
      expect(screen.queryByRole('button', { name: i18n.t('expenses:nav.add') })).toBeNull();
      expect(screen.queryByRole('button', { name: i18n.t('common:actions.retry') })).toBeNull();
    });

    it('lets the family retry a failure that can pass', async () => {
      vi.mocked(fetchLedger).mockRejectedValueOnce(new ApiError(500, 'internal_error'));
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('common:actions.retry')));
      expect(await screen.findByText(i18n.t('expenses:balance.youOwe'))).toBeTruthy();
    });
  });

  describe('balances', () => {
    it('shows what I owe in my currency and follows the chosen one', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      render(<DashboardScreen />);

      const debt = await screen.findByText(i18n.t('expenses:balance.youOweThem', { name: 'Leo' }));
      expect(debt).toBeTruthy();
      expect(screen.getAllByText(shown(formatMinor(5000, 'CAD'))).length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CLP') }));
      expect(screen.getAllByText(shown(formatMinor(33500, 'CLP'))).length).toBeGreaterThan(0);
    });

    it('marks the total as incomplete when a rate is missing', async () => {
      const rates = { base: 'CAD', toBase: { CAD: 1, USD: 1.4 } };
      vi.mocked(fetchLedger).mockResolvedValue(ledger({ rates }));
      render(<DashboardScreen />);

      expect(await screen.findByText(i18n.t('expenses:balance.incomplete'))).toBeTruthy();
      expect(screen.getAllByText(i18n.t('common:status.noData')).length).toBeGreaterThan(0);
      expect(screen.queryByText(i18n.t('expenses:balance.even'))).toBeNull();
      expect(screen.queryByText(shown(formatCurrency(0, 'CAD')))).toBeNull();
    });

    it('says everyone is square only when that is true', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger({ expenses: [] }));
      render(<DashboardScreen />);

      expect(await screen.findByText(i18n.t('expenses:balance.even'))).toBeTruthy();
    });
  });

  describe('adding an expense', () => {
    async function openForm() {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      render(<DashboardScreen />);
      await userEvent.click(await button(i18n.t('expenses:nav.add')));
    }

    it('saves shares that add up to exactly what was paid', async () => {
      vi.mocked(saveExpense).mockResolvedValue({});
      await openForm();

      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.what')), 'Farmacia');
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.howMuch')), '100,01');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.ready') }));

      expect(saveExpense).toHaveBeenCalledOnce();
      const saved = vi.mocked(saveExpense).mock.calls[0][0];
      expect(saved.amountMinor).toBe(10001);
      expect(saved.currency).toBe('CAD');
      expect(saved.shares.ana + saved.shares.leo).toBe(10001);
    });

    it('refuses to save percentages that do not reach 100', async () => {
      await openForm();

      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.what')), 'Farmacia');
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.howMuch')), '100');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.modePercent') }));
      await userEvent.click(
        screen.getByRole('button', { name: i18n.t('expenses:add.less', { name: 'Leo' }) }),
      );

      const percent = i18n.t('expenses:percent', { value: '5' });
      const submit = screen.getByRole('button', {
        name: i18n.t('expenses:add.submit.missing', { percent }),
      });
      expect(submit.disabled).toBe(true);
    });

    it('keeps the form and explains when saving fails', async () => {
      vi.mocked(saveExpense).mockRejectedValue(new ApiError(403, 'forbidden'));
      await openForm();

      const title = screen.getByLabelText(i18n.t('expenses:add.what'));
      await userEvent.type(title, 'Farmacia');
      await userEvent.type(screen.getByLabelText(i18n.t('expenses:add.howMuch')), '100');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:add.submit.ready') }));

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(i18n.t('common:errors.forbidden'))).toBeTruthy();
      expect(title.value).toBe('Farmacia');
    });
  });

  describe('settling up', () => {
    it('clears the exact debt when paying the full amount in another currency', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(saveSettlement).mockResolvedValue({});
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CAD') }));
      await userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:settle.submit', { amount: formatMinor(5000, 'CAD') }),
        }),
      );

      expect(saveSettlement).toHaveBeenCalledOnce();
      expect(vi.mocked(saveSettlement).mock.calls[0][0]).toMatchObject({
        fromId: 'ana',
        toId: 'leo',
        amountMinor: 33500,
        currency: 'CLP',
        paidMinor: 5000,
        paidCurrency: 'CAD',
      });
    });

    describe('with debts in two groups', () => {
      function twoGroups() {
        const data = ledger();
        data.groups = [...data.groups, { id: 'viaje', name: 'Viaje', memberIds: ['ana', 'leo'] }];
        data.expenses = [
          ...data.expenses,
          { ...data.expenses[0], id: 'hotel', title: 'Hotel', groupId: 'viaje', date: '2026-11-01' },
        ];
        return data;
      }

      async function openSettle() {
        vi.mocked(fetchLedger).mockResolvedValue(twoGroups());
        vi.mocked(saveSettlement).mockResolvedValue({});
        render(<DashboardScreen />);
        await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      }

      const submit = () =>
        userEvent.click(
          screen.getByRole('button', {
            name: i18n.t('expenses:settle.submit', { amount: formatMinor(67000, 'CLP') }),
          }),
        );

      it('sends no group when the person does not choose one', async () => {
        await openSettle();
        await submit();
        expect(vi.mocked(saveSettlement).mock.calls[0][0].groupId).toBeUndefined();
      });

      it('sends the group the person chose', async () => {
        await openSettle();
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await submit();
        expect(vi.mocked(saveSettlement).mock.calls[0][0].groupId).toBe('viaje');
      });

      it('lets the person undo the choice', async () => {
        await openSettle();
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await userEvent.click(screen.getByRole('button', { name: 'Viaje' }));
        await submit();
        expect(vi.mocked(saveSettlement).mock.calls[0][0].groupId).toBeUndefined();
      });
    });

    it('does not ask for a group when the debt is in only one', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      expect(screen.queryByText(i18n.t('expenses:settle.groupQuestion'))).toBeNull();
    });

    it('does not move on to another person after a debt is cleared', async () => {
      const mia = { id: 'mia', name: 'Mía', tone: 'sage', currency: 'CAD' };
      const owedToMia = {
        id: 'taxi',
        title: 'Taxi',
        kind: 'other',
        groupId: 'casa',
        payerId: 'mia',
        addedById: 'mia',
        amountMinor: 4000,
        currency: 'CAD',
        date: '2026-11-10',
        splitMode: 'equal',
        shares: { ana: 2000, mia: 2000 },
      };
      const before = ledger();
      before.members = [...before.members, mia];
      before.expenses = [...before.expenses, owedToMia];
      const after = {
        ...before,
        settlements: [{ fromId: 'ana', toId: 'leo', amountMinor: 33500, currency: 'CLP' }],
      };
      vi.mocked(fetchLedger).mockResolvedValueOnce(before).mockResolvedValue(after);
      vi.mocked(saveSettlement).mockResolvedValue({});
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      await userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:settle.submit', { amount: formatMinor(33500, 'CLP') }),
        }),
      );

      await screen.findByRole('button', {
        name: new RegExp(i18n.t('expenses:balance.youOweThem', { name: 'Mía' })),
      });
      expect(screen.queryByLabelText(i18n.t('expenses:settle.amountYouPay'))).toBeNull();
      expect(saveSettlement).toHaveBeenCalledOnce();
    });

    it('records a partial payment as what was actually paid', async () => {
      vi.mocked(fetchLedger).mockResolvedValue(ledger());
      vi.mocked(saveSettlement).mockResolvedValue({});
      render(<DashboardScreen />);

      await userEvent.click(await button(i18n.t('expenses:balance.settle')));
      const amount = screen.getByLabelText(i18n.t('expenses:settle.amountYouPay'));
      await userEvent.clear(amount);
      await userEvent.type(amount, '10.000');
      await userEvent.click(
        screen.getByRole('button', {
          name: i18n.t('expenses:settle.submit', { amount: formatMinor(10000, 'CLP') }),
        }),
      );

      expect(vi.mocked(saveSettlement).mock.calls[0][0]).toMatchObject({
        amountMinor: 10000,
        currency: 'CLP',
      });
    });
  });

  it('opens an expense and shows how it was split', async () => {
    vi.mocked(fetchLedger).mockResolvedValue(ledger());
    render(<DashboardScreen />);

    await userEvent.click(await screen.findByRole('button', { name: /Almuerzo/ }));
    expect(screen.getByRole('heading', { name: 'Almuerzo' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: i18n.t('expenses:detail.splitTitle') })).toBeTruthy();
  });
});
