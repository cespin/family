import { useId, useState } from 'react';
import { ArrowLeftRight, HandCoins, ReceiptText, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Amount, Button, Card, PersonRow, Segmented } from '../ui';
import { formatMinor } from '../../i18n/format.js';
import {
  ALL_GROUPS,
  advanceCandidates,
  balanceTotal,
  balancesFor,
  groupById,
  myself,
} from '../../lib/ledger.js';
import { CURRENCIES } from '../../lib/money.js';
import { currencyLabel, ratesLine } from './labels.js';
import './BalanceCard.css';

function headlineFor(t, total) {
  if (total == null) return t('expenses:balance.incomplete');
  if (total > 0) return t('expenses:balance.owedToYou');
  return total < 0 ? t('expenses:balance.youOwe') : t('expenses:balance.even');
}

function rowTitle(t, row) {
  const { name } = row.member;
  if (row.netMinor == null) return t('expenses:balance.unknown', { name });
  return row.netMinor < 0
    ? t('expenses:balance.youOweThem', { name })
    : t('expenses:balance.theyOwe', { name });
}

export function BalanceCard({ ledger, groupId, onSettle, onAdvance, onPayments, onRates }) {
  const { t } = useTranslation();
  const labelId = useId();
  const [currency, setCurrency] = useState(myself(ledger).currency);
  const canAdvance = advanceCandidates(ledger, currency).length > 0;

  const rows = balancesFor(ledger, { groupId, currency });
  const total = balanceTotal(ledger, { groupId, currency });
  const rates = ratesLine(t, ledger);
  const scope =
    groupId === ALL_GROUPS
      ? t('expenses:balance.scopeAll')
      : t('expenses:balance.scopeGroup', { group: groupById(ledger, groupId).name });

  return (
    <Card>
      <div className="fa-balance">
        <div className="fa-balance__currency">
          <p id={labelId} className="fa-text-label">
            {t('expenses:balance.viewIn')}
          </p>
          <Segmented
            compact
            labelledBy={labelId}
            value={currency}
            onChange={setCurrency}
            options={CURRENCIES.map((code) => ({
              value: code,
              label: currencyLabel(t, code),
            }))}
          />
        </div>

        <div className="fa-balance__total">
          <p className="fa-text-caption fa-text-muted">{scope}</p>
          <div className="fa-balance__headline">
            <span className="fa-text-heading">{headlineFor(t, total)}</span>
            <Amount minor={total} currency={currency} />
          </div>
        </div>

        {rows.length > 0 && (
          <ul className="fa-person-list fa-person-list--framed">
            {rows.map((row) => (
              <PersonRow
                key={row.member.id}
                person={row.member}
                strong={false}
                title={rowTitle(t, row)}
                subtitle={
                  row.member.currency !== currency && row.homeMinor != null
                    ? t('expenses:balance.theirCurrency', {
                        amount: formatMinor(row.homeMinor, row.member.currency),
                      })
                    : null
                }
                trailing={<Amount minor={row.netMinor} currency={currency} size="small" />}
              />
            ))}
          </ul>
        )}

        <div className="fa-balance__rates">
          <p className="fa-text-caption fa-text-muted">{rates ?? t('expenses:rates.none')}</p>
          <Button variant="quiet" size="small" icon={ArrowLeftRight} onClick={onRates}>
            {rates ? t('expenses:rates.open') : t('expenses:rates.add')}
          </Button>
        </div>

        {rows.length > 0 && (
          <Button variant="secondary" block icon={Wallet} onClick={() => onSettle()}>
            {t('expenses:balance.settle')}
          </Button>
        )}
        {/* An advance is recorded even with nothing open, so it does not depend on the rows. */}
        {canAdvance && (
          <Button variant="quiet" block icon={HandCoins} onClick={onAdvance}>
            {t('expenses:balance.advance')}
          </Button>
        )}
        {canAdvance && (
          <Button variant="quiet" block icon={ReceiptText} onClick={onPayments}>
            {t('expenses:balance.payments')}
          </Button>
        )}
      </div>
    </Card>
  );
}
