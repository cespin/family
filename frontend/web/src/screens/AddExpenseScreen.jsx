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
import { errorMessage } from '../i18n/errors.js';
import { formatAmountInput, formatMinor } from '../i18n/format.js';
import { saveExpense } from '../lib/expenses.js';
import { currenciesOf, expenseById, groupById, memberById, todayIso } from '../lib/ledger.js';
import {
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

function formForGroup(ledger, group, base) {
  const keepsPayer = group.memberIds.includes(base.payerId);
  const fallbackPayer = group.memberIds.includes(ledger.me) ? ledger.me : group.memberIds[0];
  const payerId = keepsPayer ? base.payerId : fallbackPayer;
  return {
    ...base,
    groupId: group.id,
    payerId,
    currency:
      keepsPayer || base.currencyTouched ? base.currency : memberById(ledger, payerId).currency,
    included: Object.fromEntries(group.memberIds.map((id) => [id, true])),
    mode: group.usual ? 'percent' : 'equal',
    percents: group.usual ? { ...group.usual } : evenPercents(group.memberIds, group.memberIds),
  };
}

function blankForm(ledger) {
  return formForGroup(ledger, ledger.groups[0], {
    title: '',
    amount: '',
    currency: memberById(ledger, ledger.me).currency,
    currencyTouched: false,
    kind: 'meal',
    payerId: ledger.me,
    saveUsual: true,
  });
}

function formFromExpense(ledger, expense) {
  const { memberIds } = groupById(ledger, expense.groupId);
  const includedIds = memberIds.filter((id) => expense.shares[id] != null);
  return {
    title: expense.title,
    amount: formatAmountInput(expense.amountMinor, expense.currency),
    currency: expense.currency,
    currencyTouched: true,
    kind: expense.kind,
    payerId: expense.payerId,
    saveUsual: false,
    groupId: expense.groupId,
    included: Object.fromEntries(memberIds.map((id) => [id, includedIds.includes(id)])),
    mode: expense.splitMode,
    percents: expense.percents ? { ...expense.percents } : evenPercents(memberIds, includedIds),
  };
}

/** Whether the split can be saved, and what to tell the person about it. */
function describeSplit(t, { amountMinor, currency, mode, includedIds, percents }) {
  if (amountMinor == null || amountMinor <= 0) {
    return {
      ok: false,
      note: t('expenses:add.status.needAmount'),
      submit: t('expenses:add.submit.needAmount'),
    };
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
  const myCurrency = memberById(ledger, ledger.me).currency;
  if (currency === myCurrency) return t('expenses:add.currencyHome');
  const quote = quoteBetween(currency, myCurrency, ledger.rates);
  if (!quote) return t('expenses:add.currencyNoRate');
  const rate = quoteLabel(t, quote);
  if (amountMinor == null || amountMinor <= 0) return t('expenses:add.currencyRate', { rate });
  const amount = formatMinor(convertMinor(amountMinor, currency, myCurrency, ledger.rates), myCurrency);
  return t('expenses:add.currencyConverted', { amount, rate });
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

function participantSubtitle(t, ledger, { id, included, form, share, hasAmount, amountMinor }) {
  if (!included) return t('expenses:add.notParticipating');
  if (form.mode === 'percent') return hasAmount ? formatMinor(share, form.currency) : null;
  if (id === form.payerId) {
    return hasAmount
      ? t('expenses:add.paid', { amount: formatMinor(amountMinor, form.currency) })
      : null;
  }
  const home = memberById(ledger, id).currency;
  if (!hasAmount || home === form.currency) return null;
  const converted = convertMinor(share, form.currency, home, ledger.rates);
  return converted == null
    ? null
    : t('expenses:approx', { amount: formatMinor(converted, home) });
}

export function AddExpenseScreen({ ledger, ledgerState, view, nav }) {
  const { t } = useTranslation();
  const currencyId = useId();
  const kindId = useId();
  const groupId = useId();
  const payerId = useId();
  const splitId = useId();
  const participantsId = useId();
  const usualId = useId();

  const expense = view.expenseId ? expenseById(ledger, view.expenseId) : null;
  const [form, setForm] = useState(() =>
    expense ? formFromExpense(ledger, expense) : blankForm(ledger),
  );
  const [savedNote, setSavedNote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const group = groupById(ledger, form.groupId);
  const ids = group.memberIds;
  const includedIds = ids.filter((id) => form.included[id]);
  const isPercent = form.mode === 'percent';
  const amountMinor = parseAmount(form.amount, form.currency);
  const hasAmount = amountMinor != null && amountMinor > 0;

  let shares = {};
  if (hasAmount) {
    shares = isPercent
      ? splitByPercent(amountMinor, includedIds, form.percents)
      : splitEqual(amountMinor, includedIds);
  }

  const split = describeSplit(t, {
    amountMinor,
    currency: form.currency,
    mode: form.mode,
    includedIds,
    percents: form.percents,
  });
  const hasTitle = form.title.trim().length > 0;
  const canSave = split.ok && hasTitle && !saving;

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

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErrorCode(null);
    try {
      await saveExpense({
        id: expense?.id,
        title: form.title.trim(),
        kind: form.kind,
        groupId: form.groupId,
        payerId: form.payerId,
        amountMinor,
        currency: form.currency,
        date: expense?.date ?? todayIso(),
        splitMode: form.mode,
        percents: isPercent
          ? Object.fromEntries(includedIds.map((id) => [id, form.percents[id]]))
          : undefined,
        shares,
        saveUsual: isPercent && form.saveUsual,
      });
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
                options={currenciesOf(ledger).map((code) => ({
                  value: code,
                  label: currencyLabel(t, code),
                }))}
              />
              <p className="fa-text-caption fa-text-muted">
                {currencyHint(t, ledger, form.currency, amountMinor)}
              </p>
            </div>
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
                    amountMinor,
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
                          {formatMinor(shares[id], form.currency)}
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

          {isPercent && (
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

          {errorCode && (
            <p className="fa-text-body" role="alert">
              {errorMessage(errorCode)}
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
