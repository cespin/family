import { useId, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  currencyLabel,
  kindLabel,
  memberLabel,
  percentLabel,
  quoteLabel,
  usualSplitLabel,
} from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import {
  Avatar,
  Button,
  Card,
  Chip,
  Segmented,
  StatusNote,
  TextField,
} from '../components/ui';
import { useExpense } from '../hooks/useExpense.js';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { currencyDigits, formatAmountInput, formatMinor, formatNumber } from '../i18n/format.js';
import { saveExpense } from '../lib/expenses.js';
import { groupById, memberById, myself, todayIso } from '../lib/ledger.js';
import {
  CURRENCIES,
  EXPENSE_MAX_MINOR,
  convertMinor,
  evenPercents,
  parseAmount,
  percentTotal,
  quoteBetween,
  splitByPercent,
  splitEqual,
} from '../lib/money.js';
import { scrollToTop } from '../lib/scroll.js';
import './AddExpenseScreen.css';

const KINDS = ['meal', 'parents', 'gift', 'other'];
const PERCENT_STEP = 5;
const TITLE_MAX = 40;
const NOTE_MAX = 200;

/**
 * Who can pay for or share an expense in this group: its active members, plus anyone already on
 * the expense being edited, who may stay on it after leaving the group or losing access.
 */
function peopleFor(ledger, group, expense) {
  const onExpense =
    expense && expense.groupId === group.id
      ? [expense.payerId, ...expense.participants.map((participant) => participant.memberId)]
      : [];
  const current = group.memberIds.filter(
    (id) => memberById(ledger, id)?.active || onExpense.includes(id),
  );
  const former = onExpense.filter(
    (id, index) => !group.memberIds.includes(id) && onExpense.indexOf(id) === index,
  );
  return [...current, ...former];
}

function formForGroup(ledger, group, base) {
  const ids = peopleFor(ledger, group, null);
  const keepsPayer = ids.includes(base.payerId);
  const fallbackPayer = ids.includes(ledger.me) ? ledger.me : ids[0];
  const payerId = keepsPayer ? base.payerId : fallbackPayer;
  return {
    ...base,
    groupId: group.id,
    payerId,
    currency:
      keepsPayer || base.currencyTouched ? base.currency : memberById(ledger, payerId).currency,
    included: Object.fromEntries(ids.map((id) => [id, true])),
    mode: group.usual ? 'percent' : 'equal',
    percents: group.usual ? { ...group.usual } : evenPercents(ids, ids),
  };
}

function blankForm(ledger) {
  return formForGroup(ledger, ledger.groups[0], {
    title: '',
    note: '',
    amount: '',
    currency: myself(ledger).currency,
    currencyTouched: false,
    charged: false,
    chargedAmount: '',
    chargedCurrency: null,
    debtIn: 'charged',
    kind: 'meal',
    payerId: ledger.me,
    saveUsual: true,
  });
}

function formFromExpense(ledger, expense) {
  const group = groupById(ledger, expense.groupId);
  const ids = peopleFor(ledger, group, expense);
  const includedIds = expense.participants.map((participant) => participant.memberId);
  const percents = Object.fromEntries(
    expense.participants.map((participant) => [participant.memberId, participant.percent ?? 0]),
  );
  // The form asks for the receipt first. The API holds the debt amount first, and the purchase's
  // other amount next to it when it was charged in a different currency.
  const own = { amountMinor: expense.amountMinor, currency: expense.currency };
  const charged = expense.otherAmount != null;
  const debtIsCharged = expense.chargedCurrency === expense.currency;
  const receipt = charged && debtIsCharged ? expense.otherAmount : own;
  const chargedMoney = charged && debtIsCharged ? own : expense.otherAmount;
  return {
    title: expense.title,
    note: expense.note ?? '',
    amount: formatAmountInput(receipt.amountMinor, receipt.currency),
    currency: receipt.currency,
    currencyTouched: true,
    charged,
    chargedAmount: charged
      ? formatAmountInput(chargedMoney.amountMinor, chargedMoney.currency)
      : '',
    chargedCurrency: charged ? chargedMoney.currency : null,
    debtIn: !charged || debtIsCharged ? 'charged' : 'receipt',
    kind: expense.kind,
    payerId: expense.payerId,
    saveUsual: false,
    groupId: expense.groupId,
    included: Object.fromEntries(ids.map((id) => [id, includedIds.includes(id)])),
    mode: expense.splitMode,
    percents: expense.splitMode === 'percent' ? percents : evenPercents(ids, includedIds),
  };
}

