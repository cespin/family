---
name: react-patterns
description: React 19 patterns for the family dashboard SPA in plain JSX, covering hooks discipline, state location, data fetching with apiFetch, forms, composition, performance and accessibility. Use when writing or reviewing .jsx components, screens or custom hooks in frontend/web.
metadata:
  origin: ECC
---

# React Patterns

Idiomatic React 19 patterns for this client-rendered Vite app. Paths are relative to `frontend/web/`.

The always-on rules live in `.claude/rules/`: `hooks.md`, `patterns.md`, `coding-style.md`, `i18n.md`, `security.md` and `testing.md`. This skill adds the reasoning and recipes.

## When to Activate

- Writing or modifying React function components, custom hooks, or component trees
- Reviewing JSX files
- Designing state shape or component composition
- Choosing between local state, lifted state and context
- Implementing a form
- Wiring a screen to the API

## Core Principles

### 1. Render is a Pure Function of Props and State

```jsx
// Good: derive during render
function ItemTotal({ items }) {
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  return <span>{formatNumber(total)}</span>;
}

// Bad: derived state stored separately
function ItemTotal({ items }) {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    setTotal(items.reduce((sum, item) => sum + item.quantity, 0));
  }, [items]);
  return <span>{formatNumber(total)}</span>;
}
```

Derived state in `useEffect` adds a render cycle, can desync, and obscures the data flow.

### 2. Side Effects Outside Render

Effects, mutations, network calls, and subscriptions live in event handlers or `useEffect`, never in the render body.

### 3. Composition Over Inheritance

React has no inheritance model for components. Compose with `children` or component props, as `CenteredPanel` in `src/components/ui/CenteredPanel.jsx` does with `icon`, `title`, `body` and `children`.

## Hooks Discipline

See `.claude/rules/hooks.md` for the full ruleset. Highlights:

- Top-level only, never conditional
- Clean up every subscription, interval and listener
- Functional updater (`setCount((prev) => prev + 1)`) when new state depends on old
- Default position: do not memoize. Add `useMemo` or `useCallback` only when a hook dependency or a measurement proves it matters
- Extract a custom hook only when the same hook sequence appears in 2+ components

## State Location Decision Tree

```
Used by one component?
  -> useState inside it

Used by parent + a few descendants?
  -> lift to nearest common ancestor

Used across distant branches AND low-frequency reads (session)?
  -> React Context

Derived from the server?
  -> a narrow custom hook over apiFetch
```

Most screens do not need context. Resist abstraction until duplicated lifting becomes painful.

## Error Boundaries

```jsx
<ErrorBoundary fallback={<ModuleFailed />}>
  <ModulePanel />
</ErrorBoundary>
```

- The app has no error boundary yet. React only offers this as a class API, so the first one is the one justified class component
- A boundary catches errors thrown during render, lifecycle, and constructors of its children, NOT in event handlers or async code
- Give each dashboard module its own boundary, so one failing module does not blank the page
- Fallback text comes from the catalogs like any other copy

## Suspense

No screen uses `lazy()` or `Suspense` today, and i18next runs with `useSuspense: false`. If a heavy module justifies `lazy()`, place the boundary close to that module and read the stale-chunk note in the `vite-patterns` skill.

## Forms

`src/screens/AddExpenseScreen.jsx` is the reference form. `Button` in `src/components/ui/Button.jsx` defaults to `type="button"`, so a submit button must pass `type="submit"`.

### Controlled inputs (the default)

Use controlled inputs when the value drives other UI, formats on every keystroke, or implements real-time validation.

```jsx
function RenameForm({ initialName, onSave }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);

  function handleSubmit(event) {
    event.preventDefault();
    onSave(name);
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="rename-name">{t('common:fields.name')}</label>
      <input id="rename-name" value={name} onChange={(event) => setName(event.target.value)} />
      <Button type="submit">{t('common:actions.save')}</Button>
    </form>
  );
}
```

The catalog keys above are illustrative. Add real ones to the catalog before using them.

### React 19 form actions

`useActionState` also works in a client-only app, where the action is an ordinary async function. It suits a form whose main concern is the pending and error state of one submit.

```jsx
function InviteForm({ getToken }) {
  const { t } = useTranslation();
  const [state, formAction, pending] = useActionState(async (_previous, formData) => {
    try {
      await apiFetch('/things', {
        method: 'POST',
        token: getToken(),
        body: { name: formData.get('name') },
      });
      return { errorCode: null };
    } catch (error) {
      return { errorCode: error.code };
    }
  }, { errorCode: null });

  return (
    <form action={formAction}>
      <input name="name" aria-label={t('common:fields.name')} required />
      <Button type="submit" disabled={pending}>{t('common:actions.save')}</Button>
      {state.errorCode && <p role="alert">{errorMessage(state.errorCode)}</p>}
    </form>
  );
}
```

## Data Fetching

