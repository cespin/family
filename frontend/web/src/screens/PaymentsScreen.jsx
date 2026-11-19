import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { TransactionDateField } from '../components/expenses/TransactionDateField.jsx';
import { Button, Card, EmptyState, PersonRow, StatusNote } from '../components/ui';
import { usePayments } from '../hooks/usePayments.js';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { formatCalendarDate, formatMinor } from '../i18n/format.js';
import { updatePayment } from '../lib/expenses.js';
import { isTransactionDate, memberById, transactionDateOf } from '../lib/ledger.js';
import './PaymentsScreen.css';

const SHORT_DATE = { day: 'numeric', month: 'short', year: 'numeric' };

function paymentTitle(t, ledger, payment) {
  const amount = formatMinor(payment.paid.amountMinor, payment.paid.currency);
  if (payment.fromId === ledger.me) {
    return t('expenses:payments.youGave', {
      amount,
      name: memberById(ledger, payment.toId).name,
    });
  }
  return t('expenses:payments.gaveYou', {
    amount,
    name: memberById(ledger, payment.fromId).name,
  });
}

function methodLabel(t, method) {
  if (method === 'cash') return t('expenses:settle.methods.cash');
  if (method === 'other') return t('expenses:settle.methods.other');
  return t('expenses:settle.methods.transfer');
}

/** Changes the day one payment's money was given. Nothing else about a payment can change. */
function DateEditor({ ledger, payment, onSaved, onCancel, onConflict }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const [transactionDate, setTransactionDate] = useState(transactionDateOf(payment));
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const hasDate = isTransactionDate(transactionDate);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!hasDate || saving) return;
    setSaving(true);
    setErrorCode(null);
    try {
      const saved = await updatePayment(
        session,
        payment.id,
        prepare({ transactionDate, version: payment.version }),
      );
      done();
      onSaved(saved);
    } catch (error) {
      setSaving(false);
      if (error?.code === 'conflict') onConflict();
      else setErrorCode(error?.code ?? 'generic');
    }
  }

  return (
    <Card>
      <form className="fa-payments__editor" onSubmit={handleSubmit}>
        <p className="fa-text-body-strong">{paymentTitle(t, ledger, payment)}</p>
        <TransactionDateField value={transactionDate} onChange={setTransactionDate} />
        {errorCode && (
          <p className="fa-text-body" role="alert">
            {errorMessage(errorCode)}
          </p>
        )}
        <div className="fa-payments__actions">
          <Button variant="secondary" onClick={onCancel}>
            {t('expenses:payments.cancel')}
          </Button>
          <Button type="submit" disabled={!hasDate || saving}>
            {hasDate ? t('expenses:payments.save') : t('expenses:when.submitNeedDate')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The caller's payments and advances, where the day each one was given can be corrected. */
export function PaymentsScreen({ ledger, nav }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const page = usePayments(version);
  const [editing, setEditing] = useState(null);
  const [note, setNote] = useState(null);

  function handleSaved(saved) {
    setEditing(null);
    setNote({
      tone: 'success',
      text: t('expenses:payments.saved', {
        title: paymentTitle(t, ledger, saved),
        date: formatCalendarDate(transactionDateOf(saved), SHORT_DATE),
      }),
    });
    setVersion((current) => current + 1);
  }

  function handleConflict() {
    setEditing(null);
    setNote({ tone: 'warning', text: t('expenses:payments.conflict') });
    setVersion((current) => current + 1);
  }

  function handleOpen(payment) {
    setNote(null);
    setEditing(payment);
  }

  return (
    <main>
      <SubHeader backLabel={t('expenses:payments.back')} onBack={nav.home} />
      <div className="fa-screen">
        <div className="fa-screen__intro">
          <h1 className="fa-text-title">{t('expenses:payments.title')}</h1>
          <p className="fa-text-body fa-text-muted">{t('expenses:payments.intro')}</p>
        </div>

        {note && <StatusNote tone={note.tone}>{note.text}</StatusNote>}

        {editing && (
          <DateEditor
            key={editing.id}
            ledger={ledger}
            payment={editing}
            onSaved={handleSaved}
            onCancel={() => setEditing(null)}
            onConflict={handleConflict}
          />
        )}

        {page.status === 'loading' && (
          <p className="fa-text-body fa-text-muted" role="status">
            {t('common:status.loading')}
          </p>
        )}
        {page.status === 'failed' && (
          <Card>
            <div className="fa-payments__failed" role="alert">
              <p className="fa-text-body">{errorMessage(page.errorCode)}</p>
              <Button variant="secondary" onClick={page.retry}>
                {t('common:actions.retry')}
              </Button>
            </div>
          </Card>
        )}
        {page.status === 'ready' && page.payments.length === 0 && (
          <Card>
            <EmptyState title={t('expenses:payments.emptyTitle')}>
              {t('expenses:payments.emptyBody')}
            </EmptyState>
          </Card>
        )}
        {page.status === 'ready' && page.payments.length > 0 && (
          <Card flush>
            <ul className="fa-person-list">
              {page.payments.map((payment) => {
                const otherId = payment.fromId === ledger.me ? payment.toId : payment.fromId;
                return (
                  <PersonRow
                    key={payment.id}
                    person={memberById(ledger, otherId)}
                    density="link"
                    title={paymentTitle(t, ledger, payment)}
                    subtitle={t('expenses:payments.meta', {
                      date: formatCalendarDate(transactionDateOf(payment), SHORT_DATE),
                      method: methodLabel(t, payment.method),
                    })}
                    onClick={() => handleOpen(payment)}
                  />
                );
              })}
            </ul>
          </Card>
        )}
        {page.moreErrorCode && (
          <p className="fa-text-body" role="alert">
            {errorMessage(page.moreErrorCode)}
          </p>
        )}
        {page.status === 'ready' && page.nextCursor && (
          <Button variant="secondary" block disabled={page.loadingMore} onClick={page.loadMore}>
            {page.loadingMore ? t('expenses:home.loadingMore') : t('expenses:payments.loadMore')}
          </Button>
        )}
      </div>
    </main>
  );
}
