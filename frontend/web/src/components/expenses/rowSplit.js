import { memberById, sharePercent } from '../../lib/ledger.js';
import { initials } from '../ui/initials.js';
import { percentLabel, splitPartsLabel } from './labels.js';

/**
 * How an expense in the list is split, as `ExpenseRow` takes it in `split`, or null when its row
 * shows no split.
 *
 * - **No split data, no split.** The list only carries the split for expenses whose entries were
 *   saved with it, and absent is not zero: an equal split is never guessed.
 * - **On a phone** it is the reader's part, first, against everyone else's, with a caption. A row
 *   where the reader has no part shows none. That includes a payer who put in nothing, whom
 *   `standing.involved` still counts as involved.
 * - **On a wide list** it is everyone's part in their tone with their initials under it, and "Tú"
 *   under the reader's part.
 */
export function rowSplit(t, ledger, expense, isWide) {
  const { splitMode, participants } = expense;
  if (splitMode == null || participants == null || participants.length === 0) return null;

  const people = participants.map((participant) => {
    const person = memberById(ledger, participant.memberId);
    const mine = participant.memberId === ledger.me;
    return {
      id: participant.memberId,
      name: person.name,
      tone: person.tone,
      percent: sharePercent(expense, participant),
      mine,
      short: mine
        ? t('expenses:you.subject')
        : t('common:avatar.initials', { initials: initials(person.name) }),
    };
  });
  const label = t('expenses:row.splitLabel', { parts: splitPartsLabel(t, ledger, expense) });
  // Someone with no part takes no room in the bar. The label still names them.
  const drawn = people.filter((part) => part.percent > 0);

  if (isWide) return { variant: 'column', label, parts: drawn };

  const mine = people.find((part) => part.mine);
  if (!mine) return null;
  const caption =
    splitMode === 'percent'
      ? t('expenses:row.yourSharePercent', { percent: percentLabel(t, mine.percent) })
      : t('expenses:row.yourShareEqual', { total: people.length });
  return {
    variant: 'mine',
    label,
    parts: [...drawn.filter((part) => part.mine), ...drawn.filter((part) => !part.mine)],
    caption,
  };
}
