import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currencyLabel, quoteLabel } from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import {
  Amount,
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  PersonRow,
  Segmented,
  StatusNote,
  TextField,
} from '../components/ui';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { formatAmountInput, formatMinor } from '../i18n/format.js';
import { recordPayment } from '../lib/expenses.js';
import { balancesFor, myself, todayIso } from '../lib/ledger.js';
import {
  CURRENCIES,
  PAYMENT_MAX_MINOR,
  conversionTolerance,
  convertMinor,
  parseAmount,
  quoteBetween,
} from '../lib/money.js';
import { scrollToTop } from '../lib/scroll.js';
import './SettleUpScreen.css';

const METHODS = ['transfer', 'cash', 'other'];

function sumByCurrency(entries) {
  const totals = new Map();
  for (const { minor, currency } of entries) {
    totals.set(currency, (totals.get(currency) ?? 0) + minor);
  }
  return [...totals.entries()].map(([currency, minor]) => formatMinor(minor, currency)).join(' + ');
}

/** What the amount typed so far would do to this debt. */
function paymentStatus(t, { youPay, name, hasAmount, receivedText, outcome, leftText }) {
  if (!hasAmount) {
    return youPay
      ? t('expenses:settle.status.needAmountYouPay')
      : t('expenses:settle.status.needAmountTheyPay');
  }
  const amount = receivedText;
  const left = leftText;
  if (outcome === 'even') {
    return youPay
      ? t('expenses:settle.status.evenTheyReceive', { name, amount })
      : t('expenses:settle.status.evenYouReceive', { amount });
  }
  if (outcome === 'partial') {
    return youPay
      ? t('expenses:settle.status.partialTheyReceive', { name, amount, left })
      : t('expenses:settle.status.partialYouReceive', { amount, left });
  }
  return youPay
    ? t('expenses:settle.status.overTheyReceive', { name, amount, left })
    : t('expenses:settle.status.overYouReceive', { amount, left });
}

function othersTitle(t, row) {
  const { name } = row.member;
  if (row.netMinor == null) return t('expenses:balance.unknown', { name });
  return row.netMinor < 0
    ? t('expenses:balance.youOweThem', { name })
    : t('expenses:balance.theyOwe', { name });
}

