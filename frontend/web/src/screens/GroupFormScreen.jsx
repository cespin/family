import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currencyLabel, memberLabel } from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { Avatar, Button, Card, StatusNote, TextField } from '../components/ui';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { saveGroup } from '../lib/expenses.js';
import { groupById, memberById } from '../lib/ledger.js';
import './GroupFormScreen.css';

const NAME_MAX = 40;
const MIN_MEMBERS = 2;

/**
 * Who can be in the group, in a stable order: its current members first, in the group's order,
 * then every other active member. Someone who lost access can stay but cannot be added.
 */
function candidatesFor(ledger, group) {
  const current = group ? group.memberIds : [ledger.me];
  const others = ledger.members
    .filter((member) => member.active && !current.includes(member.id))
    .map((member) => member.id);
  return [...current, ...others];
}

/** Creates a group, or renames one and changes its members. Only its creator can change it. */
export function GroupFormScreen({ ledger, ledgerState, view, nav }) {
  const { t } = useTranslation();
  const group = view.groupId ? groupById(ledger, view.groupId) : null;

  if (view.groupId && !group) {
    return (
      <main>
        <SubHeader icon={X} backLabel={t('expenses:groupForm.close')} onBack={nav.groups} />
        <div className="fa-screen">
          <p className="fa-text-body" role="alert">
            {errorMessage('not_found')}
          </p>
        </div>
      </main>
    );
  }
  return <GroupForm ledger={ledger} ledgerState={ledgerState} group={group} nav={nav} />;
}

function GroupForm({ ledger, ledgerState, group, nav }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const membersId = useId();
  const [name, setName] = useState(group?.name ?? '');
  const [selected, setSelected] = useState(() => new Set(group?.memberIds ?? [ledger.me]));
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const candidates = candidatesFor(ledger, group);
  const memberIds = candidates.filter((id) => selected.has(id));
  const locked = new Set([ledger.me, group?.createdBy].filter(Boolean));
  const trimmed = name.trim();
  const removesSomeone = group?.memberIds.some((id) => !selected.has(id)) ?? false;
  const enoughPeople = memberIds.length >= MIN_MEMBERS;
  const canSave = trimmed.length > 0 && enoughPeople && !saving;

  function submitLabel() {
    if (saving) return t('expenses:groupForm.saving');
    if (trimmed.length === 0) return t('expenses:groupForm.needName');
    if (!enoughPeople) return t('expenses:groupForm.needPeople');
    return group ? t('expenses:groupForm.save') : t('expenses:groupForm.create');
  }

  function handleToggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErrorCode(null);
    const body = { name: trimmed, memberIds };
    if (group) body.version = group.version;
    try {
      await saveGroup(session, prepare(body), group?.id);
      done();
      ledgerState.reload();
      nav.groups();
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
      setSaving(false);
      // Someone else changed the group first. Reloading the ledger brings its new `version`, which
      // the next save sends, and the form keeps what the person typed.
      if (error?.code === 'conflict' && group) ledgerState.reload();
    }
  }

  return (
    <main className="fa-group-form">
      <SubHeader
        icon={X}
        backLabel={t('expenses:groupForm.close')}
        onBack={nav.groups}
        title={group ? t('expenses:groupForm.editTitle') : t('expenses:groupForm.newTitle')}
      />
      <form className="fa-group-form__fields" onSubmit={handleSubmit}>
        <TextField
          label={t('expenses:groupForm.name')}
          placeholder={t('expenses:groupForm.namePlaceholder')}
          maxLength={NAME_MAX}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <div className="fa-group-form__question">
          <p id={membersId} className="fa-text-label">
            {t('expenses:groupForm.members')}
          </p>
          <Card flush>
            <ul className="fa-group-form__members" aria-labelledby={membersId}>
              {candidates.map((id) => {
                const person = memberById(ledger, id);
                const checkId = `${membersId}-${id}`;
                return (
                  <li key={id} className="fa-group-form__member">
                    <input
                      id={checkId}
                      type="checkbox"
                      className="fa-group-form__check"
                      checked={selected.has(id)}
                      disabled={locked.has(id)}
                      onChange={() => handleToggle(id)}
                    />
                    <label htmlFor={checkId} className="fa-group-form__person">
                      <Avatar name={person.name} tone={person.tone} size="small" />
                      <span className="fa-group-form__person-text">
                        <span className="fa-text-body-strong">{memberLabel(t, ledger, id)}</span>
                        <span className="fa-text-caption fa-text-muted">
                          {id === group?.createdBy
                            ? t('expenses:groupForm.creator', {
                                currency: currencyLabel(t, person.currency),
                              })
                            : currencyLabel(t, person.currency)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Card>
          <p className="fa-text-caption fa-text-muted">
            {group ? t('expenses:groupForm.membersEditHint') : t('expenses:groupForm.membersHint')}
          </p>
        </div>

        {removesSomeone && (
          <StatusNote tone="warning">
            {group.usual
              ? t('expenses:groupForm.removingUsual')
              : t('expenses:groupForm.removing')}
          </StatusNote>
        )}

        {errorCode && (
          <p className="fa-text-body" role="alert">
            {errorCode === 'conflict' && group
              ? t('expenses:groupForm.conflict')
              : errorMessage(errorCode)}
          </p>
        )}

        <Button type="submit" size="large" block disabled={!canSave}>
          {submitLabel()}
        </Button>
      </form>
    </main>
  );
}