The app has no data-fetching library. Every call goes through `apiFetch` in `src/lib/api.js`, which prefixes `/api` and throws `ApiError` with the backend's `code`.

| Need | Tool |
|---|---|
| Data a screen reads on mount | A narrow custom hook over `apiFetch` |
| A write from a user action | `apiFetch` in the event handler |
| The signed-in member and their token | `useSession` |

Reads must guard against a slow response landing after a newer one. `apiFetch` does not accept an abort signal, so use an ignore flag:

```jsx
function useThing(id) {
  const { getToken } = useSession();
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let ignore = false;
    apiFetch(`/things/${id}`, { token: getToken() })
      .then((thing) => { if (!ignore) setState({ status: 'ready', thing }); })
      .catch((error) => { if (!ignore) setState({ status: 'failed', errorCode: error.code }); });
    return () => { ignore = true; };
  }, [id, getToken]);

  return state;
}
```

`getToken` is stable, so a session renewal does not re-run the effect. To reload after a save, pass a version number the effect depends on, as `useLedger` in `src/hooks/useLedger.js` does. For the expenses API, call the functions in `src/lib/expenses.js` with the session instead of `apiFetch`: they renew an expired token once on a 401.

Keep `loading`, `failed` and empty as distinct states. A failed read must never render as an empty list or a zero. See "Absent is not zero" in `.claude/rules/patterns.md`.

## Composition Recipes

### Slot via `children`

```jsx
<CenteredPanel icon={House} title={t('auth:signIn.title')}>
  <Button icon={LogIn} onClick={signIn}>{t('auth:signIn.button')}</Button>
</CenteredPanel>
```

### Named slots

```jsx
<Page header={<Nav />} sidebar={<Filters />}>
  <Results />
</Page>
```

### Compound components (shared state via Context)

```jsx
<Tabs defaultValue="summary">
  <Tabs.List>
    <Tabs.Trigger value="summary">{t('dashboard:tabs.summary')}</Tabs.Trigger>
    <Tabs.Trigger value="history">{t('dashboard:tabs.history')}</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Panel value="summary"><Summary /></Tabs.Panel>
  <Tabs.Panel value="history"><History /></Tabs.Panel>
</Tabs>
```

### Lookup table instead of a branch chain

`src/App.jsx` maps each session status to a screen with a plain object. Use the same shape for any closed set of states.

## Performance

### When `React.memo` Actually Helps

Wrap a component in `React.memo` only when:

1. It re-renders frequently
2. Its props are usually the same between renders
3. Its render is measurably expensive

`React.memo` adds an equality check on every render. If props differ on most renders, the check is pure overhead.

### Avoiding Render Cascades

- Keep state as close as possible to where it is used
- Split context: one context per concern, so a frequent change does not re-render unrelated consumers
- Use `useSyncExternalStore` when subscribing to a store outside React

### Lists

- Provide stable `key` props (a record id, not the array index)
- Measure before adding virtualization to a long list

## Accessibility-First Composition

- Always render semantic HTML (`<button>`, `<a>`, `<nav>`, `<main>`) before reaching for `role` attributes
- Every interactive element must be reachable by keyboard
- Form inputs need labels: `<label htmlFor>`, or a translated `aria-label` if visually labeled by an icon
- Decorative icons get `aria-hidden="true"`, as `Button` and `CenteredPanel` set on the icons they render
- Move focus deliberately when a dialog opens and closes
- Accessible names are user-visible text, so they come from the catalogs too

## Routing

There is no router. `src/App.jsx` renders one screen from `useSession().status`, and `src/hooks/SessionProvider.jsx` handles the one special path, `/auth/callback`. Adding a router is a deliberate project decision, not a detail of a feature.

## Out of Scope

- **TypeScript**: the app is plain JSX by choice
- **Server rendering of any kind**: this is a static SPA behind CloudFront
- **New state or data libraries**: adding one is a project decision

## Examples

### Custom hook for a debounced value

```jsx
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
```

### Optimistic UI with React 19 `useOptimistic`

```jsx
function NoteList({ notes, onAdd }) {
  const { t } = useTranslation();
  const [optimistic, addOptimistic] = useOptimistic(
    notes,
    (current, note) => [...current, note],
  );

  async function send(formData) {
    const text = String(formData.get('text'));
    addOptimistic({ id: 'pending', text });
    await onAdd(text);
  }

  return (
    <>
      <ul>{optimistic.map((note) => <li key={note.id}>{note.text}</li>)}</ul>
      <form action={send}>
        <input name="text" aria-label={t('common:fields.note')} />
        <Button type="submit">{t('common:actions.save')}</Button>
      </form>
    </>
  );
}
```

### Splitting context to avoid render cascades

```jsx
// Two contexts: one rarely changes, one frequently
const SessionContext = createContext(null);
const NotificationsContext = createContext([]);

// A component that only consumes SessionContext does NOT re-render when notifications change
```