function SettleForm({ ledger, row, onRecorded }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const currencyLabelId = useId();
  const methodLabelId = useId();
  const groupLabelId = useId();
  const { me, rates } = ledger;
  const other = row.member;
  const caller = myself(ledger);

  const [currency, setCurrency] = useState(other.currency);
  const [amountText, setAmountText] = useState(null);
  const [method, setMethod] = useState('transfer');
  const [chosenGroupId, setChosenGroupId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const youPay = row.homeMinor < 0;
  const owedMinor = Math.abs(row.homeMinor);
  const groupsWithDebt = ledger.groups.filter((group) => {
    const balance = balancesFor(ledger, { groupId: group.id, currency: other.currency }).find(
      (item) => item.member.id === other.id,
    );
    if (balance?.netMinor == null) return false;
    return youPay ? balance.netMinor < 0 : balance.netMinor > 0;
  });
  const chosenGroup = groupsWithDebt.find((group) => group.id === chosenGroupId);
  const suggested = convertMinor(owedMinor, other.currency, currency, rates);
  const shownAmount =
    amountText ?? (suggested == null ? '' : formatAmountInput(suggested, currency));
  const paidMinor = parseAmount(shownAmount, currency);
  const received = paidMinor == null ? null : convertMinor(paidMinor, currency, other.currency, rates);
  const hasAmount =
    paidMinor != null && paidMinor > 0 && paidMinor <= PAYMENT_MAX_MINOR && received != null;

  const left = hasAmount ? owedMinor - received : null;
  let outcome = 'partial';
  if (hasAmount && Math.abs(left) <= conversionTolerance(currency, other.currency, rates)) {
    outcome = 'even';
  } else if (hasAmount && left < 0) {
    outcome = 'over';
  }

  const isExact = currency === other.currency;
  const receivedFormatted = hasAmount ? formatMinor(received, other.currency) : '';
  const receivedText = isExact
    ? receivedFormatted
    : t('expenses:approx', { amount: receivedFormatted });
  const leftText = hasAmount
    ? t('expenses:approx', { amount: formatMinor(left, other.currency) })
    : '';
  const quote = quoteBetween(currency, other.currency, rates);

  const owedEntries = row.entries.filter((entry) => entry.minor < 0);
  const creditEntries = row.entries.filter((entry) => entry.minor > 0);

  const methodLabels = {
    transfer: t('expenses:settle.methods.transfer'),
    cash: t('expenses:settle.methods.cash'),
    other: t('expenses:settle.methods.other'),
  };

  function handleCurrency(next) {
    setCurrency(next);
    setAmountText(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!hasAmount || saving) return;
    setSaving(true);
    setErrorCode(null);
    const paidText = formatMinor(paidMinor, currency);
    try {
      const body = {
        fromId: youPay ? me : other.id,
        toId: youPay ? other.id : me,
        paid: { amountMinor: paidMinor, currency },
        method,
        date: todayIso(),
      };
      if (chosenGroup) body.groupId = chosenGroup.id;
      // A payment that clears the debt also sends the debt's exact value, so conversion rounding
      // does not leave a few cents owing either way. The API accepts it only within one minor unit
      // of the paying currency, and otherwise credits what was paid.
      if (outcome === 'even' && (currency !== other.currency || paidMinor !== owedMinor)) {
        body.credited = { amountMinor: owedMinor, currency: other.currency };
      }
      await recordPayment(session, prepare(body));
      done();
      onRecorded(
        other.id,
        youPay
          ? t('expenses:settle.doneYouPaid', {
              amount: paidText,
              name: other.name,
              currency: currencyLabel(t, other.currency),
            })
          : t('expenses:settle.doneTheyPaid', { amount: paidText, name: other.name }),
      );
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
      setSaving(false);
    }
  }

  return (
    <Card>
      <form className="fa-settle" onSubmit={handleSubmit}>
        <div className="fa-settle__people">
          <Avatar
            name={youPay ? caller.name : other.name}
            tone={youPay ? caller.tone : other.tone}
            size="large"
          />
          <span className="fa-settle__arrow">
            <ArrowRight aria-hidden="true" size={24} strokeWidth={1.75} />
          </span>
          <Avatar
            name={youPay ? other.name : caller.name}
            tone={youPay ? other.tone : caller.tone}
            size="large"
          />
        </div>

        <div className="fa-settle__summary">
          <h2 className="fa-text-heading">
            {youPay
              ? t('expenses:settle.youOwe', { name: other.name })
              : t('expenses:settle.theyOwe', { name: other.name })}
          </h2>
          <Amount minor={row.homeMinor} currency={other.currency} />
          {other.currency !== caller.currency && row.netMinor != null && (
            <p className="fa-text-caption fa-text-muted">
              {t('expenses:settle.inYourCurrency', {
                amount: formatMinor(row.netMinor, caller.currency),
              })}
            </p>
          )}
          {owedEntries.length > 0 && creditEntries.length > 0 && (
            <p className="fa-settle__breakdown fa-text-caption fa-text-muted">
              {t('expenses:settle.breakdown', {
                owed: sumByCurrency(owedEntries),
                credit: sumByCurrency(creditEntries),
              })}
            </p>
          )}
        </div>

        <div className="fa-settle__question">
          <p id={currencyLabelId} className="fa-text-label">
            {youPay ? t('expenses:settle.currencyYouPay') : t('expenses:settle.currencyTheyPay')}
          </p>
          <Segmented
            labelledBy={currencyLabelId}
            value={currency}
            onChange={handleCurrency}
            options={CURRENCIES.map((code) => ({
              value: code,
              label: currencyLabel(t, code),
            }))}
          />
          <p className="fa-text-caption fa-text-muted">
            {isExact || !quote
              ? t('expenses:settle.currencyTheirs', { name: other.name })
              : t('expenses:settle.currencyConverted', {
                  name: other.name,
                  currency: currencyLabel(t, other.currency),
                  rate: quoteLabel(t, quote),
                })}
          </p>
        </div>

        <TextField
          label={youPay ? t('expenses:settle.amountYouPay') : t('expenses:settle.amountTheyPay')}
          prefix={currencyLabel(t, currency)}
          inputMode="decimal"
          value={shownAmount}
          onChange={(event) => setAmountText(event.target.value)}
        />

        <StatusNote tone={hasAmount && outcome === 'even' ? 'success' : 'warning'}>
          {paymentStatus(t, {
            youPay,
            name: other.name,
            hasAmount,
            receivedText,
            outcome,
            leftText,
          })}
        </StatusNote>

        {groupsWithDebt.length > 1 && (
          <div className="fa-settle__question">
            <p id={groupLabelId} className="fa-text-label">
              {t('expenses:settle.groupQuestion')}
            </p>
            <div className="fa-settle__methods" role="group" aria-labelledby={groupLabelId}>
              {groupsWithDebt.map((group) => (
                <Chip
                  key={group.id}
                  pressed={group.id === chosenGroup?.id}
                  onClick={() =>
                    setChosenGroupId(group.id === chosenGroup?.id ? null : group.id)
                  }
                >
                  {group.name}
                </Chip>
              ))}
            </div>
            <p className="fa-text-caption fa-text-muted">
              {chosenGroup
                ? t('expenses:settle.groupHintChosen', { group: chosenGroup.name })
                : t('expenses:settle.groupHintAuto')}
            </p>
          </div>
        )}

        <div className="fa-settle__question">
          <p id={methodLabelId} className="fa-text-label">
            {youPay ? t('expenses:settle.methodYouPay') : t('expenses:settle.methodTheyPay')}
          </p>
          <div className="fa-settle__methods" role="group" aria-labelledby={methodLabelId}>
            {METHODS.map((option) => (
              <Chip key={option} pressed={method === option} onClick={() => setMethod(option)}>
                {methodLabels[option]}
              </Chip>
            ))}
          </div>
        </div>

        {errorCode && (
          <p className="fa-text-body" role="alert">
            {errorMessage(errorCode)}
          </p>
        )}

        <Button type="submit" size="large" block disabled={!hasAmount || saving}>
          {hasAmount
            ? t('expenses:settle.submit', { amount: formatMinor(paidMinor, currency) })
            : t('expenses:settle.submitNeedAmount')}
        </Button>
      </form>
    </Card>
  );
}

export function SettleUpScreen({ ledger, ledgerState, view, nav }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(view.memberId);
  const [doneNote, setDoneNote] = useState(null);
  const myCurrency = myself(ledger).currency;

  const rows = balancesFor(ledger, { currency: myCurrency });
  const chosen = rows.find((row) => row.member.id === selectedId);
  // Right after a payment the form never moves on to someone else by itself: a second tap would
  // record money to the wrong person.
  const fallback = doneNote ? undefined : (rows.find((row) => row.netMinor < 0) ?? rows[0]);
  const selected = chosen ?? fallback;
  const others = rows.filter((row) => row !== selected);
  const canSettle = selected && selected.homeMinor != null;

  function handleRecorded(memberId, note) {
    setSelectedId(memberId);
    setDoneNote(note);
    ledgerState.reload();
    scrollToTop();
  }

  function handleSelect(memberId) {
    setSelectedId(memberId);
    setDoneNote(null);
    scrollToTop();
  }

  return (
    <main>
      <SubHeader backLabel={t('expenses:settle.back')} onBack={nav.home} />
      <div className="fa-screen">
        <div className="fa-screen__intro">
          <h1 className="fa-text-title">{t('expenses:settle.title')}</h1>
          <p className="fa-text-body fa-text-muted">{t('expenses:settle.intro')}</p>
        </div>

        {doneNote && <StatusNote>{doneNote}</StatusNote>}

        {rows.length === 0 && (
          <Card>
            <EmptyState title={t('expenses:settle.evenTitle')}>
              {t('expenses:settle.evenBody')}
            </EmptyState>
          </Card>
        )}
        {selected && !canSettle && (
          <Card>
            <p className="fa-text-body" role="alert">
              {t('expenses:settle.noRate')}
            </p>
          </Card>
        )}
        {canSettle && (
          <SettleForm
            key={`${selected.member.id}:${selected.homeMinor}`}
            ledger={ledger}
            row={selected}
            onRecorded={handleRecorded}
          />
        )}

        {others.length > 0 && (
          <section className="fa-screen__section" aria-labelledby="fa-settle-others">
            <h2 id="fa-settle-others" className="fa-text-heading">
              {t('expenses:settle.othersTitle')}
            </h2>
            <Card flush>
              <ul className="fa-person-list">
                {others.map((row) => (
                  <PersonRow
                    key={row.member.id}
                    person={row.member}
                    density="link"
                    title={othersTitle(t, row)}
                    subtitle={
                      row.homeMinor == null
                        ? null
                        : t('expenses:balance.theirCurrency', {
                            amount: formatMinor(row.homeMinor, row.member.currency),
                          })
                    }
                    trailing={<Amount minor={row.netMinor} currency={myCurrency} size="small" />}
                    onClick={() => handleSelect(row.member.id)}
                  />
                ))}
              </ul>
            </Card>
          </section>
        )}
      </div>
    </main>
  );
}
