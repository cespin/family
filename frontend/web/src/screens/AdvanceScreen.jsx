import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currencyLabel } from '../components/expenses/labels.js';
import { MethodChoice } from '../components/expenses/MethodChoice.jsx';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  Segmented,
  StatusNote,
  TextField,
} from '../components/ui';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { formatMinor } from '../i18n/format.js';
import { recordPayment } from '../lib/expenses.js';
import { advanceCandidates, myself, todayIso } from '../lib/ledger.js';
import { CURRENCIES, PAYMENT_MAX_MINOR, convertMinor, parseAmount } from '../lib/money.js';
import { scrollToTop } from '../lib/scroll.js';
import './AdvanceScreen.css';

const THEY_GAVE = 'theyGave';
const I_GAVE = 'iGave';

/**
 * What the advance would do to the balance with this person, in their currency. The API allocates
 * it, so this only previews the same rule: it pays what the giver owes first, and the rest is
 * credit that later debts draw on. `balance` is positive when they owe me, and null when it, or
 * the advance, cannot be converted.
 */
function advanceStatus(t, { theyGave, name, amount, balance, received, format }) {
  if (balance == null || received == null) {
    return theyGave
      ? t('expenses:advance.status.plainTheyGave', { name, amount })
      : t('expenses:advance.status.plainIGave', { name, amount });
  }
  // What the giver owes the receiver before and after, so both directions read the same way.
  const owedByGiver = theyGave ? balance : -balance;
  const after = owedByGiver - received;

  // Settle up forgives conversion rounding by sending the debt as `credited`. An advance never
  // does, so only an exact match closes the balance.
  if (after === 0) {
    return theyGave
      ? t('expenses:advance.status.evenTheyGave', { amount })
      : t('expenses:advance.status.evenIGave', { name, amount });
  }
  if (after > 0) {
    const left = format(after);
    return theyGave
      ? t('expenses:advance.status.partialTheyGave', { amount, left })
      : t('expenses:advance.status.partialIGave', { name, amount, left });
  }
  const credit = format(-after);
  if (owedByGiver > 0) {
    const covered = format(owedByGiver);
    return theyGave
      ? t('expenses:advance.status.coversTheyGave', { amount, covered, credit })
      : t('expenses:advance.status.coversIGave', { name, amount, covered, credit });
  }
  if (owedByGiver === 0) {
    // With nothing to pay first, the server keeps the whole advance as credit in the currency it
    // was given in, so the exact amount says more than a conversion.
    return theyGave
      ? t('expenses:advance.status.creditTheyGave', { name, amount, credit: amount })
      : t('expenses:advance.status.creditIGave', { name, amount, credit: amount });
  }
  const owed = format(-owedByGiver);
  return theyGave
    ? t('expenses:advance.status.growsTheyGave', { name, amount, owed, total: credit })
    : t('expenses:advance.status.growsIGave', { name, amount, owed, total: credit });
}

function submitLabel(t, { person, direction, hasAmount, paidText }) {
  if (!person) return t('expenses:advance.submitNeedPerson');
  if (!direction) return t('expenses:advance.submitNeedDirection');
  if (!hasAmount) return t('expenses:advance.submitNeedAmount');
  return t('expenses:advance.submit', { amount: paidText });
}