/** Whether an amount typed into the form can be saved, or what is wrong with it. */
function amountProblem(t, minor, currency) {
  if (minor == null || minor <= 0) return 'missing';
  if (minor > EXPENSE_MAX_MINOR[currency]) {
    return t('expenses:add.status.tooMuch', {
      amount: formatMinor(EXPENSE_MAX_MINOR[currency], currency),
    });
  }
  return null;
}

/** Whether the split can be saved, and what to tell the person about it. */
function describeSplit(t, { amountMinor, currency, mode, includedIds, percents, chargedProblem }) {
  const problem = amountProblem(t, amountMinor, currency);
  if (problem === 'missing') {
    return {
      ok: false,
      note: t('expenses:add.status.needAmount'),
      submit: t('expenses:add.submit.needAmount'),
    };
  }
  if (problem) return { ok: false, note: problem, submit: t('expenses:add.submit.checkAmount') };
  if (chargedProblem === 'missing') {
    return {
      ok: false,
      note: t('expenses:add.status.needCharged'),
      submit: t('expenses:add.submit.needCharged'),
    };
  }
  if (chargedProblem) {
    return { ok: false, note: chargedProblem, submit: t('expenses:add.submit.checkAmount') };
  }
  const people = includedIds.length;
  if (people === 0) {
    return {
      ok: false,
      note: t('expenses:add.status.needPeople'),
      submit: t('expenses:add.submit.needPeople'),
    };
  }
  if (mode === 'equal') {
    if (people === 1) return { ok: true, note: t('expenses:add.status.single') };
    const amount = formatMinor(Math.floor(amountMinor / people), currency);
    const note =
      amountMinor % people > 0
        ? t('expenses:add.status.evenAbout', { people, amount })
        : t('expenses:add.status.even', { people, amount });
    return { ok: true, note };
  }
  const assigned = percentTotal(includedIds, percents);
  if (assigned === 100) {
    const amount = formatMinor(amountMinor, currency);
    return { ok: true, note: t('expenses:add.status.complete', { amount }) };
  }
  const percent = percentLabel(t, Math.abs(100 - assigned));
  return assigned < 100
    ? {
        ok: false,
        note: t('expenses:add.status.missing', { percent }),
        submit: t('expenses:add.submit.missing', { percent }),
      }
    : {
        ok: false,
        note: t('expenses:add.status.over', { percent }),
        submit: t('expenses:add.submit.over', { percent }),
      };
}

function currencyHint(t, ledger, currency, amountMinor) {
  const myCurrency = myself(ledger).currency;
  if (currency === myCurrency) return t('expenses:add.currencyHome');
  const quote = quoteBetween(currency, myCurrency, ledger.rates);
  if (!quote) return t('expenses:add.currencyNoRate');
  const rate = quoteLabel(t, quote);
  if (amountMinor == null || amountMinor <= 0) return t('expenses:add.currencyRate', { rate });
  const amount = formatMinor(convertMinor(amountMinor, currency, myCurrency, ledger.rates), myCurrency);
  return t('expenses:add.currencyConverted', { amount, rate });
}

