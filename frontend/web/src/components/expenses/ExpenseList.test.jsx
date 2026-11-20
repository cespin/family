import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n/index.js';
import { ExpenseList } from './ExpenseList.jsx';
import { percentLabel } from './labels.js';

const t = i18n.t.bind(i18n);

const LEDGER = {
  me: 'carlos',
  members: [
    { id: 'carlos', name: 'Carlos', tone: 'honey' },
    { id: 'lucia', name: 'Lucía', tone: 'clay' },
    { id: 'beto', name: 'Tío Beto' },
  ],
};

const KINE = {
  id: 'kine',
  title: 'Kinesiología',
  kind: 'parents',
  groupId: 'care',
  payerId: 'lucia',
  addedBy: 'lucia',
  amountMinor: 120000,
  currency: 'CLP',
  date: '2026-11-14',
  transactionDate: '2026-11-14',
  participantIds: ['carlos', 'lucia', 'beto'],
  splitMode: 'percent',
  participants: [
    { memberId: 'carlos', shareMinor: 60000, percent: 50 },
    { memberId: 'lucia', shareMinor: 30000, percent: 25 },
    { memberId: 'beto', shareMinor: 30000, percent: 25 },
  ],
  standing: { involved: true, openMinor: -60000, settled: false },
};

const label = t('expenses:row.splitLabel', {
  parts: [
    `${t('expenses:you.subject')} ${percentLabel(t, 50)}`,
    `Lucía ${percentLabel(t, 25)}`,
    `Tío Beto ${percentLabel(t, 25)}`,
  ].join(', '),
});

function renderList(expenses, isWide) {
  const { unmount } = render(
    <ExpenseList ledger={LEDGER} expenses={expenses} isWide={isWide} onOpen={vi.fn()} />,
  );
  const row = screen.getByRole('button', { name: new RegExp(expenses[0].title) });
  return { row, unmount };
}

describe('ExpenseList', () => {
  it('shows the reader’s part under the row on a phone', () => {
    const { row } = renderList([KINE], false);
    expect(within(row).getByRole('img', { name: label })).toBeTruthy();
    const caption = t('expenses:row.yourSharePercent', { percent: percentLabel(t, 50) });
    expect(within(row).getByText(caption)).toBeTruthy();
  });

  it('shows everyone’s initials, and "Tú" for the reader, on a wide list', () => {
    const { row } = renderList([KINE], true);
    const bar = within(row).getByRole('img', { name: label });
    expect(within(bar).getByText(t('expenses:you.subject'))).toBeTruthy();
    expect(within(bar).getByText(t('common:avatar.initials', { initials: 'TB' }))).toBeTruthy();
    const caption = t('expenses:row.yourSharePercent', { percent: percentLabel(t, 50) });
    expect(within(row).queryByText(caption)).toBeNull();
  });

  it('leaves a row the list sent no split for as it was, at every width', () => {
    const { splitMode: _mode, participants: _parts, ...bare } = KINE;
    for (const isWide of [false, true]) {
      const { row, unmount } = renderList([bare], isWide);
      // The payer's avatar is the row's only image.
      const images = within(row).getAllByRole('img');
      expect(images.map((img) => img.getAttribute('aria-label'))).toEqual(['Lucía']);
      unmount();
    }
  });
});