function AdvanceForm({ ledger, candidates, onStart, onRecorded }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const personLabelId = useId();
  const directionLabelId = useId();
  const currencyLabelId = useId();
  const caller = myself(ledger);

  const [personId, setPersonId] = useState(null);
  const [direction, setDirection] = useState(null);
  const [chosenCurrency, setChosenCurrency] = useState(null);
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState('transfer');
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const row = candidates.find((candidate) => candidate.member.id === personId);
  const person = row?.member;
  const theyGave = direction === THEY_GAVE;
  // Until someone picks a currency, the advance is in the giver's own.
  const giverCurrency = direction === I_GAVE ? caller.currency : (person?.currency ?? caller.currency);
  const currency = chosenCurrency ?? giverCurrency;
  const paidMinor = parseAmount(amountText, currency);
  const hasAmount = paidMinor != null && paidMinor > 0 && paidMinor <= PAYMENT_MAX_MINOR;
  const ready = Boolean(person && direction && hasAmount);
  const paidText = hasAmount ? formatMinor(paidMinor, currency) : '';

  function handlePerson(id) {
    setPersonId(id);
    onStart();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setErrorCode(null);
    try {
      // The server credits exactly what was paid, so an advance never sends `credited` or a group.
      const body = {
        fromId: theyGave ? person.id : ledger.me,
        toId: theyGave ? ledger.me : person.id,
        paid: { amountMinor: paidMinor, currency },
        method,
        date: todayIso(),
      };
      await recordPayment(session, prepare(body));
      done();
      onRecorded(
        theyGave
          ? t('expenses:advance.doneTheyGave', { name: person.name, amount: paidText })
          : t('expenses:advance.doneIGave', { name: person.name, amount: paidText }),
      );
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
      setSaving(false);
    }
  }

  let status = null;
  if (ready) {
    const received = convertMinor(paidMinor, currency, person.currency, ledger.rates);
    const approx =
      currency !== person.currency || row.entries.some((entry) => entry.currency !== person.currency);
    const format = (minor) =>
      approx
        ? t('expenses:approx', { amount: formatMinor(minor, person.currency) })
        : formatMinor(minor, person.currency);
    status = advanceStatus(t, {
      theyGave,
      name: person.name,
      amount: paidText,
      balance: row.homeMinor,
      received,
      format,
    });
  }

  const giver = theyGave ? person : caller;
  const receiver = theyGave ? caller : person;

  return (
    <Card>
      <form className="fa-advance" onSubmit={handleSubmit}>
        <div className="fa-advance__question">
          <p id={personLabelId} className="fa-text-label">
            {t('expenses:advance.who')}
          </p>
          <div className="fa-advance__choices" role="group" aria-labelledby={personLabelId}>
            {candidates.map((candidate) => (
              <Chip
                key={candidate.member.id}
                pressed={candidate.member.id === personId}
                onClick={() => handlePerson(candidate.member.id)}
              >
                {candidate.member.name}
              </Chip>
            ))}
          </div>
        </div>

        {person && (
          <>
            <div className="fa-advance__question">
              <p id={directionLabelId} className="fa-text-label">
                {t('expenses:advance.direction')}
              </p>
              <Segmented
                labelledBy={directionLabelId}
                value={direction}
                onChange={setDirection}
                options={[
                  { value: THEY_GAVE, label: t('expenses:advance.theyGave', { name: person.name }) },
                  { value: I_GAVE, label: t('expenses:advance.iGave', { name: person.name }) },
                ]}
              />
            </div>
          </>
        )}

        {person && direction && (
          <>
            <div className="fa-advance__people">
              <Avatar name={giver.name} tone={giver.tone} size="large" />
              <span className="fa-advance__arrow">
                <ArrowRight aria-hidden="true" size={24} strokeWidth={1.75} />
              </span>
              <Avatar name={receiver.name} tone={receiver.tone} size="large" />
            </div>

            <div className="fa-advance__question">
              <p id={currencyLabelId} className="fa-text-label">
                {theyGave
                  ? t('expenses:advance.currencyTheyGave')
                  : t('expenses:advance.currencyIGave')}
              </p>
              <Segmented
                labelledBy={currencyLabelId}
                value={currency}
                onChange={setChosenCurrency}
                options={CURRENCIES.map((code) => ({
                  value: code,
                  label: currencyLabel(t, code),
                }))}
              />
            </div>

            <TextField
              label={
                theyGave ? t('expenses:advance.amountTheyGave') : t('expenses:advance.amountIGave')
              }
              prefix={currencyLabel(t, currency)}
              inputMode="decimal"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
            />

            {status && <StatusNote tone="warning">{status}</StatusNote>}

            <MethodChoice
              label={
                theyGave ? t('expenses:advance.methodTheyGave') : t('expenses:advance.methodIGave')
              }
              value={method}
              onChange={setMethod}
            />
          </>
        )}

        {errorCode && (
          <p className="fa-text-body" role="alert">
            {errorMessage(errorCode)}
          </p>
        )}

        <Button type="submit" size="large" block disabled={!ready || saving}>
          {submitLabel(t, { person, direction, hasAmount, paidText })}
        </Button>
      </form>
    </Card>
  );
}

/** Money given ahead of future expenses: a payment recorded even when nothing is owed. */
export function AdvanceScreen({ ledger, ledgerState, nav }) {
  const { t } = useTranslation();
  const [doneNote, setDoneNote] = useState(null);
  // A new key after each save empties the form, so a second tap cannot record the money twice.
  const [formKey, setFormKey] = useState(0);
  const candidates = advanceCandidates(ledger, myself(ledger).currency);

  function handleRecorded(note) {
    setDoneNote(note);
    setFormKey((current) => current + 1);
    ledgerState.reload();
    scrollToTop();
  }

  return (
    <main>
      <SubHeader backLabel={t('expenses:advance.back')} onBack={nav.home} />
      <div className="fa-screen">
        <div className="fa-screen__intro">
          <h1 className="fa-text-title">{t('expenses:advance.title')}</h1>
          <p className="fa-text-body fa-text-muted">{t('expenses:advance.intro')}</p>
        </div>

        {doneNote && <StatusNote>{doneNote}</StatusNote>}

        {candidates.length === 0 ? (
          <Card>
            <EmptyState title={t('expenses:advance.nobodyTitle')}>
              {t('expenses:advance.nobodyBody')}
            </EmptyState>
          </Card>
        ) : (
          <AdvanceForm
            key={formKey}
            ledger={ledger}
            candidates={candidates}
            onStart={() => setDoneNote(null)}
            onRecorded={handleRecorded}
          />
        )}
      </div>
    </main>
  );
}
