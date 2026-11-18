---
paths:
  - "**/*.test.jsx"
  - "**/*.test.js"
---
# Testing — frontend/web

**Vitest** + **React Testing Library**, run with `npm run test` or `npm run test:watch` on the Node version in `../../.nvmrc`. There is no Jest, Playwright, MSW or `jest-dom`.

Config lives in the `test` block of `vite.config.js`. Globals are **off**, so every test file imports what it uses (`import { describe, expect, it, vi } from 'vitest'`), and `src/test/setup.js` registers `cleanup` by hand.

Without `jest-dom`, assert with plain matchers: `expect(screen.getByRole('button', { name })).toBeTruthy()`.

## No network mocking library: stub the module

Mock the module the code under test imports. Keep the real module's other exports with `importOriginal`, as `src/lib/auth.test.js` does:

```js
vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}));
```

Only stub calls that reach the network. Keeping `ApiError` real means `instanceof` checks still work.

Screens get their session the same way, as in `src/screens/screens.test.jsx`:

```jsx
vi.mock('../hooks/useSession.js', () => ({ useSession: vi.fn() }));

vi.mocked(useSession).mockReturnValue({
  status: 'signedIn',
  member: { name: 'Test Member' },
  signOut: vi.fn(),
});
```

Reset mocks in `beforeEach` with `vi.mocked(fn).mockReset()`, then set what each test needs.

## Query priority

Use `getByRole` first, then `getByLabelText`, then `getByText` for non-interactive content. `data-testid` is a last resort.

**Name elements through the catalog, never with literal copy.** A copy edit should not break a test, and the suite also runs under a throwaway locale.

```jsx
await userEvent.click(screen.getByRole('button', { name: i18n.t('common:actions.signOut') }));
expect(screen.getByRole('heading', { name: i18n.t('auth:notInvited.title') })).toBeTruthy();
```

Prefer `userEvent` over `fireEvent`, and always `await` it. Use `findBy*` for content that appears after a mocked call resolves, and `waitFor` for side effects such as a spy having been called.

## Catalog guarantees

`src/i18n/i18n.test.js` scans the source for `t()` keys, compares every locale's keys, and checks that each backend error code is translated. `src/screens/screens.test.jsx` renders every entry of `STATES` under a throwaway locale and fails on any text that did not come from the catalog. A new session status needs an entry in `STATES`.

## Tests exist to catch a wrong-but-plausible value

Aim tests at failures that render as a believable result rather than a crash. For a family dashboard, the cases that matter look like this:

- **A missing balance is not a zero balance.** A shared account whose balance failed to load must render as absent, never as a formatted zero.
- **A failed load is not an empty list.** A 500 while reading the shopping list must show the error state, not "nothing here yet".
- **Each error code gets its own message.** A 403 for a removed family member must not read as a dropped connection, and a network failure (`ApiError` with status `0` and code `generic`) must not read as "not found".
- **The right member's data is on screen.** When a selection changes, a slow response for the previous member must not replace the newer one.
- **Amounts keep their currency.** Two amounts in different currencies must never be added into one total.

Write the test for the wrong-looking-right failure first, then the happy path.

## Anti-patterns

- `container.querySelector` as a first resort. It bypasses accessible queries.
- Asserting on render counts or internal hook state.
- Mocking a component's own internals instead of the module boundary it calls through.
- A `setTimeout` plus an assertion instead of `findBy*` or `waitFor`. It is flaky by construction.
- Asserting on literal Spanish copy instead of `i18n.t('namespace:key')`.

## Coverage philosophy

There is no numeric coverage target. Extend the suite to catch behaviour that would pass code review as "looks right", rather than chasing a percentage.