/** The rate the card company applied, worked out from the two amounts. Nobody types it. */
function purchaseRateHint(t, receipt, charged) {
  if (!(receipt.minor > 0) || !(charged.minor > 0)) return null;
  const receiptMajor = receipt.minor / 10 ** currencyDigits(receipt.currency);
  const chargedMajor = charged.minor / 10 ** currencyDigits(charged.currency);
  const rates = { toBase: { [receipt.currency]: 1, [charged.currency]: receiptMajor / chargedMajor } };
  const quote = quoteBetween(charged.currency, receipt.currency, rates);
  if (!quote) return null;
  // Shown exactly, such as 1 CAD = 647,25 CLP: this rate is the expense's own, not a rounded quote.
  const rate = t('expenses:rates.quote', {
    from: currencyLabel(t, quote.from),
    to: currencyLabel(t, quote.to),
    value: formatNumber(quote.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
  return t('expenses:add.purchaseRate', { rate });
}

function audienceNote(t, ledger, includedIds) {
  const names = includedIds
    .filter((id) => id !== ledger.me)
    .map((id) => memberById(ledger, id).name);
  if (names.length === 0) return t('expenses:add.audienceNone');
  if (names.length === 1) return t('expenses:add.audienceOne', { name: names[0] });
  return t('expenses:add.audienceMany', {
    names: names.slice(0, -1).join(', '),
    last: names[names.length - 1],
  });
}

function participantSubtitle(t, ledger, { id, included, form, share, hasAmount, debt }) {
  if (!included) return t('expenses:add.notParticipating');
  if (form.mode === 'percent') return hasAmount ? formatMinor(share, debt.currency) : null;
  if (id === form.payerId) {
    return hasAmount
      ? t('expenses:add.paid', { amount: formatMinor(debt.minor, debt.currency) })
      : null;
  }
  const home = memberById(ledger, id).currency;
  if (!hasAmount || home === debt.currency) return null;
  const converted = convertMinor(share, debt.currency, home, ledger.rates);
  return converted == null
    ? null
    : t('expenses:approx', { amount: formatMinor(converted, home) });
}

/** Adds an expense, or edits one after loading it in full. */
export function AddExpenseScreen({ ledger, ledgerState, view, nav }) {
  const { t } = useTranslation();
  // Bumped when an edit loses to someone else's, to read the expense's new `version`.
  const [refetch, setRefetch] = useState(0);
  const query = useExpense(view.expenseId, refetch);
  const onClose = view.expenseId ? () => nav.expense(view.expenseId) : nav.home;

  if (query.status !== 'ready') {
    return (
      <main className="fa-add">
        <SubHeader
          icon={X}
          backLabel={t('expenses:add.close')}
          onBack={onClose}
          title={t('expenses:add.editTitle')}
        />
        <div className="fa-screen">
          {query.status === 'loading' ? (
            <p className="fa-text-body fa-text-muted" role="status">
              {t('common:status.loading')}
            </p>
          ) : (
            <>
              <p className="fa-text-body" role="alert">
                {errorMessage(query.errorCode)}
              </p>
              <Button variant="secondary" onClick={query.retry}>
                {t('common:actions.retry')}
              </Button>
            </>
          )}
        </div>
      </main>
    );
  }
  return (
    // No key on purpose: after a conflict the expense reloads with a new `version` while the form
    // keeps what the person typed.
    <ExpenseForm
      ledger={ledger}
      ledgerState={ledgerState}
      expense={query.expense}
      nav={nav}
      onConflict={() => setRefetch((current) => current + 1)}
    />
  );
}

function ExpenseForm({ ledger, ledgerState, expense, nav, onConflict }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const currencyId = useId();
  const chargedCurrencyId = useId();
  const debtId = useId();
  const chargedId = useId();
  const kindId = useId();
  const groupId = useId();
  const payerId = useId();
  const splitId = useId();
  const participantsId = useId();
  const usualId = useId();

  const [form, setForm] = useState(() =>
    expense ? formFromExpense(ledger, expense) : blankForm(ledger),
  );
  const [savedNote, setSavedNote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const group = groupById(ledger, form.groupId);
  const ids = peopleFor(ledger, group, expense);
  const includedIds = ids.filter((id) => form.included[id]);
  const isPercent = form.mode === 'percent';

  // The purchase's amounts. Without a second amount, the receipt amount is the debt.
  const chargedOptions = CURRENCIES.filter((code) => code !== form.currency);
  const chargedCurrency = chargedOptions.includes(form.chargedCurrency)
    ? form.chargedCurrency
    : chargedOptions[0];
  const receipt = { minor: parseAmount(form.amount, form.currency), currency: form.currency };
  const charged = form.charged
    ? { minor: parseAmount(form.chargedAmount, chargedCurrency), currency: chargedCurrency }
    : null;
  const debtIsCharged = charged && form.debtIn === 'charged';
  const debt = debtIsCharged ? charged : receipt;
  const other = charged && (debtIsCharged ? receipt : charged);
  const hasAmount = debt.minor != null && debt.minor > 0;

  let shares = {};
  if (hasAmount) {
    shares = isPercent
      ? splitByPercent(debt.minor, includedIds, form.percents)
      : splitEqual(debt.minor, includedIds);
  }

  const split = describeSplit(t, {
    amountMinor: debt.minor,
    currency: debt.currency,
    mode: form.mode,
    includedIds,
    percents: form.percents,
    chargedProblem: other ? amountProblem(t, other.minor, other.currency) : null,
  });
  const hasTitle = form.title.trim().length > 0;
  const canSave = split.ok && hasTitle && !saving;
  // A usual split names every current member of the group, so it cannot include someone who left.
  const canKeepUsual = isPercent && includedIds.every((id) => group.memberIds.includes(id));

  function submitLabel() {
    if (saving) return t('expenses:add.submit.saving');
    if (!split.ok) return split.submit;
    if (!hasTitle) return t('expenses:add.submit.needTitle');
    return expense ? t('expenses:add.submit.save') : t('expenses:add.submit.ready');
  }

  function update(patch) {
    setForm((current) => ({ ...current, ...patch }));
    setSavedNote(null);
  }

  function handleGroup(nextGroup) {
    if (nextGroup.id === form.groupId) return;
    setForm((current) => formForGroup(ledger, nextGroup, current));
    setSavedNote(null);
  }

  function handlePayer(event) {
    const nextPayer = event.target.value;
    update(
      form.currencyTouched
        ? { payerId: nextPayer }
        : { payerId: nextPayer, currency: memberById(ledger, nextPayer).currency },
    );
  }

  function handleMode(mode) {
    if (mode === form.mode) return;
    if (mode === 'equal') {
      update({ mode });
      return;
    }
    const everyone = includedIds.length === ids.length;
    update({
      mode,
      percents: group.usual && everyone ? { ...group.usual } : evenPercents(ids, includedIds),
    });
  }

  function handleToggle(id) {
    const included = { ...form.included, [id]: !form.included[id] };
    update({
      included,
      percents: included[id] ? form.percents : { ...form.percents, [id]: 0 },
    });
  }

  function handleStep(id, direction) {
    const current = form.percents[id] ?? 0;
    const next =
      direction < 0
        ? Math.max(0, Math.ceil(current / PERCENT_STEP) * PERCENT_STEP - PERCENT_STEP)
        : Math.min(100, Math.floor(current / PERCENT_STEP) * PERCENT_STEP + PERCENT_STEP);
    update({ percents: { ...form.percents, [id]: next } });
  }

  function requestBody() {
    const note = form.note.trim();
    const body = {
      title: form.title.trim(),
      kind: form.kind,
      groupId: form.groupId,
      payerId: form.payerId,
      amountMinor: debt.minor,
      currency: debt.currency,
      splitMode: form.mode,
      participantIds: includedIds,
    };
    if (isPercent) {
      body.percents = Object.fromEntries(includedIds.map((id) => [id, form.percents[id] ?? 0]));
    }
    if (other) {
      body.otherAmount = { amountMinor: other.minor, currency: other.currency };
      body.chargedCurrency = charged.currency;
    }
    if (note) body.note = note;
    if (canKeepUsual && form.saveUsual) {
      body.usualSplit = Object.fromEntries(
        group.memberIds.map((id) => [id, form.included[id] ? (form.percents[id] ?? 0) : 0]),
      );
    }
    if (expense) body.version = expense.version;
    else body.date = todayIso();
    return prepare(body);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErrorCode(null);
    try {
      await saveExpense(session, requestBody(), expense?.id);
      done();
      ledgerState.reload();
      if (expense) {
        nav.expense(expense.id);
        return;
      }
      setSavedNote(
        t('expenses:add.saved', {
          group: group.name,
          audience: audienceNote(t, ledger, includedIds),
        }),
      );
      setForm(blankForm(ledger));
      scrollToTop();
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
      if (error?.code === 'conflict' && expense) {
        onConflict();
        ledgerState.reload();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="fa-add">
      <SubHeader
        icon={X}
        backLabel={t('expenses:add.close')}
        onBack={expense ? () => nav.expense(expense.id) : nav.home}
        title={expense ? t('expenses:add.editTitle') : t('expenses:add.title')}
      />

      {savedNote && (
        <div className="fa-add__saved">
          <StatusNote>{savedNote}</StatusNote>
        </div>
      )}

      <form className="fa-add__form" onSubmit={handleSubmit}>
        <div className="fa-add__fields">
          <TextField
            label={t('expenses:add.what')}
            placeholder={t('expenses:add.whatPlaceholder')}
            maxLength={TITLE_MAX}
            value={form.title}
            onChange={(event) => update({ title: event.target.value })}
          />

          <div className="fa-add__group">
            <TextField
              label={t('expenses:add.howMuch')}
              prefix={currencyLabel(t, form.currency)}
              inputMode="decimal"
              placeholder={t('expenses:add.amountPlaceholder')}
              value={form.amount}
              onChange={(event) => update({ amount: event.target.value })}
            />
            <div className="fa-add__question">
              <p id={currencyId} className="fa-text-label">
                {t('expenses:add.currency')}
              </p>
              <Segmented
                labelledBy={currencyId}
                value={form.currency}
                onChange={(currency) => update({ currency, currencyTouched: true })}
                options={CURRENCIES.map((code) => ({
                  value: code,
                  label: currencyLabel(t, code),
                }))}
              />
              <p className="fa-text-caption fa-text-muted">
                {currencyHint(t, ledger, form.currency, receipt.minor)}
              </p>
            </div>
            <div className="fa-add__usual">
              <input
                id={chargedId}
                type="checkbox"
                className="fa-add__check"
                checked={form.charged}
                onChange={() => update({ charged: !form.charged })}
              />
              <label htmlFor={chargedId} className="fa-text-body">
                {t('expenses:add.chargedToggle')}
              </label>
            </div>
            {charged && (
              <>
                <TextField
                  label={t('expenses:add.chargedAmount')}
                  prefix={currencyLabel(t, chargedCurrency)}
                  inputMode="decimal"
                  placeholder={t('expenses:add.amountPlaceholder')}
                  value={form.chargedAmount}
                  onChange={(event) => update({ chargedAmount: event.target.value })}
                />
                <div className="fa-add__question">
                  <p id={chargedCurrencyId} className="fa-text-label">
                    {t('expenses:add.chargedCurrency')}
                  </p>
                  <Segmented
                    labelledBy={chargedCurrencyId}
                    value={chargedCurrency}
                    onChange={(code) => update({ chargedCurrency: code })}
                    options={chargedOptions.map((code) => ({
                      value: code,
                      label: currencyLabel(t, code),
                    }))}
                  />
                  {purchaseRateHint(t, receipt, charged) && (
                    <p className="fa-text-caption fa-text-muted">
                      {purchaseRateHint(t, receipt, charged)}
                    </p>
                  )}
                </div>
                <div className="fa-add__question">
                  <p id={debtId} className="fa-text-label">
                    {t('expenses:add.debtIn')}
                  </p>
                  <Segmented
                    labelledBy={debtId}
                    value={form.debtIn}
                    onChange={(debtIn) => update({ debtIn })}
                    options={[
                      {
                        value: 'charged',
                        label: t('expenses:add.debtCharged', {
                          currency: currencyLabel(t, chargedCurrency),
                        }),
                      },
                      {
                        value: 'receipt',
                        label: t('expenses:add.debtReceipt', {
                          currency: currencyLabel(t, form.currency),
                        }),
                      },
                    ]}
                  />
                  <p className="fa-text-caption fa-text-muted">
                    {debtIsCharged
                      ? t('expenses:add.debtChargedHint')
                      : t('expenses:add.debtReceiptHint')}
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="fa-add__question">
            <p id={kindId} className="fa-text-label">
              {t('expenses:add.kind')}
            </p>
            <div className="fa-add__chips" role="group" aria-labelledby={kindId}>
              {KINDS.map((kind) => (
                <Chip key={kind} pressed={form.kind === kind} onClick={() => update({ kind })}>
                  {kindLabel(t, kind)}
                </Chip>
              ))}
            </div>
          </div>

          <div className="fa-add__question">
            <p id={groupId} className="fa-text-label">
              {t('expenses:add.group')}
            </p>
            <div className="fa-add__chips" role="group" aria-labelledby={groupId}>
              {ledger.groups.map((option) => (
                <Chip
                  key={option.id}
                  pressed={option.id === form.groupId}
                  onClick={() => handleGroup(option)}
                >
                  {option.name}
                </Chip>
              ))}
            </div>
            <p className="fa-text-caption fa-text-muted">
              {group.usual
                ? t('expenses:add.groupUsual', { split: usualSplitLabel(t, ledger, group) })
                : t('expenses:add.groupEqual', { people: ids.length })}
            </p>
          </div>

          <div className="fa-add__question">
            <label htmlFor={payerId} className="fa-text-label">
              {t('expenses:add.payer')}
            </label>
            <select
              id={payerId}
              className="fa-add__select"
              value={form.payerId}
              onChange={handlePayer}
            >
              {ids.map((id) => (
                <option key={id} value={id}>
                  {memberLabel(t, ledger, id)}
                </option>
              ))}
            </select>
          </div>

          <div className="fa-add__question">
            <p id={splitId} className="fa-text-label">
              {t('expenses:add.split')}
            </p>
            <Segmented
              labelledBy={splitId}
              value={form.mode}
              onChange={handleMode}
              options={[
                { value: 'equal', label: t('expenses:add.modeEqual') },
                { value: 'percent', label: t('expenses:add.modePercent') },
              ]}
            />
            <p className="fa-text-caption fa-text-muted">
              {isPercent ? t('expenses:add.modePercentHint') : t('expenses:add.modeEqualHint')}
            </p>
          </div>

          <div className="fa-add__question">
            <div className="fa-add__participants-head">
              <p id={participantsId} className="fa-text-label">
                {t('expenses:add.participants')}
              </p>
              {isPercent && (
                <Button
                  variant="quiet"
                  size="small"
                  onClick={() => update({ percents: evenPercents(ids, includedIds) })}
                >
                  {t('expenses:add.evenOut')}
                </Button>
              )}
            </div>
            <Card flush>
              <ul className="fa-add__participants" aria-labelledby={participantsId}>
                {ids.map((id) => {
                  const person = memberById(ledger, id);
                  const included = Boolean(form.included[id]);
                  const label = memberLabel(t, ledger, id);
                  const object = id === ledger.me ? t('expenses:you.object') : person.name;
                  const subtitle = participantSubtitle(t, ledger, {
                    id,
                    included,
                    form,
                    share: shares[id],
                    hasAmount,
                    debt,
                  });
                  return (
                    <li key={id} className="fa-add__participant">
                      <input
                        id={`${participantsId}-${id}`}
                        type="checkbox"
                        className="fa-add__check"
                        checked={included}
                        onChange={() => handleToggle(id)}
                      />
                      <label htmlFor={`${participantsId}-${id}`} className="fa-add__person">
                        <Avatar name={person.name} tone={person.tone} size="small" />
                        <span className="fa-add__person-text">
                          <span className="fa-add__person-name fa-text-body-strong">{label}</span>
                          {subtitle && (
                            <span className="fa-text-caption fa-text-muted">{subtitle}</span>
                          )}
                        </span>
                      </label>
                      {included && !isPercent && hasAmount && (
                        <span className="fa-add__share">
                          {formatMinor(shares[id], debt.currency)}
                        </span>
                      )}
                      {included && isPercent && (
                        <div className="fa-add__stepper">
                          <Button
                            variant="secondary"
                            iconOnly
                            icon={Minus}
                            aria-label={t('expenses:add.less', { name: object })}
                            onClick={() => handleStep(id, -1)}
                          />
                          <span className="fa-add__percent fa-text-label" aria-live="polite">
                            {percentLabel(t, form.percents[id] ?? 0)}
                          </span>
                          <Button
                            variant="secondary"
                            iconOnly
                            icon={Plus}
                            aria-label={t('expenses:add.more', { name: object })}
                            onClick={() => handleStep(id, 1)}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          <StatusNote tone={split.ok ? 'success' : 'warning'} strong={!split.ok}>
            {split.note}
          </StatusNote>

          {canKeepUsual && (
            <div className="fa-add__usual">
              <input
                id={usualId}
                type="checkbox"
                className="fa-add__check"
                checked={form.saveUsual}
                onChange={() => update({ saveUsual: !form.saveUsual })}
              />
              <label htmlFor={usualId} className="fa-text-body">
                {t('expenses:add.saveUsual', { group: group.name })}
              </label>
            </div>
          )}

          <TextField
            label={t('expenses:add.note')}
            placeholder={t('expenses:add.notePlaceholder')}
            maxLength={NOTE_MAX}
            value={form.note}
            onChange={(event) => update({ note: event.target.value })}
          />

          {errorCode && (
            <p className="fa-text-body" role="alert">
              {errorCode === 'conflict' && expense
                ? t('expenses:add.conflict')
                : errorMessage(errorCode)}
            </p>
          )}
        </div>

        <div className="fa-add__submit">
          <Button type="submit" size="large" block disabled={!canSave}>
            {submitLabel()}
          </Button>
        </div>
      </form>
    </main>
  );
}
